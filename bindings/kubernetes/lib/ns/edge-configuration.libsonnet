// Source-bound nginx numeric projection. The Unix nginx process table has
// 1024 child slots shared by workers/helpers/reload generations; available slots
// and effective OS descriptors remain environment observations, not capacity.
local fields = ['workerProcesses', 'workerConnections'];
{
  selected(c)::
    assert std.type(c) == 'object' : 'EDGE_CONFIGURATION';
    assert std.length([k for k in std.objectFields(c) if !std.member(['serviceType', 'port'] + fields, k)]) == 0 : 'EDGE_CONFIGURATION_FIELDS';
    assert !std.objectHas(c, 'workerProcesses') || (std.type(c.workerProcesses) == 'number' && std.floor(c.workerProcesses) == c.workerProcesses && c.workerProcesses >= 1 && c.workerProcesses <= 1024) : 'EDGE_WORKER_PROCESSES';
    assert !std.objectHas(c, 'workerConnections') || (std.type(c.workerConnections) == 'number' && std.floor(c.workerConnections) == c.workerConnections && c.workerConnections >= 1 && c.workerConnections <= 9007199254740991) : 'EDGE_WORKER_CONNECTIONS';
    std.length([k for k in fields if std.objectHas(c, k)]) > 0,
  requested(c):: if !self.selected(c) then null else { [k]: c[k] for k in fields if std.objectHas(c, k) },
  record(c)::
    local r = self.requested(c);
    if r == null then null else {
      requested: r,
      effective: {
        workerProcesses: if std.objectHas(r, 'workerProcesses') then r.workerProcesses else 'auto',
        workerConnections: if std.objectHas(r, 'workerConnections') then r.workerConnections else 1024,
      },
      sourceAsset: 'assets/nginx.conf',
      descriptorLimit: 'INHERITED_OS_UNMEASURED',
    },
  render(source, c)::
    local r = self.requested(c);
    if r == null then source else
      assert std.length(std.findSubstr('worker_processes', source)) == 1 && std.length(std.findSubstr('worker_connections', source)) == 1 && std.length(std.findSubstr('worker_processes auto;', source)) == 1 && std.length(std.findSubstr('worker_connections 1024;', source)) == 1 : 'EDGE_SOURCE_SHAPE';
      local workers = if std.objectHas(r, 'workerProcesses') then std.strReplace(source, 'worker_processes auto;', 'worker_processes ' + std.toString(r.workerProcesses) + ';') else source;
      if std.objectHas(r, 'workerConnections') then std.strReplace(workers, 'worker_connections 1024;', 'worker_connections ' + std.toString(r.workerConnections) + ';') else workers,
}
