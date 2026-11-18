#!/usr/bin/env node
'use strict';

// Kubernetes fit check: one tracked admission step that runs before a run
// creates its Namespace. It reads recorded Kubernetes API list responses (no
// cluster call), never evicts and never creates anything. It prints the
// effective numbers and exits non-zero with K8S_FIT_REFUSED when the run's
// requested CPU and memory do not fit on the reserved worker after its current
// non-terminated Pod requests and the protected reserve.
//
// Protected reserve (unchanged from the operator commissioner's rule): CPU
// max(0.25 core, 15% of allocatable); memory max(512 MiB, 20% of allocatable).
// Fit per dimension: max(peer requests, observed usage) + request + reserve
// <= allocatable. Observed usage is optional; without it peer requests are used.
//
// Usage:
//   node fit-check.js --request request.json --nodes nodes.json --pods pods.json
//     --node <worker name> [--usage usage.json] [--out result.json]
// request.json: {"cpu": "2500m", "memory": "2672Mi"}
// usage.json:   {"cpu": "1200m", "memory": "2983Mi"}  (observed peak, optional)
const fs = require('node:fs');

const MIB = 1024 ** 2;
const DIMS = Object.freeze(['cpu', 'memory']);
const fail = (code, detail) => Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) });

// Kubernetes resource quantities: CPU in cores, memory in bytes.
const SUFFIX = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
function quantity (value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const found = typeof value === 'string' && /^([0-9]+(?:\.[0-9]+)?)(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(value);
  if (!found) throw fail('K8S_FIT_QUANTITY_INVALID', String(value));
  return Number(found[1]) * (found[2] ? SUFFIX[found[2]] : 1);
}
function resources (list) {
  const total = { cpu: 0, memory: 0 };
  for (const value of list) for (const d of DIMS) total[d] += quantity(value?.[d] ?? 0);
  return total;
}
const add = (a, b) => ({ cpu: a.cpu + b.cpu, memory: a.memory + b.memory });
const max = (a, b) => ({ cpu: Math.max(a.cpu, b.cpu), memory: Math.max(a.memory, b.memory) });

// The scheduler's effective Pod request: regular containers plus restartable
// (sidecar) init containers, or the largest ordinary init container together
// with the sidecars started before it, whichever is larger, plus overhead.
function podRequest (pod) {
  const spec = pod.spec || {}, requests = c => resources([c.resources?.requests || {}]);
  let sidecars = { cpu: 0, memory: 0 }, init = { cpu: 0, memory: 0 };
  for (const c of spec.initContainers || []) {
    if (c.restartPolicy === 'Always') sidecars = add(sidecars, requests(c));
    else init = max(init, add(requests(c), sidecars));
  }
  const running = add(resources((spec.containers || []).map(c => c.resources?.requests || {})), sidecars);
  return add(max(running, init), resources([spec.overhead || {}]));
}
function reserve (allocatable) {
  return { cpu: Math.max(0.25, allocatable.cpu * 0.15), memory: Math.max(512 * MIB, allocatable.memory * 0.2) };
}
function check ({ request, nodes, pods, node, usage }) {
  const want = resources([request]);
  const item = (nodes.items || []).find(row => row.metadata?.name === node);
  if (!item) throw fail('K8S_FIT_NODE_ABSENT');
  const allocatable = resources([item.status?.allocatable || {}]);
  const peers = (pods.items || []).filter(pod => pod.spec?.nodeName === node && !['Succeeded', 'Failed'].includes(pod.status?.phase));
  const peerRequests = peers.map(podRequest).reduce(add, { cpu: 0, memory: 0 });
  const committed = usage ? max(peerRequests, resources([usage])) : peerRequests;
  const protectedReserve = reserve(allocatable), refusals = [], remaining = {};
  for (const d of DIMS) {
    remaining[d] = allocatable[d] - committed[d] - protectedReserve[d] - want[d];
    if (committed[d] + want[d] + protectedReserve[d] > allocatable[d]) refusals.push(d + ' headroom');
  }
  const conditions = Object.fromEntries((item.status?.conditions || []).map(c => [c.type, c.status]));
  if (conditions.Ready !== 'True' || ['MemoryPressure', 'DiskPressure', 'PIDPressure'].some(c => conditions[c] === 'True') || item.spec?.unschedulable) refusals.push('node health/pressure/unschedulable');
  const mib = value => Math.round(value / MIB * 1000) / 1000;
  return Object.freeze({ version: 1, node, fits: refusals.length === 0, refusals,
    rule: 'max(peer requests, observed usage) + request + reserve <= allocatable; reserve cpu=max(0.25,15%) memory=max(512Mi,20%)',
    effective: { cpu: { allocatable: allocatable.cpu, peerRequests: peerRequests.cpu, observedUsage: usage ? resources([usage]).cpu : null, reserve: protectedReserve.cpu, request: want.cpu, remainingAfterReserve: remaining.cpu },
      memoryMiB: { allocatable: mib(allocatable.memory), peerRequests: mib(peerRequests.memory), observedUsage: usage ? mib(resources([usage]).memory) : null, reserve: mib(protectedReserve.memory), request: mib(want.memory), remainingAfterReserve: mib(remaining.memory) } },
    peerPods: peers.length });
}
// Runs `create` (for example, Namespace creation) only after the fit passes.
async function admit (input, create) {
  const result = check(input);
  if (!result.fits) throw Object.assign(fail('K8S_FIT_REFUSED'), { result });
  return { result, created: await create(result) };
}
function main (argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--(request|nodes|pods|node|usage|out)$/.test(argv[i]) || argv[i + 1] === undefined) throw fail('K8S_FIT_USAGE');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.request || !args.nodes || !args.pods || !args.node) throw fail('K8S_FIT_USAGE');
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = check({ request: read(args.request), nodes: read(args.nodes), pods: read(args.pods), node: args.node, ...(args.usage ? { usage: read(args.usage) } : {}) });
  const text = JSON.stringify(result, null, 2) + '\n';
  if (args.out) fs.writeFileSync(args.out, text, { mode: 0o600 });
  process.stdout.write(text);
  if (!result.fits) { console.error('K8S_FIT_REFUSED: ' + result.refusals.join(', ')); process.exitCode = 2; }
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.code || 'K8S_FIT_FAILED'); process.exitCode = 1; }
}
module.exports = { quantity, podRequest, reserve, check, admit };
