"""Paired worker argv / actual pinned helper parser, with no runtime effects."""
import importlib.util,json,os,sys,unittest,subprocess
from pathlib import Path
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('topology_worker',HERE/'pgstream-worker.py');worker=importlib.util.module_from_spec(s);s.loader.exec_module(worker)

class Topology(unittest.TestCase):
 def test_exact_selector_forwarding_and_receipt_refusal(self):
  selected={'pins':{'core':'a'*40,'deploy':'b'*40,'app':'sha256:'+'c'*64,'postgres':'sha256:'+'d'*64},'completionContract':'evaluator-work-v2','diagnostics':'on','tenants':2,'cadence':{'warmupSeconds':2,'idleSeconds':2,'loadSeconds':6,'accel':1,'hotFactor':1,'samplerIntervalSeconds':2,'probeEveryMs':1000,'socketsPerTenant':2,'offeredRps':7},'pgstreamTopology':'external-service-v1','diagnosticResourceProfile':'local-diagnostic-external-pgstream-4cpu-8g-v1','receipt':{'remotePgstreamTopology':'external-service-v1','remoteDiagnosticResourceProfile':'local-diagnostic-external-pgstream-4cpu-8g-v1'}}
  args=list(map(str,worker.prepare_arguments(selected)))
  for flag,expected in [('--pgstream-topology',selected['pgstreamTopology']),('--diagnostic-resource-profile',selected['diagnosticResourceProfile'])]:self.assertEqual(args[args.index(flag)+1],expected)
  for key in ['pgstreamTopology','diagnosticResourceProfile']:
   broken=dict(selected);del broken[key]
   with self.assertRaisesRegex(RuntimeError,'EXPLICIT_TOPOLOGY'):worker.prepare_arguments(broken)
  broken={**selected,'receipt':{}}
  with self.assertRaisesRegex(RuntimeError,'TOPOLOGY_RECEIPT'):worker.prepare_arguments(broken)
  root=os.environ.get('PGCAL_TOPOLOGY_HELPER')
  if not root:self.skipTest('set PGCAL_TOPOLOGY_HELPER for actual source parser checks')
  sys.path.insert(0,str(Path(root)/'tools/mt-bench/m7-joined'))
  import adapter,stream_topology
  cli=args[2:];remaining=cli[cli.index('--core-repo'):]
  parsed=adapter.parser().parse_args(['prepare','--directory','/tmp/synthetic-remote-topology',*remaining])
  self.assertEqual(parsed.pgstream_topology,selected['pgstreamTopology']);self.assertEqual(parsed.diagnostic_resource_profile,selected['diagnosticResourceProfile'])
  # A dropped or altered selector must not satisfy the reviewed request.
  for flag,attr in [('--pgstream-topology','pgstream_topology'),('--diagnostic-resource-profile','diagnostic_resource_profile')]:
   i=remaining.index(flag);missing=remaining[:i]+remaining[i+2:];other=adapter.parser().parse_args(['prepare','--directory','/tmp/synthetic-remote-topology',*missing]);self.assertNotEqual(getattr(other,attr),getattr(parsed,attr))
  manifest={'pgstreamTopology':parsed.pgstream_topology,'profile':'pgstream-sample'}
  self.assertEqual(stream_topology.expected_processes(manifest),{'evaluator':('node',),'pgstream':('pgstream',)})
  config={'services':{'evaluator':{'command':['node','evaluator']},'pgstream':{'command':stream_topology.EXTERNAL_COMMAND}}};stream_topology.verify_config(manifest,config)
  del config['services']['pgstream']
  with self.assertRaisesRegex(RuntimeError,'EXTERNAL_SERVICE_REQUIRED'):stream_topology.verify_config(manifest,config)
  core=os.environ.get('PGCAL_TOPOLOGY_CORE')
  if core:
   source=os.environ['PGCAL_TOPOLOGY_CORE_COMMIT'];schema=json.loads(subprocess.check_output(['git','-C',core,'show',source+':lib/server/serve/plan-contract/schema/evaluator.schema.json']))
   stream_topology.verify_source(manifest,schema)
   del schema['properties']['pgstream']
   with self.assertRaisesRegex(RuntimeError,'EXTERNAL_SOURCE_REQUIRED'):stream_topology.verify_source(manifest,schema)

if __name__=='__main__':unittest.main()
