"""Actual bounded driver archive round trip; no Docker/SSH/provider effects."""
import importlib.util,json,sys,tempfile,types,unittest,tarfile,io,os,stat
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('worker_results',Path(__file__).with_name('pgstream-worker.py'));w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
class Results(unittest.TestCase):
 def test_worker_forwards_changed_population_rate_duration_and_client_config(self):
  spec={'pins':{'core':'a'*40,'deploy':'b'*40,'app':'sha256:'+'c'*64,'postgres':'sha256:'+'d'*64},'completionContract':'evaluator-work-v2','diagnostics':'on','tenants':271,'primerConcurrency':3,'cadence':{'warmupSeconds':2,'idleSeconds':5,'loadSeconds':45,'accel':1,'hotFactor':1,'samplerIntervalSeconds':2,'probeEveryMs':1000,'socketsPerTenant':3,'offeredRps':73}}
  args=w.prepare_arguments(spec)
  for flag,value in [('--tenants','271'),('--offered-rps','73'),('--load-seconds','45'),('--primer-concurrency','3'),('--probe-every-ms','1000'),('--sockets-per-tenant','3')]:self.assertEqual(args[args.index(flag)+1],value)
 def run_fixture(self,missing=(),corrupt=False,mode='discovery',native_uid=False,blocked=None,race=False):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'work/cell/load').mkdir(parents=True);(root/'traffic/load').mkdir(parents=True);(root/'traffic/control').mkdir()
   spec={'reportMode':mode};ownership=[]
   def descriptor_owner(fd,uid,gid):
    st=os.fstat(fd);ownership.append((st.st_dev,st.st_ino,uid,gid))
   with patch.object(w,'ROOT',root),(nullcontext() if native_uid else patch.object(w.os,'chown')) as chown,(nullcontext() if native_uid else patch.object(w.os,'fchown',side_effect=descriptor_owner)),patch.dict(sys.modules,{'component_cases':types.SimpleNamespace(plan=None,result_names=None)}):
    paths=w.client_result_paths(spec)
    for name,file in paths.items():
     if name not in missing:file.write_text(json.dumps({'receipt':name}))
    w.export_client_results(spec)
    if corrupt:
     with tarfile.open(root/'work/client.tar') as tar:items=[(m,tar.extractfile(m).read()) for m in tar.getmembers()]
     with tarfile.open(root/'work/client.tar','w') as tar:
      for member,data in items:
       if member.name=='probe.json':data=b'changed';member.size=len(data)
       tar.addfile(member,io.BytesIO(data))
    if blocked:
     manifest=root/'work/cell/load/generator-result-manifest.json';outside=root/'outside.json'
     if blocked=='existing':manifest.write_text('retained synthetic receipt')
     elif blocked=='dangling':manifest.symlink_to(outside)
     elif blocked=='linked-existing':outside.write_text('outside unchanged');outside.chmod(0o640);manifest.symlink_to(outside)
     else:self.fail('unknown fixture')
     if not native_uid:chown.reset_mock()
     with self.assertRaisesRegex(RuntimeError,'PGCAL_RESULT_EXISTS'):w.import_client_results(spec)
     if not native_uid:chown.assert_not_called();self.assertEqual(ownership,[])
     self.assertFalse((root/'work/cell/load/probe.json').exists())
     if blocked=='linked-existing':self.assertEqual(outside.read_text(),'outside unchanged');self.assertEqual(stat.S_IMODE(outside.stat().st_mode),0o640)
     else:self.assertFalse(outside.exists())
     if blocked=='existing':self.assertEqual(manifest.read_text(),'retained synthetic receipt')
     else:self.assertTrue(manifest.is_symlink())
     return
    if corrupt:
     with self.assertRaisesRegex(RuntimeError,'PGCAL_CLIENT_ARCHIVE_HASH'):w.import_client_results(spec)
     self.assertFalse((root/'work/cell/load/probe.json').exists());return
    if race:
     manifest=root/'work/cell/load/generator-result-manifest.json';outside=root/'outside-race.json';real_open=os.open
     def raced_open(file,flags,*args,**kwargs):
      if Path(file)==manifest:manifest.symlink_to(outside)
      return real_open(file,flags,*args,**kwargs)
     with patch.object(w.os,'open',side_effect=raced_open):
      with self.assertRaises(FileExistsError):w.import_client_results(spec)
     self.assertTrue(manifest.is_symlink());self.assertFalse(outside.exists());self.assertEqual(ownership,[])
     return
    previous_umask=os.umask(0o277)
    try:w.import_client_results(spec)
    finally:os.umask(previous_umask)
    manifest=root/'work/cell/load/generator-result-manifest.json'
    self.assertEqual(stat.S_IMODE(manifest.stat().st_mode),0o600)
    if not native_uid:
     st=manifest.stat();self.assertEqual(ownership,[(st.st_dev,st.st_ino,1000,1000)])
     self.assertFalse(any(call.args[0]==manifest for call in chown.call_args_list))
    if native_uid:
     self.assertEqual((manifest.stat().st_uid,manifest.stat().st_gid),(1000,1000))
     # The runtime principal reads the exact receipt through actual POSIX modes.
     for directory in (root,root/'work',root/'work/cell',root/'work/cell/load'):directory.chmod(0o755)
     pid=os.fork()
     if pid==0:
      try:
       os.setgroups([]);os.setgid(1000);os.setuid(1000);json.loads(manifest.read_text());os._exit(0)
      except BaseException:os._exit(1)
     _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),0)
    receipt=json.loads(manifest.read_text())
    self.assertEqual(set(receipt['missing']),set(missing))
    for name in set(paths)-set(missing):self.assertEqual(json.loads((root/'work/cell/load'/name).read_text()),{'receipt':name})
 @unittest.skipUnless(os.geteuid()==0,'native root importer → UID1000 read requires root; custody assertions run unprivileged')
 def test_actual_root_imported_manifest_readable_by_runtime_uid(self):self.run_fixture(native_uid=True)
 def test_existing_manifest_or_symlink_refuses_before_any_import(self):
  for kind in ('existing','dangling','linked-existing'):
   with self.subTest(kind=kind):self.run_fixture(blocked=kind)
 def test_dangling_symlink_installed_after_census_cannot_redirect_creation(self):self.run_fixture(race=True)
 def test_receipts_land_at_exact_reducer_paths(self):self.run_fixture()
 def test_missing_partial_receipts_remain_missing(self):self.run_fixture(missing=('probe.json','probe-accounting.json','generator-processes.json','generator-public-result.json'))
 def test_corrupted_copy_refuses_before_any_import(self):self.run_fixture(corrupt=True)
 def test_strict_missing_required_refuses_and_optional_absence_is_recorded(self):
  with self.assertRaisesRegex(RuntimeError,'PGCAL_CLIENT_RESULT_BOUND'):self.run_fixture(missing=('probe.json',),mode='strict')
  self.run_fixture(missing=tuple(w.OPTIONAL_RESULTS),mode='strict')
if __name__=='__main__':unittest.main()
