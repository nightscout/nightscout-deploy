# Opt-in Authentik HTTPS reference candidate

This is an isolated deployment profile and real-provider/browser qualification
instrument. **Provider/container/browser execution is UNMEASURED.** Authentik is
an intended reference; this change does not replace the measured fallback or
admit a new programme baseline. Decisions of record are the companion alignment
release's `deployment-identity-generic-adapter-authentik-reference` and
`oidc-provider-outage-existing-access` entries.

Owner: the `DEPLOY-IDP-PROFILE` programme lane. Candidate review expires
2026-12-12; successful native qualification and a fresh digest/security review
are prerequisites to renewing/admitting a vendor target. There is no fabricated
`lastVerified` entry in an admitted target registry.

The generic built-in adapter accepts a registered `generic-oidc` name, exact
issuer/client/algorithm and private credential file references. Configuration
cannot name code. Registry callbacks derive from authoritative current aliases;
there is no static origin map in serving configuration. The profile's explicit
origin list bounds registration and its synthetic TLS/DNS surface, rather than
conferring tenant authority. Single-origin adapter configuration is also covered
by the focused pure source parser checks.

The Authentik pin in `images.lock.json` was resolved from the official
`version/2026.8.5` release and OCI index. This was metadata inspection, not a pull
or execution. See the [official Compose installation](https://docs.goauthentik.io/install-config/install/docker-compose/),
[OIDC provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) and
[logout semantics](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/frontchannel_and_backchannel_logout/).
`bootstrap.py` uses that version's actual ORM model contract. Runtime ORM/default
flow compatibility, actual image availability and browser trust remain native
qualification gates.

## Custody and supported scope

Use a new owned synthetic application project `nsidp-app-<nonce>` and provider
project `nsidp-<nonce>`. The nonce is 24 lower-case hexadecimal characters. The
profile refuses shared/retained project names, mutable image names, changed
source or binding files, changed prepared rosters, public/symlink private files,
remote Docker endpoints and an untracked host instrument. A plan reads state
and Git only; it creates nothing and contacts no provider or Docker daemon.

Only the TLS edge joins the application's private backend. Provider database,
server and worker remain on a separate internal network. The worker receives no
application/Vault/operator credentials or Docker socket. The edge receives its
leaf certificate/key, never the CA signing key. Serving APIs and tenant-admin
receive only the public CA bundle in a new read-only mount. Provider secrets,
bootstrap input and captures use mode 0600 beneath mode 0700 owned state.

`install.js` is a gated private bootstrap one-shot. It binds each provider
subject to an **existing** local principal and verifies active existing owner
and settings authority before enabling a management-purpose mapping. It never
creates owner actors, settings authority, roles or permission grants. It creates
a dedicated NO-BYPASS login/NOLOGIN table owner and the source human-session
catalogue; serving SQL grants cover only the source store's exact reads and
session/token/logout writes. Existing credentials are preserved independently.
A partial install is retained and refused on repetition; there is no replay,
rollback or credential fallback.

Human Transit signing uses a separate constant two-pattern sign-only static
24-hour qualification credential. It cannot manage keys. It is **not** the
completed Vault Agent serving lifecycle profile; its renewal is not claimed.
Existing Agent evidence keeps its original source and scope. No live IdP or
user data belongs in this candidate.

Backchannel logout is optional. This candidate can register one exact origin;
it refuses multi-origin backchannel mode instead of inventing a revocation
broker. Disabled mode explicitly relies on local logout, access expiry and
provider-backed renewal; it does not claim prompt provider-session revocation.
The two-tenant browser leaf uses disabled mode. A one-origin backchannel native
extension remains UNMEASURED and is not credited by that leaf.

## Inputs and commands

The private context JSON has exactly `profile`, `core`, `deployment`, `appState`,
`profileCommit`. `core`/`deployment` are canonical owned Git worktree paths,
`appState` is the prepared state path and `profileCommit` is this instrument's
full committed deployment revision. `profile` has exactly:

```
version provider nonce state appProject appNetwork coreCommit deployCommit
appImage bind issuerHost origins apiServices bindings backchannel
```

Select version 1/provider `authentik`; immutable image ID; bind `127.0.0.9`;
`idp-<nonce>.synthetic.invalid`; canonical HTTPS origins on port 443 from the
actual registry seed; exact contiguous API services; and bindings containing
`tenant`, `principal`, `origin`, `purposes`. Read tenant IDs, aliases and
`ownerSubject` from the newly owned primer output privately. Do not copy tokens
or the complete primer JSON to public logs. The first browser binding needs both
data and management purpose; a second tenant is required for isolation. An
existing local principal with the corresponding data-read permissions is a
prerequisite. No guessed/default owner authority is installed.

Before resource authorization, only run:

```bash
node providers/identity/authentik/run.js plan /private/context.json
node providers/identity/authentik/tests/profile.test.js
IDP_TEST_CORE=/owned/core IDP_TEST_CORE_COMMIT=<exact-core-commit> \
  node providers/identity/authentik/tests/source-settings.test.js
```

After the coordinator grants the owned local window, the explicit controller
sequence is:

```bash
NS_IDP_PROFILE_EXECUTE=1 node providers/identity/authentik/run.js prepare /private/context.json
NS_IDP_PROFILE_EXECUTE=1 node providers/identity/authentik/run.js up /private/profile-state
NS_IDP_PROFILE_EXECUTE=1 node providers/identity/authentik/run.js bootstrap-provider /private/profile-state
NS_IDP_PROFILE_EXECUTE=1 node providers/identity/authentik/run.js install /private/profile-state
NS_IDP_PROFILE_EXECUTE=1 node providers/identity/authentik/journey.cjs /private/profile-state /exact/chromium
```

The controller never runs the application's shipping sequence. Prepare/bootstrap,
provision, commission, API start, prime/publish and remaining-role startup must
first follow the selected source binding's existing launcher. The profile then
attests that source tuple, prepared overlays, exact serving image and network.
`install` uses that source's private bootstrap service and recreates only the
selected APIs and tenant-admin with the trust overlay. It neither raw-restarts
placed realtime workers nor changes ownership maps/checkpoints.

All operation stdout/stderr are bounded private captures (4 MiB per stream per
command; overflow/truncation is explicit failure, not evidence of absence).
Public CLI failure output is a typed code. Browser failures produce a private
stage/verdict receipt without token, body, credential or user-profile dumps.
Provider output and private state are hashed before installation/use.

## Native qualification plan — not executed

1. Root selects a SOURCE-admitted post-baseline core/deployment/profile tuple
   and immutable fresh image. Implementation bases are core
   `2d0ae0354a38b4a88f43bc2ae5ec60c085058f64` and binding
   `c10ade28f6e411919a8aa8abc29beefb15c9bc94`; existing `2d/dcc` images are **not**
   relabelled as this tuple. Root owns SOURCE refresh/integration. Preserve the
   original nine-stage native identity/client proof's actual executed source;
   it is not Authentik interoperability evidence.
2. Reserve a fresh nonce, two owned Git worktrees, private app/profile states,
   projects above and loopback `127.0.0.9:443`. Confirm port/resource ownership
   and RT's release of the native export window. Retained Agent/RT/identity
   states and volumes remain untouched. Use exact-lock source dependencies and
   pin the actual Node/npm, browser executable, Playwright and image identities.
3. Start the newly owned app by the shipping sequence, two registry tenants,
   actual owner/source settings and selected fixed API roster. Register only
   actual seed aliases. No SQL settings seeding, fabricated provider, borrowed
   source mount or live account. Capture original route/authority/private-plane
   controls as prerequisites.
4. Prepare/up/bootstrap/install this profile. It creates a local synthetic CA
   and SAN certificate for issuer+aliases. HTTPS remains strict. Chromium gets
   a private HOME/NSS trust database using `certutil`; its host resolver rules
   map only those exact hosts to loopback. Docker aliases resolve issuer within
   the private app and optional callback within provider network. There are no
   `/etc/hosts` changes, global CA changes, `ignoreHTTPSErrors`, insecure browser
   certificate flags or `NODE_TLS_REJECT_UNAUTHORIZED=0`.
5. Execute the real browser leaf. It requires real UI login, management settings,
   unauthenticated data refusal then data-cookie API read, Secure/HttpOnly/
   SameSite cookie, silent renewal preserving session/authentication/absolute
   lifetime, copied-cookie wrong-tenant refusal, outage local logout/replay,
   existing access only until actual token expiry (no injected clock/shortened
   TTL), new login/renewal refusal, recovery, wrong signed issuer rejection,
   restored issuer success and tab/back/reload logout. Wrong-issuer control
   changes only actual provider issuer mode, retaining provider/client/signing
   key identity in a private control receipt; no token/signature substitutes.
6. Keep exact typed positive and RED/restored receipts. An Authentik UI selector,
   trust setup, cold application, subject mapping or provider schema failure is
   a failed/UNMEASURED setup gate, not permission to replace the real flow or
   retry arbitrary errors. Browser proof is a bounded leaf, not programme/full
   capacity/Agent acceptance. Optional backchannel and real external IdPs remain
   separate explicitly unmeasured scope.
7. On failure preserve attempted markers, private captures, database and app
   state; do not reset/replay it. The explicit `down` operation verifies and
   stops only the owned provider project, never removes volumes (`-v` is not
   used). Coordinator separately stops the owned application using its shipping
   custody. Delete neither peer worktrees nor retained resources.

The browser has 30-second action/10-second HTTP/5-second discovery bounds, an
actual-expiry wait capped by the existing 600-second management ceiling and a
30-minute journey budget; source controller commands have their separate bounded
300-second limits. This is not an unmeasured latency/capacity guarantee.
