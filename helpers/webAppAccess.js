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
//   runCommand(command, opts) -> { code, stdout, stderr, timedOut }
//   readFile(remotePath, opts) -> Buffer (default) or string (opts.encoding)
//   writeFile(remotePath, content)
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
// fragment truncated. The EC2 mode reads through SSM, whose inline output is
// capped at ~24 KB — readFile refuses (rather than truncates) anything near
// that cap, so a read-modify-write can't save a damaged file back.
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
        const r = await accessor.runCommand(`ls -1 -- ${shQuote(p)}`, { timeoutMs: 20000 });
        out.dirs[p] = {
          names: r.code === 0 ? (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean) : [],
          err: null
        };
      } catch (e) {
        out.dirs[p] = { names: [], err: e.message || String(e) };
      }
    })
  ]);
  return out;
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
    async writeFile(remotePath, content) {
      // Atomic: write to a temp file then rename into place (atomic on POSIX)
      // so an interrupted write can't leave the remote config truncated/empty.
      const tmp = remotePath + '.wa-tmp';
      await fs.promises.writeFile(tmp, content);
      await fs.promises.rename(tmp, remotePath);
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
          keepaliveInterval: 0,
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
        let stdout = '', stderr = '', code = null, timedOut = false, timer = null;
        const finish = () => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); };
        timer = setTimeout(() => { timedOut = true; try { stream.close(); } catch (e) {} }, timeoutMs);
        stream.on('close', (c2) => { code = (typeof c2 === 'number') ? c2 : null; finish(); });
        stream.on('data', (d) => { stdout += d.toString(); });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
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
    writeFile(remotePath, content) {
      // Atomic, like the local and EC2 accessors: SFTP-write a temp file,
      // then `mv -f` it into place over the same connection (rename is
      // atomic on POSIX). Plain SFTP rename won't overwrite an existing file
      // on every server, so the move runs as a shell command. An interrupted
      // upload only ever leaves the .wa-tmp file behind — never a truncated
      // config.json / fragment.
      return withConnection(async (conn) => {
        const sftp = await getSftp(conn);
        const tmp = remotePath + '.wa-tmp';
        await new Promise((resolve, reject) => {
          sftp.writeFile(tmp, content, (err) => err ? reject(err) : resolve());
        });
        const r = await exec(conn, `mv -f ${shQuote(tmp)} ${shQuote(remotePath)}`, { timeoutMs: 30000 });
        if (r.code !== 0) {
          throw new Error(`Could not move ${tmp} into place: ${(r.stderr || '').trim() || 'exit ' + r.code}`);
        }
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
    const b64 = Buffer.from(String(command), 'utf8').toString('base64');
    return `su - ${runAsUser} -c ${shQuote(`echo ${b64} | base64 -d | sh`)}`;
  }

  function ssmRun(command, opts) {
    if (!instanceId) return Promise.reject(configError('Web App EC2 instance ID is not set.'));
    return awsSsm.runCommand({}, instanceId, wrap(command), {
      creds,
      timeoutMs: (opts && opts.timeoutMs) || 60000,
      comment: (opts && opts.comment) || 'Admin console web-app command'
    });
  }

  // Normalize an awsSsm result into the accessor's run contract.
  function toRunResult(r) {
    const code = r.responseCode == null
      ? (r.status === 'Success' ? 0 : null)
      : r.responseCode;
    return { code, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!r.timedOut, status: r.status, commandId: r.commandId };
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
      const r = await ssmRun(`base64 ${shQuote(remotePath)}`, opts);
      if (r.status !== 'Success') {
        throw new Error(`Could not read ${remotePath} via SSM: ${r.stderr || r.status}`);
      }
      const raw = r.stdout || '';
      // SSM caps inline command output at ~24,000 chars. At/near the cap the
      // base64 was almost certainly truncated — returning it would let a
      // read-modify-write (e.g. the website editor) save a corrupted, truncated
      // fragment back over the good one. Fail loudly instead of silently.
      if (raw.length >= 23000) {
        throw new Error(`File ${remotePath} is too large to read over SSM (output truncated at ~24 KB). Use a smaller file, or SSH/local Web App access mode.`);
      }
      const buf = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
      return (opts && opts.encoding) ? buf.toString(opts.encoding) : buf;
    },
    async writeFile(remotePath, content) {
      const b64 = Buffer.isBuffer(content)
        ? content.toString('base64')
        : Buffer.from(String(content), 'utf8').toString('base64');
      // Atomic: decode to a temp file, then `mv` into place (rename is atomic
      // on POSIX). If the SSM command is interrupted or base64/printf fails,
      // only the temp file is affected — the real remote config.json is never
      // left truncated/empty (which would break the web app's boot).
      const tmp = remotePath + '.wa-tmp';
      const r = await ssmRun(`printf '%s' ${shQuote(b64)} | base64 -d > ${shQuote(tmp)} && mv -f ${shQuote(tmp)} ${shQuote(remotePath)}`);
      if (r.status !== 'Success') {
        throw new Error(`Could not write ${remotePath} via SSM: ${r.stderr || r.status}`);
      }
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
        ...dirs.map((p, i) => `echo "__WAB D ${i}"; ls -1 -- ${shQuote(p)} 2>/dev/null`),
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
          out.dirs[cur.path] = { names: lines.map(s => s.trim()).filter(Boolean), err: null };
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
  getMode,
  isConfigured,
  createAccessor,
  createAccessorFromConfig
};
