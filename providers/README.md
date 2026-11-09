# Providers

A provider implements one core interface for one kind of infrastructure. It is an installed npm
package that exports a factory and registers under a name; the plan names the provider, core
refuses a name that is not registered. **No module paths in configuration.**

| interface | core contract (at `ed2ced00`) | reference provider | hoster examples |
|---|---|---|---|
| secrets | `lib/secrets/component.js` `createSecrets({providerFor, …})`: `encrypt`, `decrypt`, key version, rewrap | `vault-transit` (moves here from core at the sibling's first release) | cloud key services |
| registry (resolver snapshot source) | `lib/tenant-resolution` resolver constructed from a snapshot; "construct a new resolver to replace the mapping" | `registry-postgres` reading core's registry tables | a hoster's existing name records during transition |
| identity | generic OIDC adapter: issuer, audience, subject and session claims, optional back-channel logout | configuration profiles `authentik` (intended reference) and `kratos` (measured fallback) | any conforming provider |
| alias issuer | ephemeral alias issuance behind the registry contract: kind, lifetime, reassignment | a reference issuer for the Compose and Kubernetes bindings | a hoster's own issuance and distribution |

Not a provider, by rule: the trusted-peer predicate (configuration), and any login UI.

Each provider ships the results of its kit from `conformance/`, and the deployment's trust record
names provider package versions.
