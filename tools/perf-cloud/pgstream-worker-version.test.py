import ast,copy,datetime,importlib.util,inspect,json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent;s=importlib.util.spec_from_file_location('worker',HERE/'pgstream-worker.py');w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
VERSION=b'k6 v1.3.0+dirty (commit/5870e99ae8-dirty, go1.25.1, linux/amd64)\n'
class FreshVersion(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);(self.root/'work').mkdir();self.old=w.ROOT;w.ROOT=self.root;self.spec={'nonce':'a'*32,'k6Image':w.K6_VERSION_REFERENCE};self.effects=[];self.row=None;self.mode='success';self.foreign=None;self.image={'Id':w.K6_VERSION_IMAGE,'Architecture':'amd64','Os':'linux','RepoDigests':[w.K6_VERSION_REFERENCE],'Config':{'Entrypoint':['k6'],'Env':['PATH=/usr/bin']}}
 def tearDown(self):w.ROOT=self.old;self.tmp.cleanup()
 def actor(self,intent):
  return{'Id':'b'*64,'Name':'/'+intent['name'],'Image':intent['imageId'],'Created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'Config':{'Image':intent['image'],'Cmd':['version'],'Entrypoint':['k6'],'Env':['PATH=/usr/bin'],'User':'1001:1001','Labels':{'org.nightscout.external.owner':intent['nonce'],'org.nightscout.external.kind':'k6-version'}},'Mounts':[],'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,'CapDrop':['ALL'],'CapAdd':None,'Devices':[],'PidMode':'','IpcMode':'private','AutoRemove':True,'SecurityOpt':['no-new-privileges']}}
 def command(self,args,seconds=120,input=None):
  args=list(map(str,args));rows=[r for r in(self.row,self.foreign)if r is not None]
  if args[:2]==['docker','ps']:
   selector=args[args.index('--filter')+1];found=[r['Id']for r in rows if selector=='id='+r['Id']or selector=='name=^/'+r['Name'][1:]+'$'];return('\n'.join(found)+('\n'if found else'')).encode()
  if args[:2]==['docker','inspect']:return json.dumps([r for r in rows if r['Id']==args[2]]).encode()
  if args[:3]==['docker','rm','--force']:
   self.assertIsNotNone(self.row);self.assertEqual(args[3],self.row['Id'],'FOREIGN_ACTOR_MUST_NOT_BE_REMOVED');self.effects.append(('rm',args));self.row=None;return b''
  raise AssertionError('UNEXPECTED_COMMAND '+repr(args))
 def logged(self,name,args,seconds=120):
  if name=='k6-version-image':self.assertEqual(seconds,30);return json.dumps([self.image]).encode()
  self.assertEqual(name,'k6-version');self.assertEqual(seconds,60);self.assertEqual(args[-2:],[self.spec['k6Image'],'version']);self.assertEqual(args[args.index('--network')+1],'none');self.assertIn('--rm',args);self.assertIn('--read-only',args);self.assertEqual(args[args.index('--cap-drop')+1],'ALL');self.assertNotIn('-e',args);self.assertNotIn('-v',args);self.effects.append(('run',list(args)));intent=json.loads((self.root/'work/k6-version-intent.json').read_text());self.row=self.actor(intent)
  if self.mode!='missing-cid':Path(args[args.index('--cidfile')+1]).write_text(self.row['Id']+'\n')
  if self.mode in('wrong-absent-cid','wrong-foreign-cid'):
   Path(args[args.index('--cidfile')+1]).write_text('f'*64+'\n')
   if self.mode=='wrong-foreign-cid':self.foreign=copy.deepcopy(self.row);self.foreign.update(Id='f'*64,Name='/FOREIGN_VERSION_ACTOR');self.foreign['Config']['Labels']['org.nightscout.external.owner']='foreign'
   return VERSION
  if self.mode=='foreign':self.row['Config']['Labels']['org.nightscout.external.owner']='foreign';raise OSError('capture failed')
  if self.mode in('failed','missing-cid','capture-failed'):
   if self.mode=='failed':raise subprocess.CalledProcessError(7,args)
   if self.mode=='capture-failed':raise OSError('stdout capture failed')
   return VERSION
  self.row=None # Successful --rm completion removed its owned actor.
  return b'k6 v99.0.0\n'if self.mode=='wrong-version'else VERSION
 def execute(self):
  with patch.object(w,'command',side_effect=self.command),patch.object(w,'logged_command',side_effect=self.logged):return w.fresh_k6_version(self.spec)
 def proof(self):return json.loads((self.root/'work/k6-version-proof.json').read_text())
 def test_actual_dirty_version_and_config_id_pass(self):
  result=self.execute();self.assertEqual(result['status'],'FRESH_K6_VERSION_PASS');self.assertEqual(result['configImageId'],w.K6_VERSION_IMAGE);self.assertIn('v1.3.0+dirty',result['version']);self.assertEqual(result['cleanup']['status'],'EXACT_VERSION_ACTOR_ABSENT')
 def test_wrong_config_id_refuses_before_version_actor(self):
  self.image['Id']='sha256:'+'f'*64
  with self.assertRaisesRegex(RuntimeError,'PGCAL_K6_VERSION_CONFIG_ID'):self.execute()
  self.assertFalse(self.effects)
 def test_wrong_registry_reference_refuses_before_command(self):
  self.spec['k6Image']='grafana/k6@sha256:'+'f'*64
  with self.assertRaisesRegex(RuntimeError,'PGCAL_K6_VERSION_SOURCE'):self.execute()
  self.assertFalse(self.effects)
 def test_wrong_version_is_not_success(self):
  self.mode='wrong-version'
  with self.assertRaisesRegex(RuntimeError,'PGCAL_K6_VERSION_MISMATCH'):self.execute()
  self.assertEqual(self.proof()['status'],'FAIL');self.assertEqual(self.proof()['cleanup']['status'],'EXACT_VERSION_ACTOR_ABSENT')
 def test_failed_version_still_cleans_exact_owned_cid(self):
  self.mode='failed'
  with self.assertRaises(subprocess.CalledProcessError):self.execute()
  self.assertEqual([x[0]for x in self.effects],['run','rm']);self.assertIsNone(self.row);self.assertEqual(self.proof()['status'],'FAIL')
 def test_missing_cid_still_cleans_owned_name(self):
  self.mode='missing-cid'
  with self.assertRaisesRegex(RuntimeError,'PGCAL_K6_VERSION_CID_MISSING'):self.execute()
  self.assertEqual([x[0]for x in self.effects],['run','rm']);self.assertEqual(self.proof()['cleanup']['capture'],'NAME_FALLBACK_OR_NO_CREATION')
 def test_capture_failure_still_cleans_owned_actor(self):
  self.mode='capture-failed'
  with self.assertRaises(OSError):self.execute()
  self.assertIsNone(self.row);self.assertEqual([x[0]for x in self.effects],['run','rm'])
 def test_foreign_actor_not_removed_or_false_success(self):
  self.mode='foreign'
  with self.assertRaises(OSError):self.execute()
  self.assertEqual([x[0]for x in self.effects],['run']);self.assertIn('PGCAL_K6_VERSION_OWNER',self.proof()['cleanupError']);self.assertEqual(self.proof()['status'],'FAIL')
 def wrong_valid_capture(self,mode):
  self.mode=mode
  with self.assertRaisesRegex(RuntimeError,'PGCAL_K6_VERSION_(CID_CHANGED|OWNER)'):self.execute()
  self.assertIsNone(self.row,'owned planned-name actor must be removed despite capture contradiction')
  if mode=='wrong-foreign-cid':self.assertEqual(self.foreign['Id'],'f'*64,'foreign CID remains untouched')
  self.assertEqual([e[0]for e in self.effects],['run','rm']);proof=self.proof();self.assertEqual(proof['status'],'FAIL');self.assertIsNotNone(proof['cleanupError']);self.assertEqual(proof['cleanup']['removedOwnedIds'],['b'*64])
 def cid_only_cleanup_red(self,mode):
  # Authored defect: trust a syntactically valid CID as the only lookup, losing
  # independent planned-name cleanup when capture is absent or foreign.
  raw=inspect.getsource(w._cleanup_version_actor);node=ast.parse(raw).body[0]
  loop=next(n for n in node.body if isinstance(n,ast.For) and isinstance(n.target,ast.Name) and n.target.id=='reference')
  expected=ast.parse("([valid_cid] if valid_cid else []) + [intent['name']]",mode='eval').body
  self.assertEqual(ast.dump(loop.iter),ast.dump(expected),'control must mutate the current independent CID/name lookup')
  loop.iter=ast.parse("[valid_cid or intent['name']]",mode='eval').body
  scope=w.__dict__.copy();scope['command']=self.command
  mutant=ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[]));exec(compile(mutant,'authored-cid-only-cleanup','exec'),scope)
  intent={'name':'nsversion-'+self.spec['nonce'][:12],'nonce':self.spec['nonce'],'image':self.spec['k6Image'],'imageId':w.K6_VERSION_IMAGE,'entrypoint':['k6'],'environment':['PATH=/usr/bin'],'notBefore':__import__('time').time()};self.row=self.actor(intent);self.foreign=None
  if mode=='wrong-foreign-cid':self.foreign=copy.deepcopy(self.row);self.foreign.update(Id='f'*64,Name='/FOREIGN_VERSION_ACTOR');self.foreign['Config']['Labels']['org.nightscout.external.owner']='foreign'
  cid=self.root/'work/mutant-control.cid';cid.write_text('f'*64)
  with patch.object(w,'command',side_effect=self.command):
   with self.assertRaises(RuntimeError):scope['_cleanup_version_actor'](intent,cid)
  with self.assertRaises(AssertionError):self.assertIsNone(self.row,'MUTANT_RED: planned-name actor leaked')
  self.assertFalse(self.effects);self.row=None;self.foreign=None
 def test_valid_wrong_absent_cid_mutant_red_restored_owned_cleanup_green(self):
  self.cid_only_cleanup_red('wrong-absent-cid');self.wrong_valid_capture('wrong-absent-cid')
 def test_valid_wrong_foreign_cid_mutant_red_restored_owned_cleanup_green(self):
  self.cid_only_cleanup_red('wrong-foreign-cid');self.wrong_valid_capture('wrong-foreign-cid')
if __name__=='__main__':unittest.main()
