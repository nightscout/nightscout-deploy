#!/usr/bin/env python3
"""Export a clean commit, not a moving worktree. No cluster or network access."""
import argparse, hashlib, io, json, pathlib, subprocess, tarfile
p=argparse.ArgumentParser();p.add_argument('--commit',default='HEAD');p.add_argument('--output',required=True);a=p.parse_args()
repo=pathlib.Path(__file__).resolve().parents[3]
def git(*args):return subprocess.check_output(['git',*args],cwd=repo)
commit=git('rev-parse',a.commit+'^{commit}').decode().strip()
if git('status','--porcelain','--','bindings/kubernetes').strip():raise SystemExit('REFUSED: binding worktree is not clean')
out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=False)
archive=git('archive','--format=tar',commit,'bindings/kubernetes');(out/'package.tar').write_bytes(archive)
package=out/'package';package.mkdir()
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    for item in tar:
        parts=pathlib.PurePosixPath(item.name).parts[2:]
        if not parts:continue
        if item.issym() or item.islnk() or '..' in parts:raise SystemExit('REFUSED: unsafe package member')
        dest=package.joinpath(*parts)
        if item.isdir():dest.mkdir(parents=True,exist_ok=True)
        elif item.isfile():
            dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(tar.extractfile(item).read());dest.chmod(item.mode)
files={str(f.relative_to(package)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(package.rglob('*')) if f.is_file()}
receipt={'schemaVersion':1,'bindingCommit':commit,'archiveSha256':hashlib.sha256(archive).hexdigest(),'filesSha256':files,'scope':'Immutable local package; image publication and cluster/capacity acceptance NOT_GRANTED'}
(out/'package-receipt.json').write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n')
# An ordinary private-style consumer has no access to sibling Compose source.
consumer=out/'consumer';env=consumer/'environments/fixture';env.mkdir(parents=True)
(consumer/'jsonnetfile.json').write_text('{"version":1,"dependencies":[],"legacyImports":true}\n')
(env/'spec.json').write_text((package/'environments/synthetic/spec.json').read_text().replace('environments/synthetic','environments/fixture'))
inputs=json.loads((package/'environments/synthetic/inputs.json').read_text());inputs['bindingIdentity']=commit
(env/'inputs.json').write_text(json.dumps(inputs,indent=2)+'\n')
(env/'main.jsonnet').write_text("local ns = import '../../../package/lib/ns/nightscout.libsonnet';\nns.new(import 'inputs.json')\n")
def tk(*args):return subprocess.check_output(['tk',*args,'environments/fixture'],cwd=consumer)
first=tk('eval');second=tk('eval')
if first!=second:raise SystemExit('FAIL portable eval is nondeterministic')
show=tk('show','--dangerous-allow-redirect');show2=tk('show','--dangerous-allow-redirect')
if show!=show2:raise SystemExit('FAIL portable show is nondeterministic')
(out/'manifests.json').write_bytes(first);(out/'manifests.yaml').write_bytes(show)
(out/'fixture-inventory.json').write_bytes(subprocess.check_output(['tk','eval','environments/fixture','-e','inventory'],cwd=consumer))
subprocess.run(['node',str(package/'check/invariants.js'),'--root',str(consumer),'--env','environments/fixture'],check=True)
print('ok   portable package: clean commit, complete assets, independent consumer, deterministic eval/show')
print(json.dumps({'bindingCommit':commit,'archiveSha256':receipt['archiveSha256'],'output':str(out)}))
