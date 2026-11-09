# Providers

A provider implements one core interface for one kind of infrastructure. It is an installed npm
package that exports a factory and registers under a name; the plan names the provider, core
refuses a name that is not registered. **No module paths in configuration.**

| interface | core contract (at `ed2ced00`) | reference provider | hoster examples |
|---|---|---|---|
| secrets | `lib/secrets/component.js` `createSecrets({providerFor, …})`: `encrypt`, `decrypt`, key version, rewrap | `vault-transit` (moves here from core at the sibling's first release) | cloud key services |
| registry (resolver snapshot source) | `lib/tenant-resolution` resolver constructed from a snapshot; "construct a new resolver to replace the mapping". Private names and public aliases are core records; core exposes a read-only resolution endpoint on the private plane | `registry-postgres` reading that endpoint | a hoster's existing name records during transition |
| identity | generic OIDC adapter: issuer, audience, subject and session claims, optional back-channel logout | configuration profiles `authentik` (intended reference) and `kratos` (measured fallback) | any conforming provider |
| alias issuer | ephemeral or additional stable alias issuance behind the registry contract: kind, lifetime, reassignment | none needed: the built-in generated label is the default primary alias | a hoster's own issuance and distribution |
| alias policy | may an owner claim or choose a name: pattern, length, reserved list, cooling-off on release | `claims-disabled` (generated label only) | a hoster's claim rules and owner flow |

Not a provider, by rule: the trusted-peer predicate (configuration), and any login UI.

Each provider ships the results of its kit from `conformance/`, and the deployment's trust record
names provider package versions.
