"""Source-only deployment timeout controls; no provider/application effects."""
import importlib.util,time,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('worker',Path(__file__).with_name('pgstream-worker.py'))
w=importlib.util.module_from_spec(s);s.loader.exec_module(w)

class Window(unittest.TestCase):
 def test_original_marker_reserve_and_cold_cutoff_survive_aging(self):
  spec={'reportMode':'discovery','expiresAt':10000};marker={'expires_at':9500}
  self.assertEqual(w.deploy_seconds(spec,marker,now=1000),7960)
  self.assertEqual(w.deploy_seconds(spec,marker,now=8900),60)
  self.assertEqual(w.deploy_seconds({**spec,'lastNewPointAt':1200},marker,now=1000),200)
  for value in (8960,9000):
   with self.assertRaisesRegex(RuntimeError,'PGCAL_DEADLINE'):w.deploy_seconds(spec,marker,now=value)
  with self.assertRaisesRegex(RuntimeError,'PGCAL_DEADLINE'):w.deploy_seconds({**spec,'lastNewPointAt':999},marker,now=1000)
  for expiry in (float('inf'),float('nan'),20000):
   with self.assertRaisesRegex(RuntimeError,'PGCAL_DEADLINE'):w.deploy_seconds({**spec,'expiresAt':expiry},{'expires_at':expiry},now=1000)
  self.assertEqual(w.deploy_seconds({'expiresAt':10000},marker,now=1000),2400)

 def test_actual_deploy_dispatch_uses_original_remaining_window(self):
  import sys,types,io
  spec={'reportMode':'discovery','expiresAt':10000,'lastNewPointAt':8000}
  # action_main validates custody through context before dispatch.
  with patch.object(sys,'argv',['worker','deploy','sut']),patch.object(w,'context',return_value=spec),patch.object(w,'read',return_value={'expires_at':9500}),patch.object(w.time,'time',return_value=1000),patch.object(w,'worker',return_value=b'') as run,patch.object(sys,'stdout',types.SimpleNamespace(buffer=io.BytesIO())):
   w.action_main()
  self.assertEqual(run.call_args.args[1],7000)

if __name__=='__main__':unittest.main()
