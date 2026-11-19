// Bound one namespace while allowing every controller to overlap a replacement.
// This is a ceiling on declared requests, not a placement plan or a limit on usage.
function(workloads, namespace, runId)
local copies(w) = std.get(w.spec, if w.kind == 'Job' then 'parallelism' else 'replicas', 1);
local actors(w) = w.spec.template.spec.containers + std.get(w.spec.template.spec, 'initContainers', []);
// Workload overrides accept ordinary Kubernetes CPU and memory/storage quantities.
// Numeric output is in millicores for CPU and bytes for memory/storage.
local units = { Ki: 1024, Mi: std.pow(1024,2), Gi: std.pow(1024,3), Ti: std.pow(1024,4),
                Pi: std.pow(1024,5), Ei: std.pow(1024,6), k: 1e3, M: 1e6, G: 1e9, T: 1e12,
                P: 1e15, E: 1e18, m: 1e-3, u: 1e-6, n: 1e-9 };
local quantity(q) =
  local suffixes = [s for s in std.objectFields(units) if std.endsWith(q,s)];
  if std.length(suffixes)==0 then std.parseJson(q)
  else local s = suffixes[0]; std.parseJson(std.substr(q,0,std.length(q)-std.length(s))) * units[s];
local sum(xs) = std.foldl(function(a,b) a+b, xs, 0);
local total(key) = sum([2 * copies(w) * sum([
  std.ceil(quantity(std.get(a.resources.requests,key,'0')) * (if key == 'cpu' then 1000 else 1))
  for a in actors(w)]) for w in workloads]);
local meta(name) = { name: name, namespace: namespace, labels: { 'nightscout.org/run-id': runId } };
{
  resourceQuota: {
    apiVersion: 'v1', kind: 'ResourceQuota', metadata: meta('run-requests'),
    spec: { hard: {
      'requests.cpu': total('cpu') + 'm',
      'requests.memory': std.toString(total('memory')),
      'requests.ephemeral-storage': std.toString(total('ephemeral-storage')),
      pods: std.toString(sum([2 * copies(w) for w in workloads])),
    } },
  },
  limitRange: {
    apiVersion: 'v1', kind: 'LimitRange', metadata: meta('run-defaults'),
    spec: { limits: [{ type: 'Container', defaultRequest: {cpu:'25m',memory:'32Mi','ephemeral-storage':'16Mi'} }] },
  },
}
