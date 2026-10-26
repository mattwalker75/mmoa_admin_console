// helpers/webAppAccess.js — unified transport to the Web App.
//
// The admin console may run alongside the mmoa_web_app install (local), on
// a different box reachable over SSH, or against an EC2 instance reachable
// only via AWS SSM. This module hides those differences behind one accessor
// interface so callers can run commands, read files, and write files without
// caring where the web app lives.
//
// Modes (appConfig.webApp.mode):
//   local — same host: current OS user + local fs/commands.
//   ssh   — remote host over SSH/SFTP using a pasted private key (ssh2).
//   ec2   — remote EC2 instance driven via AWS SSM Run Command (awsSsm).
//
// Accessor interface (all async unless noted):
//   runCommand(command, opts) -> { code, stdout, stderr, timedOut[, truncated] }
//                                (truncated: EC2 only — stdout hit SSM's cap)
//   readFile(remotePath, opts) -> Buffer (default) or string (opts.encoding)
//   readFileChunked(remotePath, opts) -> same, any size (EC2: pieces over SSM)
//   writeFile(remotePath, content)
//   writeFileChunked(remotePath, buffer) -> { bytes, chunks }
//   exists(remotePath) -> boolean
//   readBundle(spec, opts) -> batched fetch, see below
//   test() -> { ok, message, details }
//   describe() -> short human string (sync)
//
// readBundle({ files: [path…], dirs: [path…] }) fetches many things in as
// few transport round-trips as the mode allows — ONE SSM command on EC2,
// one SSH connection on SSH — and returns
//   { files: { [path]: { content: Buffer|null, missing: bool, err: string|null } },
//     dirs:  { [path]: { names: string[], err: string|null } } }
// A missing file is NOT an error (missing:true, content:null); dirs that
// can't be listed come back as empty name lists. Callers use it for pages
// that would otherwise issue a dozen sequential remote reads.
//
// Every writeFile is atomic in all three modes (temp file + rename/mv), so an
// interrupted save can never leave the web app's config.json or a website
// fragment truncated.
//
// writeFileChunked is the transport for BINARY uploads of any size (event
// flyers, prize photos, board photos, bundle restores of uploads/**). It also
// creates the target directory (mkdir -p) and is atomic the same way:
//   local — mkdir + temp file + rename.
//   ssh   — mkdir -p, SFTP-write a temp file, `mv -f` into place.
//   ec2   — SSM Run Command can't carry a large payload, so the file is sent
//           as base64 pieces, each its own SSM command of at most ~40 KB
//           (after the runAsUser wrap), appended to a temp file; a final
//           command checks the size (`stat -c %s`, falling back to `wc -c`)
//           and only then `mv`s it into place. A failed piece removes the
//           temp file, so a half-sent upload never becomes the real file.
//
// Temp files carry a per-call random suffix (<path>.wa-tmp.<hex>) so two
// admins saving the same file at once can't interleave.
//
// The EC2 mode reads through SSM, whose inline output is capped at ~24 KB
// (SSM_OUTPUT_CAP_CHARS). readFile never returns a truncated file: at the cap
// it switches to readFileChunked, which pulls the file back in base64 pieces
// (one `dd … | base64` command each) and verifies the byte count. Callers
// that know a result may be large (remote SQLite result sets) use
// readFileChunked directly. runCommand results carry `truncated` so a caller
// can tell when a command's own stdout hit the cap.
//
// ssh2 is lazy-required (mirrors awsSsm) so the app still boots if it isn't
// installed yet — callers get a friendly SSH2_MISSING error only when SSH
// mode is actually used.

const fs = require('fs');
const { execFile } = require('child_process');
const awsSsm = require('./awsSsm');

const VALID_MODES = ['local', 'ssh', 'ec2'];

function requireSsh2() {
  try {
    return require('ssh2');
  } catch (e) {
    const err = new Error('ssh2 is not installed. Run `npm install ssh2`.');
    err.code = 'SSH2_MISSING';
    throw err;
  }
}

// Single-quote an argument for POSIX sh: wrap in '…' and escape embedded
// single quotes as '\''. Safe for arbitrary content (paths, base64 blobs).
function shQuote(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

// Parent directory of a POSIX path ('a/b/c.jpg' → 'a/b').
function dirOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : (i === 0 ? '/' : '.');
}

function toBuffer(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content == null ? '' : String(content), 'utf8');
}

// Largest base64 piece per SSM command for writeFileChunked. The whole
// command must stay at or under SSM_MAX_COMMAND_BYTES (~40 KB). When the EC2
// accessor runs as another user, wrap() base64-encodes the ENTIRE command
// again (+33%) inside `su - user -c '…'`, so the piece has to be smaller.
// The ~300 bytes of slack cover the printf/base64/redirect text and the
// temp path. Always a multiple of 4 so every piece decodes on its own.
const SSM_MAX_COMMAND_BYTES = 40000;
function ssmChunkChars(runAsUser) {
  const budget = SSM_MAX_COMMAND_BYTES - 600;
  const raw = runAsUser ? Math.floor(budget * 3 / 4) - 200 : budget;
  return raw - (raw % 4);
}

