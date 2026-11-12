# Authentik profile source readiness — 2026-11-12

Reproduced focused source/configuration checks PASS at deployment source
`aeec49beeaed021ee8dbc65ea5effae4afe9915f`, parent binding
`c10ade28f6e411919a8aa8abc29beefb15c9bc94`. Real provider/container/browser,
full application startup, issuer/signing roundtrip, private-plane runtime and
Agent lifecycle are **UNMEASURED**. This leaf does not admit Authentik as the
measured reference or change the frozen programme candidate.

`result.json` pins each of the twelve executed instrument/source files, all
commands/exits, the exact core `runtime.js` bytes used for pure parser validation,
and measured host Node/Python/kernel versions. `artifacts.sha256.json` pins the
capture bytes. Captures contain only synthetic test output, not credentials.

- Normal: 16 PASS, no failures or skips.
- Six in-memory controls: each exit 1, 15 PASS/1 FAIL, with the intended
  assertion below. Source files are never modified by the controls.
- Restored committed source: 16 PASS, no failures or skips.
- Exact pinned core `2d0ae0354a38b4a88f43bc2ae5ec60c085058f64` pure `settings()`
  body: 2 PASS, no failures or skips. This executes the original extracted
  parser function with native Buffer/URL; it does not simulate a provider/store
  or establish full role startup/dependency compatibility.
- Six JavaScript/Python syntax commands: exit 0. Python imports/ORM are not run.

| Control | Actual red symptom |
|---|---|
| Omit exact discovery issuer comparison | `Missing expected exception` in issuer/PKCE/algorithm refusal test |
| Omit private operator route deny | `assert(text.includes(expected))` false |
| Mount whole TLS directory | Edge volume assertion rejects exposure of the CA-key directory |
| Omit extra API trust overlays | Exact roster differs: missing `api-2` |
| Remove both private-file mode checks | `Missing expected exception` for public credential mode |
| Join IdP services to application network | Exact network list differs: extra `application` |

Earlier restricted child execution produced an EPERM setup refusal for Git and
a `node --test` file-wrapper summary. Neither is counted as a successful source
parser/subtest run. This immutable capture uses direct test files with authorized
child Git access and observes the actual individual tests. No native/resource
claim derives from that authorization.

The isolated source provides the opt-in real execution path and explicit native
plan in [the profile README](../../README.md). Qualification still needs a root
SOURCE-admitted post-baseline pair/fresh image, verified new application setup,
exact-lock dependencies/browser, available loopback 443 and RT's resource-window
release. No resources were created, started, stopped, deleted or borrowed for
this leaf. Partial future execution must retain its own failure captures; an
unmeasured provider or browser setup may not be replaced with a fake flow.
