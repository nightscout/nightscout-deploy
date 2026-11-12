# Separate bounded IdP diagnostic — preparation only

Living local qualification plan, 2026-11-12. Runtime **UNMEASURED**; no build,
pull, browser, provider or application action has run. This is not the current
candidate, acceptance or pilot gate. The resource owner must release the existing
native window and authorize this separate diagnostic before any activation.

## Exact source and ownership

Core: `9db0ce94f072c8f34aab889f0181afa4269a6758`.

This is the joined post-baseline preparation target. Earlier fba/6d source-only
records retain their exact ff source and environment. No real-provider execution
has been performed or relabelled. Build one new image from the final joined
deployment commit; do not use the accepted baseline image or running state.
Deployment SOURCE-admission imported by ordinary merge from
`cf5bda3f2d189bac5d60269df5644759c40db9e1`; committed binding tree
`3ba19b609af18184082cbd8aa5f978c9cfde016c` equals SOURCE and five core reduced
fixture files plus the original delta. The IdP branch preserves those exact
binding bytes. Build from this profile's final reviewed deployment HEAD, record
that full commit in the overlay/profile/image labels, and inspect the actual new
image ID before writing private context. The current candidate's image is never
reused with a different deployment label. The preparation receipt and local
handoff name the exact executed source head; no runtime image ID exists yet.

Reserved diagnostic nonce: `7577aa19bb7f158ffcbaafe1` (synthetic, no credential).
Only after authorization create:

- Core overlay worktree `externals/work/crm-idp-7577aa19bb7f158ffcbaafe1`, from the
  original source overlay helper; a dedicated detached deployment worktree at the
  final reviewed profile head. Never repoint the source or candidate worktrees.
- New application state `/tmp/nsidp-app-7577aa19bb7f158ffcbaafe1`, project
  `nsidp-app-7577aa19bb7f158ffcbaafe1`, its `_backend` and `_edge` networks.
- New IdP state `/tmp/nsidp-7577aa19bb7f158ffcbaafe1`, project
  `nsidp-7577aa19bb7f158ffcbaafe1`, its private `_provider` network. Only its TLS
  edge joins the exact owned application backend.
- Application reference ingress `127.0.0.1:18449`; IdP/public diagnostic edge
  `127.0.0.9:443`. Availability must be checked in the granted window; no ownership
  of an existing listener is inferred. Provider DB/server/worker have no published
  ports. API, owner and control listeners remain private.

Select exactly two seeded tenants; API2, standalone RT1/EV1, registry default
Vault Server, diagnostics OFF. This diagnostic deliberately refuses placed RT or
an evaluator pool; it does not qualify replacement or Agent lifecycle. Read
actual alias/tenant/ownerSubject from the new private primer output. Origins are
`https://one.example.test` and `https://two.example.test`; issuer hostname is
`idp-7577aa19bb7f158ffcbaafe1.synthetic.invalid`. No assumed owner grants are
created. Missing existing principal/data/settings authority is a terminal
prerequisite refusal, not a request to broaden grants.

## Finite diagnostic upper budgets

`resources.js` owns these limits solely for this disposable diagnostic, not a
production recipe, measured sizing result or capacity recommendation. Exact
API1/2/4 coverage includes every base serving and transient service; unknown
source services or non-standalone worker selections refuse.

| Group | Complete selectable service budget | Persistent serving subset |
|---|---|---|
| Source app, selected API2 | 15 service definitions, 10.5 CPU, 11,008 MiB RAM, 3,840 PID slots | 11 services, 8 CPU, 7,936 MiB RAM, 2,816 PID slots |
| IdP | 4 services, 4.25 CPU, 4,736 MiB RAM, 1,536 PID slots | Same four services |
| Combined | 19 definitions, 14.75 CPU, 15,744 MiB RAM, 5,376 PID slots | 15 services, 12.25 CPU, 12,672 MiB RAM, 4,352 PID slots |

RAM equals the configured memory+swap ceiling (swap disabled rather than added).
CPU limits are per-container maximum shares, not a promise of dedicated cores;
PID slots bound processes/threads, not predicted usage. Bootstrap, primer, demo
and placement-operator are included but are one-shot/unused profiles, not extra
persistent roles. Source build and Node/browser tools are outside these container
limits: require a separately owner-approved host reservation with at least
16 logical CPUs and 22 GiB available memory at admission, plus free disk for exact
images/dependencies and retained state. Verify actual competing work; do not
fabricate availability or stop peers. Where the host cannot safely reserve this
budget, defer rather than weakening limits. Record build/generator/browser RSS
and CPU separately; their host headroom is not a measured hard cgroup guarantee.

