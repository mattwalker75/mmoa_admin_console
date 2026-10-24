// helpers/awsSsm.js — thin wrapper around @aws-sdk/client-ssm for the one
// SSM operation the admin console needs: Run Command against the web app's
// EC2 instance (the "Remote on EC2 (AWS)" Web App access mode in
// helpers/webAppAccess.js). This console never creates or modifies AWS
// resources — Run Command is the only AWS API it calls.
//
// Lazy `require` — callers get AWS_SDK_MISSING if the package isn't
// installed yet so the app still boots.
//
// Credential strategy: runningInAws ⇒ instance role, otherwise the static
// key pair from Settings → Web App (webApp.ec2). The IAM principal needs
// ssm:SendCommand and ssm:GetCommandInvocation on the instance + the
// AWS-RunShellScript document.

const { logAwsCall } = require('./awsLog');
const { clientKey } = require('./awsClientKey');

let _client = null;
let _clientKey = null;

function requireSdk() {
  try {
    return require('@aws-sdk/client-ssm');
  } catch (e) {
    const err = new Error('@aws-sdk/client-ssm is not installed. Run `npm install @aws-sdk/client-ssm`.');
    err.code = 'AWS_SDK_MISSING';
    throw err;
  }
}

// Resolve the credential block to authenticate with. Callers pass `creds`
// explicitly (the web app's region/keys under appConfig.webApp.ec2); the
// appConfig.aws fallback is kept for parity with the reference console.
function resolveCreds(appConfig, creds) {
  if (creds && typeof creds === 'object') return creds;
  return (appConfig && appConfig.aws) || {};
}

function isConfigured(appConfig, creds) {
  const a = resolveCreds(appConfig, creds);
  if (!a.runningInAws && (!a.accessKeyId || !a.secretAccessKey)) return false;
  return true;
}

function buildClient(appConfig, creds) {
  const sdk = requireSdk();
  const a = resolveCreds(appConfig, creds);
  const region = a.region || 'us-east-1';

  const opts = { region };
  if (!a.runningInAws) {
    if (!a.accessKeyId || !a.secretAccessKey) {
      const err = new Error('AWS access key + secret are not configured. Set them under Settings → Web App (EC2 mode), or turn on "This app is deployed in AWS" if this console is itself running on an EC2 instance with an instance role.');
      err.code = 'AWS_CREDENTIALS_MISSING';
      throw err;
    }
    opts.credentials = {
      accessKeyId: a.accessKeyId,
      secretAccessKey: a.secretAccessKey
    };
  }

  // Memoize on the FULL resolved identity so a changed region / key / secret
  // never reuses a stale client.
  const key = clientKey(a);
  if (_client && _clientKey === key) return _client;
  _client = new sdk.SSMClient(opts);
  _clientKey = key;
  return _client;
}

function resetClient() {
  _client = null;
  _clientKey = null;
}

// Replace {{token}} markers in a command template. Unknown tokens are left
// literal. (Kept from the reference console; no current caller.)
function renderCommand(template, vars) {
  if (!template) return '';
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run a shell command on a single EC2 instance via SSM Run Command, then
// poll GetCommandInvocation until it reaches a terminal state or the
// timeout expires. Returns {
//   commandId, status, responseCode, stdout, stderr, timedOut
// }
// where `status` is one of Pending | InProgress | Success | Cancelled |
// Failed | TimedOut | Delayed (per AWS docs). `timedOut` is true when WE
// stopped polling before AWS reported a terminal state.
async function runCommand(appConfig, instanceId, command, opts) {
  const sdk = requireSdk();
  // opts.creds overrides appConfig.aws — the web app's own principal
  // (webApp.ec2).
  const client = buildClient(appConfig, opts && opts.creds);
  const timeoutMs    = (opts && opts.timeoutMs)    || 60000;
  // Fixed poll interval when the caller asks for one; otherwise adaptive:
  // first poll immediately (most short commands finish in well under a
  // second), then back off 250ms → 2s so long commands don't hammer the API.
  const fixedPollMs  = (opts && opts.pollEveryMs) || 0;
  // TimeoutSeconds is SSM's DELIVERY timeout (how long the command may wait
  // to reach the agent); how long it may RUN is the document's
  // executionTimeout (AWS-RunShellScript default 3600 s). Set both from the
  // caller's budget so a command can't outlive what the console expects.
  const ssmTimeoutSec = Math.min(600, Math.max(30, Math.ceil(timeoutMs / 1000)));
  const execTimeoutSec = Math.min(172800, Math.max(30, Math.ceil(timeoutMs / 1000)));

  const sendInput = {
    InstanceIds: [instanceId],
    DocumentName: 'AWS-RunShellScript',
    Comment: (opts && opts.comment) || 'Admin console run',
    Parameters: { commands: [command], executionTimeout: [String(execTimeoutSec)] },
    TimeoutSeconds: ssmTimeoutSec
  };
  const sendRes = await logAwsCall('SendCommand', sendInput,
    () => client.send(new sdk.SendCommandCommand(sendInput)),
    (r) => `CommandId=${r.Command && r.Command.CommandId} Status=${r.Command && r.Command.Status}`);
  const commandId = sendRes.Command && sendRes.Command.CommandId;
  if (!commandId) throw new Error('SendCommand returned no CommandId');

  // Poll until terminal or our wall-clock budget expires. The first one
  // or two calls can return InvocationDoesNotExist while SSM propagates
  // the command to the agent — treat that as "still pending" instead of
  // an error.
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['Success', 'Cancelled', 'Failed', 'TimedOut']);
  let last = null;
  let backoffMs = 0; // first poll fires immediately
  while (Date.now() < deadline) {
    if (backoffMs) await sleep(backoffMs);
    backoffMs = fixedPollMs || Math.min(2000, backoffMs ? Math.round(backoffMs * 1.7) : 250);
    try {
      const invInput = { CommandId: commandId, InstanceId: instanceId };
      const inv = await logAwsCall('GetCommandInvocation', invInput,
        () => client.send(new sdk.GetCommandInvocationCommand(invInput)),
        (r) => `Status=${r.Status} ResponseCode=${r.ResponseCode == null ? '-' : r.ResponseCode}`);
      last = inv;
      if (terminal.has(inv.Status)) {
        return {
          commandId,
          status: inv.Status,
          responseCode: inv.ResponseCode == null ? null : inv.ResponseCode,
          stdout: inv.StandardOutputContent || '',
          stderr: inv.StandardErrorContent || '',
          timedOut: false
        };
      }
    } catch (err) {
      const name = err && (err.name || err.Code || err.code);
      if (name === 'InvocationDoesNotExist') {
        // Race between SendCommand returning and the invocation being
        // queryable. Keep polling.
        continue;
      }
      throw err;
    }
  }
  // Our budget expired before AWS reported terminal. Return whatever the
  // last poll told us so the operator can decide whether to wait or move
  // on (the command keeps running server-side).
  return {
    commandId,
    status: (last && last.Status) || 'InProgress',
    responseCode: last && last.ResponseCode != null ? last.ResponseCode : null,
    stdout: (last && last.StandardOutputContent) || '',
    stderr: (last && last.StandardErrorContent) || '',
    timedOut: true
  };
}

module.exports = {
  isConfigured,
  resetClient,
  renderCommand,
  runCommand
};
