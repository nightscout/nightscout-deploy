# IdP negative-probe recording qualification

Source `f2704e8a29d71c76fcd321e9a820515f23b82783`, based on
`fba0f82408712a4963a005064f9276dc30721a8c`. The intended application remains
core `ff5156b984424f1ef34bcef22d5bfa0071354cfa` with binding tree
`3ba19b609af18184082cbd8aa5f978c9cfde016c`. This is a synthetic recording-only
fixture measurement, not application/provider execution. Real browser, Authentik,
TLS handshake, DNS/NSS and container behavior remain **UNMEASURED**. No resources
were activated, no baseline inputs changed, and no new runner was introduced.

`result.json` binds source bytes, commands, exits and counts. New probe checks
pass 10/10, existing profile checks 16/16 and resource checks 24/24; the resource
module includes those same 16 profile checks, so these are not 50 distinct tests.
The exact committed source probe rerun also exits 0. Syntax checks for journey,
controller and helper, and `git diff --check`, passed.

Five in-memory ablations failed and the unmodified probe tests restored 10/10:

| Control | Actual red symptom |
| --- | --- |
| Accept any error as CA refusal | Missing expected rejection for generic outage/timeout/hostname error |
| Omit exact Host421 check | Missing expected rejection for wrong HTTP statuses |
| Omit password component discriminator | Missing expected exception for wrong component with otherwise matching password error |
| Omit trusted restored discovery | Missing expected rejection; healthy sequence also loses its third observation |
| Disable certificate verification | Explicit option assertion `false !== true` |

Initial password and verification controls were green, preserved as
`initial-probe-*.stdout/stderr`. The first test did not isolate the changed
component predicate. The second independently recompiled unchanged source,
bypassing the mutated module. The tests were corrected before the final red and
restored captures; neither initial green is treated as evidence of protection.

The actual wrong-credential browser helper is exercised against a recording page
and context: listener-before-submit, one deliberately wrong password, exact
provider response, browser challenge application, no changed local cookie, then
correct-password completion/new session. Dead initial/restored application and
untyped challenge refuse. HTTPS recording tests exercise the real helper with an
explicit fake client argument, including isolated lookup/SNI, explicit strict
verification, no pooled socket and 1 MiB streaming refusal. No runtime environment
or CLI can select that recording client.

Read-derived source basis: profile `nginx()` specifies default Host421, while
pinned Authentik2026.8.5 password validation and challenge serialization specify
HTTP200 `ak-stage-password` with `response_errors.password[].code=invalid`.
These are linked in the profile README. The CA probe changes only explicit trust
to the distinct application CA, allowing only chain-verification errors between
exact metadata positives. Unknown Host changes only HTTP Host, preserving known
SNI/CA/lookup and authoritative session before/restored; this measures edge
routing, not a registry-resolver claim. The Playwright challenge size check is
post-buffering, not a browser heap limit. Provider/browser compatibility still
requires the separate authorized real native run; the current lane does not
supply remote transport, activation permission or capacity acceptance.