Private files/dirs are 0600/0700. Resource-only overlay fields are exactly CPU,
memory, swap and PID limits: no command/environment/volume/network/authority
change. Before launch, run actual `docker compose config` before/after overlay
and require exact equality after removing only those admitted fields. The
controller verifies generated bytes on every app command, includes the overlay
on install/recreation, and verifies actual running HostConfig limits before
provider operations. Provider limits are pinned in its prepared Compose hash.

## Source shipping order and commands

Use the source's documented explicit-Compose path for a distinct project, in its
unchanged `demo.sh up` order. The original fixed-project demo wrapper must not be
used against this project. There is no second shipping orchestrator here.

1. Source overlay/prepare (two tenants, API2, no worker selection), fresh source
   image build/check and exact image labels/ID capture. Set context profileCommit
   and deployCommit to the final reviewed profile HEAD; coreCommit to core above.
2. `run.js resources /private/context.json` writes the exact private application
   resource-only overlay before bootstrap; `check-app-resources` resolves and
   compares the real config. `plan` remains read-only. Neither plan/resources
   contacts a daemon. The config check does, and remains window-gated.
3. For **every** original source Compose invocation (infrastructure, bootstrap,
   admin/feed, primer provision, commission restore, pool initialize no-op, APIs,
   primer prime, remaining roles, stop/down), construct arguments via exported
   `run.appCompose(run.admit(context, false), ...originalArguments)`. This always
   adds the verified resource overlay and explicit project directory/name/env.
   Do not copy raw source Compose arguments without this resource seam.
   Execute the unchanged node `publish-primer.js` in its original position.
4. After source commissioning, profile `prepare`, `up`, `bootstrap-provider`,
   `install`, then actual browser journey, as in README. Source completion is
   required by normal verification; pre-bootstrap admission exists only for the
   bounded source preparation/resource commands. Install/recreate uses the same
   overlay and trust bundle; no RT/EV restart, replacement or owner move occurs.

Do not bypass a resource comparison, actual limit refusal, SOURCE check or
changed state to get startup. Compose/config equality and runtime HostConfig
checks are still native-unmeasured until executed. No Docker fake is used in
real execution; recording fixtures are clearly separated in source tests.

## Positive and negative qualification

Use actual pinned Authentik ORM/flows, real Chromium UI and strict HTTPS. The
private HOME/NSS database imports only the synthetic profile CA with certutil;
Chromium resolver rules map only the three exact diagnostic hostnames to loopback.
Containers use scoped private aliases. No global hosts/CA changes, TLS bypass,
insecure browser flags, fake provider, injected signing token or clock changes.

Require login and actual existing-owner settings; unauthenticated API refusal
then data-cookie API read; actual cookie attributes; provider-backed renewal
without auth/session/absolute-lifetime extension; wrong-tenant copied-cookie
refusal; local-first logout/replay during provider outage; new login/renewal
refusal while existing access lasts only to actual token expiry; provider
recovery; same signing-key/client but wrong issuer RED/restored; and browser
cross-tab/back/reload logout. Also probe unknown Host, private operator/internal/
health routes, wrong credential and an untrusted-CA HTTPS client as explicit
negative controls. Restore correct trust/credential/origin and prove the original
positive before claiming any semantic negative gate. Backchannel/multi-origin
broker and Agent renewal remain outside this leaf.

Bound the entire owned session to 90 minutes, reserving its final five minutes
for private capture and owner-checked stop. Original build timeout is 1,200s;
controller commands are 300s, browser actions30s/HTTP10s/discovery5s, browser
journey30min and actual access-expiry wait at most600s. No deadline extension or
unknown-error retry. A timeout is failure with preserved state, not permission
to resume uncertain work. Record any separate external pull bound before launch.

On failure capture typed stage/status/identity and private bounded command output
without tokens/URLs containing credentials. Preserve partial install markers,
owned image/source/state and all failed controls. `down` never uses `-v`; stop only
the exact owned provider/application projects after identity inspection. Leave
peer states/volumes, current ready stack and retained acceptance images untouched.

The implemented three-probe sequence is part of `journey.cjs` and its pinned
`native-probes.cjs` helper. Refusals must be followed by the matching healthy
restored observation before their check becomes true. TLS probes are bounded to
5 seconds and 1 MiB with exact isolated lookup, fresh non-pooled connections and
explicit certificate verification. The password challenge observer is installed
before its POST, observes the provider's typed invalid-password response and
waits for that challenge to reach its actual browser component before restoring
the correct password. Its 1 MiB response check is after Playwright buffering,
not a browser-memory bound. Recording tests and in-memory ablations qualify only
fixture logic; no real HTTPS/provider/browser execution is implied.
