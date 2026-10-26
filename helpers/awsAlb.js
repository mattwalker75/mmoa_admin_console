// helpers/awsAlb.js — find the load balancer in front of the Web App's EC2
// instance, so the Website card's "Open website" goes to an address people
// can actually reach instead of the localhost in the Web App's config.json.
//
// Read-only ELBv2 calls, all covered by the mmoa_admin_console managed
// policy (mmoa_web_app_infra/templates/b_IAM.yaml):
//   DescribeTargetGroups → DescribeTargetHealth (is our instance in it?)
//   → DescribeLoadBalancers (DNS name) → DescribeListeners (http or https;
//   optional — without that permission the address is assumed to be http).
//
// Results are cached for 10 minutes (a failed lookup for 1 minute) so the
// pages that show the card aren't slowed down on every visit.

'use strict';

const { logAwsCall } = require('./awsLog');
const { clientKey } = require('./awsClientKey');

const TTL_OK_MS = 10 * 60 * 1000;
const TTL_ERR_MS = 60 * 1000;
const cache = new Map(); // key → { at, ttl, value }
const inflight = new Map(); // key → Promise (one lookup at a time per instance)
let _client = null, _clientKey = null;

function requireSdk() {
  try { return require('@aws-sdk/client-elastic-load-balancing-v2'); }
  catch (e) {
    const err = new Error('@aws-sdk/client-elastic-load-balancing-v2 is not installed. Run `npm install` in the admin console.');
    err.code = 'AWS_SDK_MISSING';
    throw err;
  }
}

function buildClient(ec2) {
  const sdk = requireSdk();
  const key = clientKey(ec2);
  if (_client && _clientKey === key) return _client;
  const opts = { region: ec2.region || 'us-east-1' };
  if (!ec2.runningInAws) {
    if (!ec2.accessKeyId || !ec2.secretAccessKey) {
      const err = new Error('AWS access key + secret are not configured (Settings → Web App).');
      err.code = 'AWS_CREDENTIALS_MISSING';
      throw err;
    }
    opts.credentials = { accessKeyId: ec2.accessKeyId, secretAccessKey: ec2.secretAccessKey };
  }
  _client = new sdk.ElasticLoadBalancingV2Client(opts);
  _clientKey = key;
  return _client;
}

function resetCache() { cache.clear(); inflight.clear(); _client = null; _clientKey = null; }

async function lookup(ec2) {
  const sdk = requireSdk();
  const client = buildClient(ec2);
  const instanceId = ec2.instanceId;

  // 1. Every instance-type target group in the region (paginated).
  const groups = [];
  let marker;
  do {
    const out = await logAwsCall('DescribeTargetGroups', { Marker: marker },
      () => client.send(new sdk.DescribeTargetGroupsCommand({ Marker: marker, PageSize: 400 })),
      r => `${(r.TargetGroups || []).length} target group(s)`);
    for (const g of out.TargetGroups || []) if ((g.TargetType || 'instance') === 'instance' && (g.LoadBalancerArns || []).length) groups.push(g);
    marker = out.NextMarker;
  } while (marker);

  // 2. Which of them have our instance registered.
  const mine = [];
  await Promise.all(groups.map(async (g) => {
    const out = await logAwsCall('DescribeTargetHealth', { TargetGroupArn: g.TargetGroupArn },
      () => client.send(new sdk.DescribeTargetHealthCommand({ TargetGroupArn: g.TargetGroupArn })),
      r => `${(r.TargetHealthDescriptions || []).length} target(s)`);
    const hit = (out.TargetHealthDescriptions || []).find(d => d.Target && d.Target.Id === instanceId);
    if (hit) mine.push({ group: g, health: (hit.TargetHealth && hit.TargetHealth.State) || 'unknown', reason: hit.TargetHealth && hit.TargetHealth.Description });
  }));
  if (!mine.length) return { found: false };

  // 3. The load balancers those groups belong to.
  const arns = [...new Set(mine.flatMap(m => m.group.LoadBalancerArns))];
  const lbOut = await logAwsCall('DescribeLoadBalancers', { LoadBalancerArns: arns },
    () => client.send(new sdk.DescribeLoadBalancersCommand({ LoadBalancerArns: arns })),
    r => (r.LoadBalancers || []).map(l => l.DNSName).join(', '));
  const lbs = (lbOut.LoadBalancers || []).slice().sort((a, b) =>
    (a.Scheme === 'internet-facing' ? 0 : 1) - (b.Scheme === 'internet-facing' ? 0 : 1) ||
    ((a.State && a.State.Code) === 'active' ? 0 : 1) - ((b.State && b.State.Code) === 'active' ? 0 : 1));
  const lb = lbs[0];
  if (!lb) return { found: false };

  // 4. http or https? (optional permission)
  let scheme = 'http', port = 80, listenersKnown = false;
  try {
    const lo = await logAwsCall('DescribeListeners', { LoadBalancerArn: lb.LoadBalancerArn },
      () => client.send(new sdk.DescribeListenersCommand({ LoadBalancerArn: lb.LoadBalancerArn })),
      r => (r.Listeners || []).map(l => `${l.Protocol}:${l.Port}`).join(', '));
    const ls = lo.Listeners || [];
    listenersKnown = true;
    const https = ls.find(l => l.Protocol === 'HTTPS');
    const http = ls.find(l => l.Protocol === 'HTTP');
    if (https) { scheme = 'https'; port = https.Port; }
    else if (http) { scheme = 'http'; port = http.Port; }
  } catch (e) { /* no permission — keep http:80 */ }
  const defaultPort = scheme === 'https' ? 443 : 80;
  const url = `${scheme}://${lb.DNSName}${port && port !== defaultPort ? ':' + port : ''}`;
  const m = mine.find(x => x.group.LoadBalancerArns.includes(lb.LoadBalancerArn)) || mine[0];
  return {
    found: true, url, name: lb.LoadBalancerName, dnsName: lb.DNSName, scheme: lb.Scheme,
    state: lb.State && lb.State.Code, targetGroup: m.group.TargetGroupName,
    health: m.health, healthReason: m.reason || '', listenersKnown,
    others: lbs.slice(1).map(l => l.DNSName)
  };
}

// → { found, url, name, health, … } or { found:false } ; throws on AWS errors.
async function findAlbForInstance(ec2) {
  if (!ec2 || !ec2.instanceId) return { found: false };
  const key = `${clientKey(ec2)}|${ec2.instanceId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    if (hit.error) throw hit.error;
    return hit.value;
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = lookup(ec2).then(
    (value) => { cache.set(key, { at: Date.now(), ttl: TTL_OK_MS, value }); return value; },
    (error) => { cache.set(key, { at: Date.now(), ttl: TTL_ERR_MS, error }); throw error; }
  ).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

module.exports = { findAlbForInstance, resetCache };
