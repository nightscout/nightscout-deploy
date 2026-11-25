#!/usr/bin/env node
'use strict';

// Build a committed source identity, never arbitrary working files carrying a
// clean commit label. Git archive also excludes ignored runtime credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const INPUTS = ['package.json', 'package-lock.json', '.babelrc', '.browserslistrc', '.dockerignore', 'bundle', 'webpack', 'bin', 'lib', 'static', 'views', 'translations', 'migrations', 'scripts/diagnose-data.js', 'scripts/seal-devicestatus.js', 'deploy/multitenant', 'server.js'];
// Overlay mode: tools/compose-overlay.sh (nightscout-deploy) replaces core's reduced
// deploy/multitenant with nightscout-deploy's Compose tree at a recorded commit and writes this
// marker. Core's own copy of the path then differs from HEAD by design, so the source identity is
// two commits: core HEAD for every other input, and the deploy commit for this directory, which
// must equal that commit's bindings/compose/multitenant byte for byte (only the private .env,
// .state and the marker itself are left out). Any other difference is still BUILD_INPUTS_DIRTY.
const MARKER = '.overlay.json';
const PRIVATE = ['.env', '.state', MARKER];
function overlay (root) {
  const file = path.join(root, 'deploy/multitenant', MARKER);
  if (!fs.existsSync(file)) return null;
  let marker;
  try { marker = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('BUILD_OVERLAY_MARKER_INVALID'); }
  if (marker?.version !== 1 || !/^[a-f0-9]{40}$/.test(marker.deployCommit || '') || !path.isAbsolute(marker.deployRepository || '')) throw new Error('BUILD_OVERLAY_MARKER_INVALID');
  return marker;
}
function extractDeployTree (marker, target) {
  const resolved = execFileSync('git', ['-C', marker.deployRepository, 'rev-parse', '--verify', marker.deployCommit + '^{commit}'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  if (resolved !== marker.deployCommit) throw new Error('BUILD_OVERLAY_COMMIT_UNAVAILABLE');
  const archive = execFileSync('git', ['-C', marker.deployRepository, 'archive', '--format=tar', marker.deployCommit + ':bindings/compose/multitenant'], {maxBuffer: 1 << 28});
  execFileSync('tar', ['-x', '-C', target], {input: archive});
}
function assertCleanSource (root, expected) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  if (!/^[a-f0-9]{40}$/.test(head) || expected && expected !== head) throw new Error('BUILD_SOURCE_COMMIT_CHANGED');
  const marker = overlay(root);
  const inputs = marker ? INPUTS.filter(input => input !== 'deploy/multitenant') : INPUTS;
  try { execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...inputs], {cwd: root, stdio: 'pipe'}); }
  catch { throw new Error('BUILD_INPUTS_DIRTY'); }
  if (marker) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-compose-overlay-'));
    try {
      try { extractDeployTree(marker, temporary); } catch (error) { throw new Error(/^[A-Z_]+$/.test(error.message) ? error.message : 'BUILD_OVERLAY_COMMIT_UNAVAILABLE'); }
      const excludes = PRIVATE.flatMap(name => ['-x', name]);
      try { execFileSync('diff', ['-r', '-q', '--no-dereference', ...excludes, temporary, path.join(root, 'deploy/multitenant')], {stdio: 'pipe'}); }
      catch { throw new Error('BUILD_INPUTS_DIRTY'); }
    } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
  }
  return head;
}
function configuration () {
  const source = assertCleanSource(ROOT);
  const config = JSON.parse(execFileSync('docker', ['compose', '--project-name', require('./project').read(__dirname), '--env-file', '.env', '-f', 'compose.yaml', 'config', '--format', 'json'], {cwd: __dirname, encoding: 'utf8'}));
  if (config.services.api.build.args.NS_SOURCE_COMMIT !== source) throw new Error('PREPARED_SOURCE_COMMIT_CHANGED');
  return {source, config, marker: overlay(ROOT)};
}
function checkImage () {
  const {source, config, marker} = configuration();
  const labels = JSON.parse(execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', config.services.api.image], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}));
  if (labels?.['org.opencontainers.image.revision'] !== source) throw new Error('BUILT_SOURCE_COMMIT_CHANGED');
  if (marker && labels?.['org.nightscout.deploy.revision'] !== marker.deployCommit) throw new Error('BUILT_DEPLOY_COMMIT_CHANGED');
}
function build (tag) {
  if (tag && !/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(tag)) throw new Error('BUILD_LOCAL_TAG_REQUIRED');
  const { source, config, marker } = tag ? { source: assertCleanSource(ROOT), marker: overlay(ROOT) } : configuration();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-compose-build-'));
  try {
    const context = path.join(temporary, 'context'); fs.mkdirSync(context);
    const archive = path.join(temporary, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, source], {cwd: ROOT});
    execFileSync('tar', ['-xf', archive, '-C', context]);
    const labels = ['--label', 'org.opencontainers.image.revision=' + source];
    if (marker) {
      // The context is the two recorded commits, never the working files.
      const deployDirectory = path.join(context, 'deploy/multitenant');
      fs.rmSync(deployDirectory, {recursive: true, force: true}); fs.mkdirSync(deployDirectory, {recursive: true});
      extractDeployTree(marker, deployDirectory);
      labels.push('--label', 'org.nightscout.deploy.revision=' + marker.deployCommit);
    }
    execFileSync('docker', ['build', '--pull=false', '--build-arg', 'NS_SOURCE_COMMIT=' + source, '--build-arg', 'NS_DEPLOY_COMMIT=' + (marker?.deployCommit || source),
      ...labels, '-t', tag || config.services.api.image,
      '-f', 'deploy/multitenant/Dockerfile', '.'], {cwd: context, stdio: 'inherit', timeout: 1200000});
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
}
if (require.main === module) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--check-image') checkImage();
    else if (process.argv.length === 4 && process.argv[2] === '--image') build(process.argv[3]);
    else if (process.argv.length === 2) build();
    else throw new Error('COMPOSE_BUILD_USAGE');
  } catch (error) {
    process.stderr.write((/^[A-Z_]+$/.test(error.message) ? error.message : 'COMPOSE_IMAGE_BUILD_FAILED') + '\n');
    process.exitCode = 1;
  }
}
module.exports = {assertCleanSource, checkImage, overlay};