// SSM returns at most ~24,000 chars of stdout; at or past this length the
// output is taken as truncated.
const SSM_OUTPUT_CAP_CHARS = 23000;
// Raw bytes per piece for readFileChunked on EC2: 15,000 bytes → 20,000
// base64 chars, comfortably under the output cap.
const SSM_READ_CHUNK_BYTES = 15000;
// Largest file readFile asks SSM for inline (base64 of 17,000 bytes ≈ 22,700
// chars, under SSM_OUTPUT_CAP_CHARS); bigger ones go straight to pieces.
const SSM_INLINE_READ_MAX = 17000;

// A per-call temp name next to the target: <path>.wa-tmp.<8 hex>.
function tmpNameFor(remotePath) {
  return `${remotePath}.wa-tmp.${require('crypto').randomBytes(4).toString('hex')}`;
}

// Prefix a command with a `cd` into `cwd` so it runs from that directory.
// Used so Web App lifecycle commands run from the install directory
// (appPath) regardless of access mode. Blank cwd → command unchanged. If the
// directory doesn't exist, `cd` fails and `&&` short-circuits, surfacing the
// error on stderr with a non-zero exit code (consistent across all modes).
function withCwd(command, cwd) {
  if (!cwd) return command;
  return `cd ${shQuote(cwd)} && ${command}`;
}

function configError(msg) {
  const e = new Error(msg);
  e.code = 'CONFIG';
  return e;
}

// True when an error looks like "file doesn't exist" on any transport
// (local fs ENOENT, sftp NO_SUCH_FILE, remote cat/base64 stderr).
function isMissingErr(err) {
  if (!err) return false;
  if (err.code === 'ENOENT' || err.code === 2) return true;
  return /no such file|does not exist|ENOENT/i.test(err.message || String(err));
}

// Fallback readBundle built purely on the accessor's own primitives (one
// round-trip per entry, but parallel). Used directly by the local accessor
// and as the EC2 accessor's fallback when the batched output is truncated.
async function genericReadBundle(accessor, spec, opts) {
  const files = (spec && spec.files) || [];
  const dirs = (spec && spec.dirs) || [];
  const out = { files: {}, dirs: {} };
  await Promise.all([
    ...files.map(async (p) => {
      try {
        out.files[p] = { content: await accessor.readFile(p, opts), missing: false, err: null };
      } catch (e) {
        out.files[p] = isMissingErr(e)
          ? { content: null, missing: true, err: null }
          : { content: null, missing: false, err: e.message || String(e) };
      }
    }),
    ...dirs.map(async (p) => {
      try {
        // exit 3 = the folder doesn't exist (an empty list, not an error).
        const r = await accessor.runCommand(`[ -d ${shQuote(p)} ] || exit 3; ls -1 -- ${shQuote(p)}`, { timeoutMs: 20000 });
        if (r.code === 3) { out.dirs[p] = { names: [], err: null }; return; }
        if (r.code !== 0) { out.dirs[p] = { names: [], err: (r.stderr || '').trim() || `ls exited ${r.code}` }; return; }
        let text = r.stdout || '';
        if (r.truncated) {
          // SSM caps a command's output (~24 KB ≈ 1,100 upload names): a
          // cut-off listing must never pass for the whole folder (a backup
          // would silently miss files). Write it to a file and read that
          // back in pieces instead.
          const tmp = `${p.replace(/\/+$/, '')}/../.wa-ls.${require('crypto').randomBytes(6).toString('hex')}.txt`;
          try {
            const w = await accessor.runCommand(`umask 077; ls -1 -- ${shQuote(p)} > ${shQuote(tmp)}`, { timeoutMs: 60000 });
            if (w.code !== 0) throw new Error((w.stderr || '').trim() || `ls exited ${w.code}`);
            text = String(await accessor.readFileChunked(tmp, { encoding: 'utf8' }));
          } finally {
            await accessor.runCommand(`rm -f -- ${shQuote(tmp)}`, { timeoutMs: 20000 }).catch(() => {});
          }
        }
        out.dirs[p] = { names: text.split('\n').map(s => s.trim()).filter(Boolean), err: null };
      } catch (e) {
        out.dirs[p] = { names: [], err: e.message || String(e) };
      }
    })
  ]);
  return out;
}

// `mv -f tmp target` that keeps target's permission bits when it exists
// (GNU `chmod --reference`, falling back to BSD stat), so an atomic rewrite
// of a 0600 config.json doesn't come back 0644.
function mvKeepMode(tmp, target) {
  const t = shQuote(target), m = shQuote(tmp);
  // Keep the target's mode AND owner (the owner part only matters when the
  // command runs as root — e.g. EC2 with no "run as" user — and is a no-op
  // otherwise), so a rewrite never leaves config.json unreadable to the app.
  return `{ [ -e ${t} ] && { chmod --reference=${t} ${m} 2>/dev/null || chmod "$(stat -f %Lp ${t})" ${m} 2>/dev/null || true; chown --reference=${t} ${m} 2>/dev/null || true; }; mv -f ${m} ${t}; }`;
}

function getMode(appConfig) {
  const wa = (appConfig && appConfig.webApp) || {};
  return VALID_MODES.includes(wa.mode) ? wa.mode : 'local';
}

// Enough configuration to actually operate in the selected mode.
function isConfigured(appConfig) {
  const wa = (appConfig && appConfig.webApp) || {};
  const mode = getMode(appConfig);
  if (mode === 'local') return !!(wa.local && wa.local.appPath);
  if (mode === 'ssh') {
    const s = wa.ssh || {};
    return !!(s.host && s.username && s.privateKey);
  }
  if (mode === 'ec2') {
    const e = wa.ec2 || {};
    return !!(e.instanceId && (e.runningInAws || (e.accessKeyId && e.secretAccessKey)));
  }
  return false;
}

