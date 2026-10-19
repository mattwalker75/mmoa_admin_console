// helpers/awsLog.js — uniform stdout logging around every AWS SDK call.
//
// Logs three lines per call:
//   [aws-call] <Operation> → <input>
//   [aws-call] <Operation> ✓ <durationMs>ms <summary>      (success)
//   [aws-call] <Operation> ✗ <durationMs>ms <ErrName>: msg (failure)
//
// Sensitive fields are redacted before the input line is printed:
//   * Parameters   — the SSM SendCommand container holding the shell
//                    command. File writes over SSM embed the (base64)
//                    file content — e.g. the web app's config.json with its
//                    SMTP / AWS secrets — so it never reaches the log.
//   * Credentials  — never appear in command inputs (they're on the
//                    client itself), but if any future SDK call surfaces
//                    them we strip them here defensively.
//
// Output is summarized by the caller via an optional `summarize` function
// so we don't dump full multi-KB AWS responses to stdout.

// 'Parameters' is the SSM SendCommand container holding the rendered
// shell command — which for writeFile carries the file content (secrets
// included). UserData is kept for parity with the reference console.
const SENSITIVE_KEYS = new Set(['UserData', 'AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Parameters']);

function redact(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (SENSITIVE_KEYS.has(k)) {
        const v = value[k];
        out[k] = typeof v === 'string'
          ? `<redacted, ${v.length} chars>`
          : '<redacted>';
      } else {
        out[k] = redact(value[k]);
      }
    }
    return out;
  }
  return value;
}

async function logAwsCall(label, input, fn, summarize) {
  const safeInput = redact(input);
  let inputStr;
  try { inputStr = JSON.stringify(safeInput); }
  catch (e) { inputStr = '<unserializable input>'; }
  // Cap input log line at 1.5KB so a freak large payload doesn't drown the stream.
  if (inputStr.length > 1500) inputStr = inputStr.slice(0, 1500) + '…(truncated)';
  console.log(`[aws-call] ${label} → ${inputStr}`);

  const t0 = Date.now();
  try {
    const out = await fn();
    const dur = Date.now() - t0;
    let summary = '(ok)';
    if (typeof summarize === 'function') {
      try { summary = summarize(out) || '(ok)'; }
      catch (e) { summary = '(ok, summary failed: ' + (e.message || e) + ')'; }
    }
    console.log(`[aws-call] ${label} ✓ ${dur}ms ${summary}`);
    return out;
  } catch (err) {
    const dur = Date.now() - t0;
    const name = err.name || err.code || err.Code || 'Error';
    const status = err.$metadata && err.$metadata.httpStatusCode;
    const statusSuffix = status ? ` [HTTP ${status}]` : '';
    console.error(`[aws-call] ${label} ✗ ${dur}ms (${name})${statusSuffix}: ${err.message || err}`);
    throw err;
  }
}

module.exports = { logAwsCall, redact };
