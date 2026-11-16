import copy,importlib.util,json,sys,tempfile,types,unittest,hashlib
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('worker',Path(__file__).with_name('pgstream-worker.py'));w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
class Capture(unittest.TestCase):
 def test_exact_container_bytes_binding_and_changed_incarnation_control(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d);cell=root/'work/cell';cell.mkdir(parents=True)
   m={'owner':'a'*32,'hostIdentity':'b'*64,'pair':{'core':'c'*40,'deploy':'d'*40},'imageId':'sha256:'+'e'*64,'instrument':{'sha256':'f'*64}}
   (cell/'owner.json').write_text(json.dumps(m));(cell/'frozen.compose.json').write_text(json.dumps({'services':{'api':{},'postgres':{}}}))
   row={'Id':'1'*64,'Image':m['imageId'],'State':{'StartedAt':'2026-11-14T00:00:00Z'},'Config':{'Labels':{'com.docker.compose.service':'api','owned':m['owner']}}}
   def capture(target,config,argv,**limits):
    self.assertEqual(list(config['services']),['api']);self.assertEqual(argv('api'),['docker','logs','--tail','1000',row['Id']]);self.assertEqual(limits['seconds'],1)
    (target/'api.log').write_bytes(b'NS_M7_DIAGNOSTICS synthetic\n');return {'roles':[{'role':'api','truncated':False}]}
   a=types.SimpleNamespace(document=lambda p:json.loads(p.read_text()),assert_owned=lambda value:self.assertEqual(value,m),profile_provenance=types.SimpleNamespace(capture_logs=capture),OWNER='owned')
   with patch.object(w,'ROOT',root),patch.dict(sys.modules,{'app':types.SimpleNamespace(a=a)}):
    def run(changed=False):
     other=copy.deepcopy(row)
     if changed:other['State']['StartedAt']='2026-11-14T00:01:00Z'
     a.resources=unittest.mock.Mock(side_effect=[[row],[other]]);w.capture_role_logs();return json.loads((cell/'role-logs/capture.json').read_text())
    good=run();self.assertEqual(good['status'],'CAPTURED');self.assertEqual(good['capture']['roles'][0]['logSha256'],hashlib.sha256((cell/'role-logs/api.log').read_bytes()).hexdigest())
    self.assertEqual(run(True)['status'],'UNMEASURED_IDENTITY_CHANGED');self.assertEqual(run()['status'],'CAPTURED')
 def test_capture_failure_is_explicit_unknown_and_does_not_block_other_evidence(self):
  with tempfile.TemporaryDirectory()as d:
   root=Path(d);cell=root/'work/cell';cell.mkdir(parents=True);(cell/'owner.json').write_text('{}')
   with patch.object(w,'ROOT',root),patch.dict(sys.modules,{'app':types.SimpleNamespace(a=types.SimpleNamespace(document=lambda p:(_ for _ in ()).throw(RuntimeError('synthetic'))))}):w.capture_role_logs()
   self.assertEqual(json.loads((cell/'role-logs/capture.json').read_text())['status'],'UNMEASURED')
if __name__=='__main__':unittest.main()