// ── Local ──────────────────────────────────────────────────────────────
function localAccessor(cfg) {
  const appPath = (cfg && cfg.appPath) || '';
  const self = {
    mode: 'local',
    appPath,
    describe() {
      return `Local (current user)${appPath ? ' · ' + appPath : ''}`;
    },
    runCommand(command, opts) {
      const timeoutMs = (opts && opts.timeoutMs) || 60000;
      const cmd = withCwd(command, opts && opts.cwd);
      return new Promise((resolve) => {
        execFile('/bin/sh', ['-c', cmd], {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024
        }, (err, stdout, stderr) => {
          if (err && err.killed) {
            return resolve({ code: null, stdout: stdout || '', stderr: stderr || '', timedOut: true });
          }
          let errOut = stderr || '';
          // Surface spawn-level failures (which carry no stderr) so the caller
          // sees the reason, e.g. /bin/sh missing.
          if (err && !errOut && err.code && typeof err.code !== 'number') errOut = err.message || String(err);
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: stdout || '', stderr: errOut, timedOut: false });
        });
      });
    },
    async readFile(remotePath, opts) {
      const buf = await fs.promises.readFile(remotePath);
      return (opts && opts.encoding) ? buf.toString(opts.encoding) : buf;
    },
    readFileChunked(remotePath, opts) {
      // No transport cap locally.
      return self.readFile(remotePath, opts);
    },
    async writeFile(remotePath, content) {
      // Atomic: write to a temp file then rename into place (atomic on POSIX)
      // so an interrupted write can't leave the remote config truncated/empty.
      const tmp = tmpNameFor(remotePath);
      try {
        // Keep the target's permissions (config.json is 0600 on the EC2
        // host — it holds SMTP / AWS secrets); a new file gets the umask.
        let mode = null;
        try { mode = (await fs.promises.stat(remotePath)).mode & 0o7777; } catch (e) { /* new file */ }
        await fs.promises.writeFile(tmp, content, mode != null ? { mode } : undefined);
        if (mode != null) await fs.promises.chmod(tmp, mode);
        await fs.promises.rename(tmp, remotePath);
      } catch (e) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    },
    async writeFileChunked(remotePath, buffer) {
      // Local disk has no payload limit: one atomic write (+ mkdir -p).
      const buf = toBuffer(buffer);
      await fs.promises.mkdir(dirOf(remotePath), { recursive: true });
      await self.writeFile(remotePath, buf);
      return { bytes: buf.length, chunks: 1 };
    },
    async exists(remotePath) {
      try { await fs.promises.access(remotePath); return true; }
      catch (e) { return false; }
    },
    readBundle(spec, opts) {
      // Local fs is already cheap per call; the generic parallel loop is fine.
      return genericReadBundle(self, spec, opts);
    },
    async test() {
      const details = {};
      try {
        const who = await self.runCommand('whoami');
        details.user = (who.stdout || '').trim() || null;
      } catch (e) { details.user = null; }
      if (!appPath) {
        return { ok: false, message: 'No web app directory path is set.', details };
      }
      let isDir = false, writable = false;
      try { isDir = fs.statSync(appPath).isDirectory(); } catch (e) { /* missing */ }
      details.appPathExists = isDir;
      if (isDir) {
        try { fs.accessSync(appPath, fs.constants.W_OK); writable = true; } catch (e) { /* read-only */ }
      }
      details.appPathWritable = writable;
      if (!isDir) return { ok: false, message: `Directory not found: ${appPath}`, details };
      return {
        ok: true,
        message: `Reachable as ${details.user || 'current user'}; directory found${writable ? ' (writable)' : ' (read-only)'}.`,
        details
      };
    }
  };
  return self;
}

// ── SSH ────────────────────────────────────────────────────────────────
function translateSshError(err) {
  if (!err) return new Error('Unknown SSH error');
  if (err.code === 'SSH2_MISSING' || err.code === 'CONFIG') return err;
  const msgRaw = err.message || String(err);
  let msg = msgRaw;
  if (err.level === 'client-authentication' || /authentication/i.test(msgRaw)) {
    msg = 'SSH authentication failed — check the username and private key.';
  } else if (err.code === 'ENOTFOUND' || /getaddrinfo/i.test(msgRaw)) {
    msg = `SSH host not found${err.hostname ? ': ' + err.hostname : ''}.`;
  } else if (err.code === 'ECONNREFUSED') {
    msg = 'SSH connection refused — check the host and port.';
  } else if (err.code === 'ETIMEDOUT' || /timed out|timeout/i.test(msgRaw)) {
    msg = 'SSH connection timed out — check the host, port, and network/security group.';
  } else if (/Cannot parse privateKey|bad private key|unsupported key/i.test(msgRaw)) {
    msg = 'Could not parse the SSH private key — paste a valid, unencrypted PEM key.';
  }
  const e = new Error(msg);
  e.code = err.code || err.level || 'SSH_ERROR';
  return e;
}

