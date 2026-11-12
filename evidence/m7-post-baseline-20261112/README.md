# Joined post-baseline deployment preparation

Focused preparation is reproduced on source `7dde6f60d3f59c44d6b143df352a827768c60829`
with core `9db0ce94f072c8f34aab889f0181afa4269a6758`. The original live-add and
Authentik histories are ordinary-merged; earlier evidence keeps its original scope.
[Recorded results](focused.json) contain commands, outcomes, private raw-output hashes,
source/dependency attribution and preservation checks.

All nine focused commands returned zero. The source-admission tests exercise the
actual private host admission, exact core checkout, copied binding and generated
replica bytes in owned temporary fixtures. Removing only copied-binding equality
in memory produces the intended missing-exception failure (3 pass, 1 fail);
restoration passes all four. No target source is modified by that control.

To reproduce, supply an owned exact-core checkout as `IDP_TEST_CORE` and its exact
commit as `IDP_TEST_CORE_COMMIT`. Its ordinary dependencies are required for the
actual settings parser. Overlay this candidate onto an owned core fixture for the
primer/bootstrap checks. `NS_CORE_DIR` selects that fixture for package identity.
Run the commands recorded in focused.json from this deployment checkout, except
primer/bootstrap which run from the owned core overlay. The explicit control is:

```bash
node providers/identity/authentik/tests/control.cjs source-overlay
node providers/identity/authentik/tests/joined-source-admission.test.js
```

The first command must fail with `Missing expected exception`; the second must
pass. Git child operations require local process permissions but use no network.

The full binding tree changes because per-tenant commissioning changes the primer;
core's reduced five files and delta are unchanged. All other baseline binding
bytes, including readiness, controlled replacement, clinical/cadence and authority
fixtures, are preserved. The IdP standalone diagnostic topology and live-add
qualification use distinct explicitly owned project scopes. Defaults remain
canonical mg/dL; no baseline stack or image is changed.

Shipping live-add, partial-failure/resume against actual services and real-provider
execution remain **UNMEASURED** on this joined candidate. The next boundary is a
coordinator-authorized joined image/native qualification, with a newly admitted
exact deployment/profile commit. This focused leaf is not deployment or capacity
acceptance. No Docker, browser, database, provider or cloud campaign ran here.
