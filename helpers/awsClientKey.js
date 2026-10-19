// helpers/awsClientKey.js — memo key for the cached AWS SDK clients
// (awsSsm keeps one client and rebuilds it only when this key changes).
//
// The key must change whenever ANYTHING that affects authentication
// changes, or a rotated credential is silently ignored until the process
// restarts. Keying on region + access key ID alone missed the secret: an
// operator who rotated only the secret (or fat-fingered it) kept getting
// the old client, whose old secret still worked, so the change appeared
// to do nothing. The secret goes in as a short hash — enough to detect a
// change, without holding the raw value in the memo string.
const crypto = require('crypto');

function clientKey(a) {
  const c = a || {};
  const region = c.region || 'us-east-1';
  if (c.runningInAws) return `${region}|__role__`;
  const fp = crypto.createHash('sha256').update(String(c.secretAccessKey || '')).digest('hex').slice(0, 12);
  return `${region}|${c.accessKeyId || ''}|${fp}`;
}

module.exports = { clientKey };