function sshAccessor(cfg) {
  const c = cfg || {};
  const appPath = c.appPath || '';
  const connCfg = {
    host: c.host || '',
    port: Number(c.port) || 22,
    username: c.username || '',
    privateKey: c.privateKey || ''
  };

  function validate() {
    if (!connCfg.host) throw configError('SSH host is not set.');
    if (!connCfg.username) throw configError('SSH username is not set.');
    if (!connCfg.privateKey) throw configError('SSH private key is not set.');
    if (/ENCRYPTED/.test(connCfg.privateKey)) {
      throw configError('The SSH private key is encrypted (passphrase-protected). Paste an unencrypted key.');
    }
  }

  function connect() {
    validate();
    const { Client } = requireSsh2();
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      conn.on('ready', () => { if (!settled) { settled = true; resolve(conn); } });
      conn.on('error', (err) => { if (!settled) { settled = true; reject(translateSshError(err)); } });
      try {
        conn.connect({
          host: connCfg.host,
          port: connCfg.port,
          username: connCfg.username,
          privateKey: connCfg.privateKey,
          readyTimeout: 15000,
          // Keepalives so a silently dropped connection errors out within
          // ~30 s instead of hanging an SFTP read/write forever.
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          // Own infrastructure → trust-on-first-use. Log the fingerprint so
          // an unexpected host-key change is at least visible in the logs.
          hostVerifier: (key) => {
            try {
              if (Buffer.isBuffer(key)) {
                const crypto = require('crypto');
                const fp = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
                console.log(`[web-app][ssh] ${connCfg.host} host key SHA256:${fp} (accepted, TOFU)`);
              }
            } catch (e) { /* best effort */ }
            return true;
          }
        });
      } catch (err) {
        if (!settled) { settled = true; reject(translateSshError(err)); }
      }
    });
  }

  async function withConnection(fn) {
    const conn = await connect();
    try { return await fn(conn); }
    finally { try { conn.end(); } catch (e) { /* ignore */ } }
  }

  function exec(conn, command, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 60000;
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(translateSshError(err));
        // Collect raw bytes and decode once at the end: decoding each packet
        // on its own would garble a UTF-8 character split across two.
        const out = [], errOut = [];
        let code = null, timedOut = false, timer = null;
        const finish = () => {
          if (timer) clearTimeout(timer);
          resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), timedOut });
        };
        timer = setTimeout(() => { timedOut = true; try { stream.close(); } catch (e) {} }, timeoutMs);
        stream.on('close', (c2) => { code = (typeof c2 === 'number') ? c2 : null; finish(); });
        stream.on('data', (d) => { out.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); });
        stream.stderr.on('data', (d) => { errOut.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))); });
      });
    });
  }

  function getSftp(conn) {
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(translateSshError(err)) : resolve(sftp));
    });
  }

  return {
    mode: 'ssh',
    appPath,
    describe() {
      const where = connCfg.host ? `${connCfg.username}@${connCfg.host}:${connCfg.port}` : '(not set)';
      return `SSH · ${where}${appPath ? ' · ' + appPath : ''}`;
    },
    runCommand(command, opts) {
      return withConnection((conn) => exec(conn, withCwd(command, opts && opts.cwd), opts));
    },
    readFile(remotePath, opts) {
      return withConnection(async (conn) => {
        const sftp = await getSftp(conn);
        const buf = await new Promise((resolve, reject) => {
          sftp.readFile(remotePath, (err, data) => err ? reject(err) : resolve(data));
        });
        return (opts && opts.encoding) ? buf.toString(opts.encoding) : buf;
      });
    },
    readFileChunked(remotePath, opts) {
      // SFTP streams any size.
      return this.readFile(remotePath, opts);
    },
    writeFile(remotePath, content) {
      // Atomic, like the local and EC2 accessors: SFTP-write a temp file,
      // then `mv -f` it into place over the same connection (rename is
      // atomic on POSIX). Plain SFTP rename won't overwrite an existing file
      // on every server, so the move runs as a shell command. An interrupted
      // upload only ever leaves the .wa-tmp file behind — never a truncated
      // config.json / fragment.
      return withConnection(async (conn) => {
        const sftp = await getSftp(conn);
        const tmp = tmpNameFor(remotePath);
        // 0600 temp file (it may hold config.json secrets), removed if the
        // upload fails partway.
        try {
          await new Promise((resolve, reject) => {
            sftp.writeFile(tmp, content, { mode: 0o600 }, (err) => err ? reject(err) : resolve());
          });
        } catch (e) {
          await exec(conn, `rm -f -- ${shQuote(tmp)}`, { timeoutMs: 30000 }).catch(() => {});
          throw e;
        }
        const r = await exec(conn, mvKeepMode(tmp, remotePath), { timeoutMs: 30000 });
        if (r.code !== 0) {
          await exec(conn, `rm -f -- ${shQuote(tmp)}`, { timeoutMs: 30000 }).catch(() => {});
          throw new Error(`Could not move ${tmp} into place: ${(r.stderr || '').trim() || 'exit ' + r.code}`);
        }
      });
    },
    writeFileChunked(remotePath, buffer) {
      // SFTP streams any size, so "chunked" here just means: mkdir -p the
      // target directory, SFTP the bytes to a temp file, `mv -f` into place —
      // all on one connection.
      const buf = toBuffer(buffer);
      return withConnection(async (conn) => {
        const mk = await exec(conn, `mkdir -p -- ${shQuote(dirOf(remotePath))}`, { timeoutMs: 30000 });
        if (mk.code !== 0) throw new Error(`Could not create ${dirOf(remotePath)}: ${(mk.stderr || '').trim() || 'exit ' + mk.code}`);
        const sftp = await getSftp(conn);
        const tmp = tmpNameFor(remotePath);
        // 0600 temp file (it may hold config.json secrets), removed if the
        // upload fails partway.
        try {
          await new Promise((resolve, reject) => {
            sftp.writeFile(tmp, buf, { mode: 0o600 }, (err) => err ? reject(err) : resolve());
          });
        } catch (e) {
          await exec(conn, `rm -f -- ${shQuote(tmp)}`, { timeoutMs: 30000 }).catch(() => {});
          throw e;
        }
        const r = await exec(conn, mvKeepMode(tmp, remotePath), { timeoutMs: 30000 });
        if (r.code !== 0) {
          await exec(conn, `rm -f -- ${shQuote(tmp)}`, { timeoutMs: 30000 }).catch(() => {});
          throw new Error(`Could not move ${tmp} into place: ${(r.stderr || '').trim() || 'exit ' + r.code}`);
        }
        return { bytes: buf.length, chunks: 1 };
      });
    },
    exists(remotePath) {
      return withConnection(async (conn) => {
        const sftp = await getSftp(conn);
        return await new Promise((resolve) => sftp.stat(remotePath, (err) => resolve(!err)));
      });
    },
    readBundle(spec, opts) {
      // One SSH connection for the whole bundle (readFile/exists each open
      // their own connection, which is what makes per-file loops slow here).
      const files = (spec && spec.files) || [];
      const dirs = (spec && spec.dirs) || [];
      return withConnection(async (conn) => {
        const sftp = await getSftp(conn);
        const out = { files: {}, dirs: {} };
        for (const p of files) {
          try {
            const buf = await new Promise((resolve, reject) => {
              sftp.readFile(p, (err, data) => err ? reject(err) : resolve(data));
            });
            out.files[p] = {
              content: (opts && opts.encoding) ? buf.toString(opts.encoding) : buf,
              missing: false, err: null
            };
          } catch (e) {
            out.files[p] = isMissingErr(e)
              ? { content: null, missing: true, err: null }
              : { content: null, missing: false, err: e.message || String(e) };
          }
        }
        for (const p of dirs) {
          try {
            const entries = await new Promise((resolve, reject) => {
              sftp.readdir(p, (err, list) => err ? reject(err) : resolve(list || []));
            });
            out.dirs[p] = { names: entries.map(e => e.filename).filter(Boolean), err: null };
          } catch (e) {
            out.dirs[p] = { names: [], err: isMissingErr(e) ? null : (e.message || String(e)) };
          }
        }
        return out;
      });
    },
    async test() {
      try {
        return await withConnection(async (conn) => {
          const who = await exec(conn, 'whoami');
          const details = { user: (who.stdout || '').trim() || null };
          if (!appPath) {
            return { ok: true, message: `Connected as ${details.user || '?'}. No directory path set to verify.`, details };
          }
          const sftp = await getSftp(conn);
          const isDir = await new Promise((resolve) => {
            sftp.stat(appPath, (err, st) => resolve(!err && st && typeof st.isDirectory === 'function' && st.isDirectory()));
          });
          details.appPathExists = isDir;
          if (!isDir) {
            return { ok: false, message: `Connected as ${details.user || '?'}, but directory not found: ${appPath}`, details };
          }
          return { ok: true, message: `Connected as ${details.user || '?'}; directory found.`, details };
        });
      } catch (err) {
        return { ok: false, message: err.message || String(err), details: { code: err.code || null } };
      }
    }
  };
}

