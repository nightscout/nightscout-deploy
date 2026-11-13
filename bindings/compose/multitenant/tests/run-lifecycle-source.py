#!/usr/bin/env python3
"""Exact-commit recording-IO fixture. No Docker/PG/native acceptance effects."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def claim_output(root):
    if not root.is_absolute():
        raise ValueError('absolute output root required')
    root.mkdir(mode=0o700, exist_ok=False)
    return root


def archive(tree, commit, destination):
    actual = subprocess.check_output(['git', 'rev-parse', commit + '^{commit}'], cwd=tree, text=True).strip()
    if actual != commit:
        raise ValueError('full exact commit required')
    raw = subprocess.check_output(['git', 'archive', commit], cwd=tree)
    with tarfile.open(fileobj=io.BytesIO(raw)) as capture:
        capture.extractall(destination, filter='data')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['core-tree', 'core-commit', 'companion-tree', 'companion-commit', 'output-root']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    root = claim_output(Path(args.output_root))
    core_tree, companion_tree = Path(args.core_tree), Path(args.companion_tree)
    archive(core_tree, args.core_commit, root / 'source')
    archive(companion_tree, args.companion_commit, root / 'companion')
    joined = root / 'source'
    shutil.rmtree(joined / 'deploy' / 'multitenant')
    shutil.copytree(root / 'companion' / 'bindings' / 'compose' / 'multitenant', joined / 'deploy' / 'multitenant')
    os.symlink(core_tree / 'node_modules', joined / 'node_modules')
    logs = root / 'logs'
    logs.mkdir()
    tests = sorted((joined / 'deploy' / 'multitenant' / 'tests').glob('connection-budget*.test.js'))
    tests += sorted((joined / 'deploy' / 'multitenant' / 'tests').glob('lifecycle-operator*.test.js'))
    commands = [(test.name, ['node', str(test)]) for test in tests]
    commands += [('core-focused', ['node', str(joined / 'node_modules' / 'mocha' / 'bin' / 'mocha.js'),
                                   'tests/connection-admission.test.js', 'tests/tenant-restore-resume.test.js',
                                   'tests/operation-cohort-peers.test.js', '--reporter', 'spec'])]
    results = []
    for name, command in commands:
        with (logs / (name + '.log')).open('xb') as output:
            result = subprocess.run(command, cwd=joined, stdout=output, stderr=subprocess.STDOUT, timeout=120)
        results.append({'name': name, 'command': command, 'exitCode': result.returncode})
    files = {str(f.relative_to(joined)): hashlib.sha256(f.read_bytes()).hexdigest()
             for folder in ['deploy/multitenant', 'lib/storage', 'lib/tenant-lifecycle', 'lib/server/serve', 'lib/server/internal-api/contracts']
             for f in (joined / folder).rglob('*') if f.is_file()}
    receipt = {'scope': 'SOURCE_PROTOCOL_ONLY_NOT_NATIVE_ACCEPTANCE', 'coreCommit': args.core_commit,
               'companionCommit': args.companion_commit,
               'node': subprocess.check_output(['node', '--version'], text=True).strip(),
               'dependencyLockSha256': hashlib.sha256((joined / 'package-lock.json').read_bytes()).hexdigest(),
               'sourceSha256': files, 'processes': results}
    with (root / 'receipt.json').open('x') as output:
        json.dump(receipt, output, indent=2)
    print(json.dumps({'root': str(root), 'processes': results}))
    return int(any(result['exitCode'] for result in results))


if __name__ == '__main__':
    raise SystemExit(main())