// ── EC2 (AWS SSM) ────────────────────────────────────────────────────────
function ec2Accessor(cfg) {
  const c = cfg || {};
  const appPath = c.appPath || '';
  const runAsUser = c.runAsUser || '';
  const instanceId = c.instanceId || '';
  const creds = {
    runningInAws: !!c.runningInAws,
    accessKeyId: c.accessKeyId || '',
    secretAccessKey: c.secretAccessKey || '',
    region: c.region || 'us-east-1'
  };

  // Run a command as runAsUser when set. base64 the inner command so the
  // `su -c '<…>'` payload never has to escape quotes (the base64 alphabet
  // is shell-safe), no matter what the original command contained.
  function wrap(command) {
    if (!runAsUser) return command;
    // Only a plain Linux user name ever reaches the shell (a restored or
    // hand-edited config could carry anything), and it is quoted too.
    if (!/^[a-z_][a-z0-9_-]*\$?$/.test(runAsUser)) throw configError(`Web App EC2 "run as user" is not a valid user name: ${JSON.stringify(runAsUser)}`);
    const b64 = Buffer.from(String(command), 'utf8').toString('base64');
    return `su - ${shQuote(runAsUser)} -c ${shQuote(`echo ${b64} | base64 -d | sh`)}`;
  }

  function ssmRun(command, opts) {
    if (!instanceId) return Promise.reject(configError('Web App EC2 instance ID is not set.'));
    return awsSsm.runCommand({}, instanceId, wrap(command), {
      creds,
      timeoutMs: (opts && opts.timeoutMs) || 60000,
      execTimeoutMs: opts && opts.execTimeoutMs,
      comment: (opts && opts.comment) || 'Admin console web-app command'
    });
  }

  // Normalize an awsSsm result into the accessor's run contract.
  function toRunResult(r) {
    const code = r.responseCode == null
      ? (r.status === 'Success' ? 0 : null)
      : r.responseCode;
    const stdout = r.stdout || '';
    return {
      code, stdout, stderr: r.stderr || '', timedOut: !!r.timedOut, status: r.status, commandId: r.commandId,
      // SSM keeps only the FIRST ~24,000 chars of stdout: at the cap the end
      // of the output is gone. Callers that need the end (logs) pipe through
      // `tail -c`; callers that need all of it (SQLite results) use a file.
      truncated: stdout.length >= SSM_OUTPUT_CAP_CHARS
    };
  }

  // Pull a file back in pieces: one `dd | base64` command per
  // SSM_READ_CHUNK_BYTES, then verify the total against the file's size.
  // Reads are idempotent: retry a failed / throttled one a few times before
  // giving up (one bad piece of ~230 used to abort a whole backup).
  async function ssmRead(cmd, opts) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(res => setTimeout(res, 500 * attempt * attempt));
      try { last = await ssmRun(cmd, opts); } catch (e) { last = { status: 'Failed', stderr: e.message || String(e) }; continue; }
      if (last.status === 'Success') return last;
      if (/No such file/.test(last.stderr || '')) return last; // not transient
    }
    return last;
  }

  async function readChunked(remotePath, opts) {
    const q = shQuote(remotePath);
    let r = await ssmRead(
      `if [ -f ${q} ]; then sz=$(stat -c %s ${q} 2>/dev/null || wc -c < ${q}); echo "__WA_SIZE__ $(echo $sz | tr -d ' ')"; ` +
      `else echo ${shQuote('No such file: ' + remotePath)} >&2; exit 2; fi`,
      { timeoutMs: (opts && opts.timeoutMs) || 60000, comment: 'Admin console chunked read (size)' });
    if (r.status !== 'Success') throw new Error(`Could not read ${remotePath} via SSM: ${r.stderr || r.status}`);
    const m = /__WA_SIZE__ (\d+)/.exec(r.stdout || '');
    if (!m) throw new Error(`Could not read ${remotePath} via SSM: no size reported.`);
    const size = Number(m[1]);
    const parts = [];
    for (let k = 0; k * SSM_READ_CHUNK_BYTES < size; k++) {
      const p = await ssmRead(`dd if=${q} bs=${SSM_READ_CHUNK_BYTES} skip=${k} count=1 2>/dev/null | base64 | tr -d '\\n'`,
        { timeoutMs: (opts && opts.timeoutMs) || 60000, comment: `Admin console chunked read (${k + 1})` });
      if (p.status !== 'Success') throw new Error(`Could not read ${remotePath} via SSM (piece ${k + 1}): ${p.stderr || p.status}`);
      const raw = (p.stdout || '').replace(/\s+/g, '');
      if (raw.length >= SSM_OUTPUT_CAP_CHARS) throw new Error(`Could not read ${remotePath} via SSM: piece ${k + 1} was truncated.`);
      parts.push(Buffer.from(raw, 'base64'));
    }
    const buf = Buffer.concat(parts);
    if (buf.length !== size) throw new Error(`Could not read ${remotePath} via SSM: got ${buf.length} of ${size} bytes.`);
    return (opts && opts.encoding) ? buf.toString(opts.encoding) : buf;
  }

  return {
    mode: 'ec2',
    appPath,
    describe() {
      return `EC2 via SSM · ${instanceId || '(no instance)'} @ ${creds.region}${runAsUser ? ' as ' + runAsUser : ''}`;
    },
    async runCommand(command, opts) {
      // cwd is applied INSIDE the runAsUser wrap (ssmRun → wrap), so the
      // `cd` runs as the target user in the right directory.
      return toRunResult(await ssmRun(withCwd(command, opts && opts.cwd), opts));
    },
    async readFile(remotePath, opts) {
      // base64 over SSM is binary-safe. NOTE: SSM truncates command output
      // at ~24,000 chars (~18 KB of file after base64) — only suitable for
      // small text files (config/scripts), NOT the SQLite database.
      // One command: small files come back inline; a file too big for SSM's
      // output cap answers with its size only and is read in pieces (instead
      // of a full base64 that would be cut off and thrown away).
      const q0 = shQuote(remotePath);
      const r = await ssmRead(`if [ -f ${q0} ]; then sz=$(stat -c %s ${q0} 2>/dev/null || wc -c < ${q0}); sz=$(echo $sz | tr -d ' '); if [ "$sz" -gt ${SSM_INLINE_READ_MAX} ]; then echo "__WA_BIG__ $sz"; else base64 ${q0}; fi; else base64 ${q0}; fi`, opts);
      if (r.status === 'Success' && /^__WA_BIG__ \d+/.test((r.stdout || '').trim())) return readChunked(remotePath, opts);
      if (r.status !== 'Success') {
        throw new Error(`Could not read ${remotePath} via SSM: ${r.stderr || r.status}`);
      }
      const raw = r.stdout || '';
      // SSM caps inline command output at ~24,000 chars. At/near the cap the
      // base64 was almost certainly truncated — returning it would let a
      // read-modify-write (e.g. the website editor) save a corrupted, truncated
      // fragment back over the good one. Read it in verified pieces instead.
      if (raw.length >= SSM_OUTPUT_CAP_CHARS) return readChunked(remotePath, opts);
      const buf = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
      return (opts && opts.encoding) ? buf.toString(opts.encoding) : buf;
    },
    readFileChunked(remotePath, opts) {
      return readChunked(remotePath, opts);
    },
    async writeFile(remotePath, content) {
      const b64 = Buffer.isBuffer(content)
        ? content.toString('base64')
        : Buffer.from(String(content), 'utf8').toString('base64');
      // One SSM command carries at most ssmChunkChars() of base64; anything
      // bigger goes in pieces (writeFileChunked), which is atomic the same way.
      if (b64.length > ssmChunkChars(runAsUser)) {
        await this.writeFileChunked(remotePath, content);
        return;
      }
      // Atomic: decode to a temp file, then `mv` into place (rename is atomic
      // on POSIX). If the SSM command is interrupted or base64/printf fails,
      // only the temp file is affected — the real remote config.json is never
      // left truncated/empty (which would break the web app's boot).
      const tmp = tmpNameFor(remotePath);
      const r = await ssmRun(`printf '%s' ${shQuote(b64)} | base64 -d > ${shQuote(tmp)} && ${mvKeepMode(tmp, remotePath)} || { rm -f -- ${shQuote(tmp)}; exit 1; }`);
      if (r.status !== 'Success') {
        throw new Error(`Could not write ${remotePath} via SSM: ${r.stderr || r.status}`);
      }
    },
    async writeFileChunked(remotePath, buffer) {
      const buf = toBuffer(buffer);
      const tmp = tmpNameFor(remotePath);
      const b64 = buf.toString('base64');
      const per = ssmChunkChars(runAsUser);
      const fail = async (what, r) => {
        try { await ssmRun(`rm -f -- ${shQuote(tmp)}`, { timeoutMs: 30000 }); } catch (e) { /* best effort */ }
        throw new Error(`Could not upload ${remotePath} via SSM (${what}): ${(r && (r.stderr || r.status)) || 'no response'}`);
      };
      // 1) target dir + empty temp file.
      let r = await ssmRun(`mkdir -p -- ${shQuote(dirOf(remotePath))} && : > ${shQuote(tmp)}`, { timeoutMs: 60000, comment: 'Admin console upload (start)' });
      if (r.status !== 'Success') await fail('mkdir', r);
      // 2) append each base64 piece (decoded on the host).
      // A failed piece is retried — after checking the temp file's size, so a
      // piece that did land (SSM reported a failure anyway) is never
      // appended twice. Pieces are whole base64 quads, so bytes are exact.
      const sizeNow = async () => {
        const q = await ssmRun(`stat -c %s ${shQuote(tmp)} 2>/dev/null || wc -c < ${shQuote(tmp)}`, { timeoutMs: 30000, comment: 'Admin console upload (size)' }).catch(() => null);
        const n = q && q.status === 'Success' ? parseInt(String(q.stdout || '').trim(), 10) : NaN;
        return Number.isFinite(n) ? n : null;
      };
      let chunks = 0, bytesSent = 0;
      for (let off = 0; off < b64.length; off += per) {
        const piece = b64.slice(off, off + per);
        const pieceBytes = Buffer.from(piece, 'base64').length;
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          if (attempt) await new Promise(res => setTimeout(res, 500 * attempt * attempt));
          r = await ssmRun(`printf '%s' ${shQuote(piece)} | base64 -d >> ${shQuote(tmp)}`, { timeoutMs: 60000, comment: 'Admin console upload (chunk)' }).catch(e => ({ status: 'Failed', stderr: e.message }));
          if (r.status === 'Success') { ok = true; break; }
          const have = await sizeNow();
          if (have === bytesSent + pieceBytes) { ok = true; break; }   // it landed after all
          if (have !== bytesSent) break;                               // half-written / unknown: give up
        }
        if (!ok) await fail(`chunk ${chunks + 1}`, r);
        bytesSent += pieceBytes;
        chunks++;
      }
      // 3) verify the byte count, then move into place.
      r = await ssmRun(
        `sz=$(stat -c %s ${shQuote(tmp)} 2>/dev/null || wc -c < ${shQuote(tmp)}); sz=$(echo $sz | tr -d ' '); ` +
        `if [ "$sz" = "${buf.length}" ]; then ${mvKeepMode(tmp, remotePath)} && echo __WA_UPLOAD_OK__; ` +
        `else echo "size mismatch: got $sz, expected ${buf.length}" >&2; rm -f -- ${shQuote(tmp)}; exit 3; fi`,
        { timeoutMs: 60000, comment: 'Admin console upload (finish)' });
      if (r.status !== 'Success' || !/__WA_UPLOAD_OK__/.test(r.stdout || '')) await fail('verify', r);
      return { bytes: buf.length, chunks };
    },
    async exists(remotePath) {
      const r = await ssmRun(`test -e ${shQuote(remotePath)} && echo __WA_EXISTS__ || echo __WA_MISSING__`);
      return /__WA_EXISTS__/.test(r.stdout || '');
    },
    async readBundle(spec, opts) {
      // ONE SSM Run Command for the whole bundle. Each entry is emitted
      // between index markers; files are base64'd (binary-safe). SSM caps
      // inline output at ~24,000 chars, so if the terminating marker never
      // arrives the output was truncated — fall back to per-file reads,
      // where the existing per-file size guard gives a precise error for
      // whichever file is actually too big.
      const files = (spec && spec.files) || [];
      const dirs = (spec && spec.dirs) || [];
      if (!files.length && !dirs.length) return { files: {}, dirs: {} };
      const script = [
        ...files.map((p, i) => `echo "__WAB F ${i}"; if [ -f ${shQuote(p)} ]; then base64 ${shQuote(p)} || echo __WAB_ERR; else echo __WAB_MISSING; fi`),
        ...dirs.map((p, i) => `echo "__WAB D ${i}"; if [ -d ${shQuote(p)} ]; then ls -1 -- ${shQuote(p)} 2>/dev/null || echo __WAB_LSERR; fi`),
        'echo "__WAB END"'
      ].join('\n');

      let r;
      try {
        r = await ssmRun(script, { timeoutMs: (opts && opts.timeoutMs) || 60000, comment: 'Admin console bundle read' });
      } catch (e) {
        return genericReadBundle(this, spec, opts);
      }
      const stdout = r.stdout || '';
      if (r.status !== 'Success' || !/^__WAB END$/m.test(stdout)) {
        // Failed or truncated — per-file fallback isolates the culprit.
        return genericReadBundle(this, spec, opts);
      }

      const out = { files: {}, dirs: {} };
      let cur = null; // { kind: 'F'|'D', path }
      let lines = [];
      const flush = () => {
        if (!cur) return;
        if (cur.kind === 'F') {
          if (lines[0] === '__WAB_MISSING') {
            out.files[cur.path] = { content: null, missing: true, err: null };
          } else if (lines[lines.length - 1] === '__WAB_ERR') {
            out.files[cur.path] = { content: null, missing: false, err: 'Could not read file on the Web App host.' };
          } else {
            const buf = Buffer.from(lines.join('').replace(/\s+/g, ''), 'base64');
            const content = (opts && opts.encoding) ? buf.toString(opts.encoding) : buf;
            out.files[cur.path] = { content, missing: false, err: null };
          }
        } else {
          // An unreadable folder must never look empty (a backup would miss
          // its files and a restore's clean-up would treat them as extra).
          if (lines.length && lines[lines.length - 1] === '__WAB_LSERR') out.dirs[cur.path] = { names: [], err: 'Could not list this folder on the Web App host (permissions?).' };
          else out.dirs[cur.path] = { names: lines.map(s => s.trim()).filter(Boolean), err: null };
        }
      };
      for (const line of stdout.split('\n')) {
        const m = /^__WAB (F|D) (\d+)$/.exec(line);
        if (m) {
          flush();
          const idx = parseInt(m[2], 10);
          cur = { kind: m[1], path: m[1] === 'F' ? files[idx] : dirs[idx] };
          lines = [];
        } else if (/^__WAB END$/.test(line)) {
          flush();
          cur = null;
        } else if (cur) {
          lines.push(line);
        }
      }
      // Anything the script never reported (shouldn't happen) → error entry.
      for (const p of files) if (!out.files[p]) out.files[p] = { content: null, missing: false, err: 'No data returned for this file.' };
      for (const p of dirs) if (!out.dirs[p]) out.dirs[p] = { names: [], err: null };
      return out;
    },
    async test() {
      if (!awsSsm.isConfigured({}, creds)) {
        return { ok: false, message: 'AWS credentials are not configured (and "deployed in AWS" is off).', details: {} };
      }
      if (!instanceId) {
        return { ok: false, message: 'No EC2 instance ID is set.', details: {} };
      }
      try {
        const probe = `whoami; if [ -n ${shQuote(appPath)} ] && [ -d ${shQuote(appPath)} ]; then echo __WA_DIR_OK__; else echo __WA_DIR_MISSING__; fi`;
        const r = await ssmRun(probe, { comment: 'Admin console web-app connection test' });
        const details = { ssmStatus: r.status, commandId: r.commandId, stdout: r.stdout, stderr: r.stderr };
        const firstLine = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || null;
        details.user = firstLine;
        if (r.status !== 'Success') {
          return {
            ok: false,
            message: r.timedOut
              ? 'SSM did not respond in time — the instance may be unreachable (check the SSM agent and the instance IAM role).'
              : `SSM command failed (status: ${r.status}). ${r.stderr || ''}`.trim(),
            details
          };
        }
        const dirOk = /__WA_DIR_OK__/.test(r.stdout || '');
        details.appPathExists = dirOk;
        if (appPath && !dirOk) {
          return { ok: false, message: `Reachable as ${details.user || '?'} via SSM, but directory not found: ${appPath}`, details };
        }
        return { ok: true, message: `Reachable as ${details.user || '?'} via SSM${appPath ? '; directory found' : ''}.`, details };
      } catch (err) {
        let msg = err.message || String(err);
        if (err.code === 'AWS_SDK_MISSING') msg = '@aws-sdk/client-ssm is not installed.';
        return { ok: false, message: msg, details: { code: err.code || null } };
      }
    }
  };
}

// Build an accessor straight from a webApp config block (the shape
// stored under appConfig.webApp). Used by the Test route so it can
// operate on unsaved form values, not just the persisted config.
function createAccessor(waBlock) {
  const wa = (waBlock && typeof waBlock === 'object') ? waBlock : {};
  const mode = VALID_MODES.includes(wa.mode) ? wa.mode : 'local';
  if (mode === 'ssh') return sshAccessor(wa.ssh || {});
  if (mode === 'ec2') return ec2Accessor(wa.ec2 || {});
  return localAccessor(wa.local || {});
}

function createAccessorFromConfig(appConfig) {
  return createAccessor((appConfig && appConfig.webApp) || {});
}

module.exports = {
  VALID_MODES,
  SSM_MAX_COMMAND_BYTES,
  SSM_OUTPUT_CAP_CHARS,
  ssmChunkChars,
  shQuote,
  getMode,
  isConfigured,
  createAccessor,
  createAccessorFromConfig
};
