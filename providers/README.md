# Providers

Not started. A provider implements one core interface for one kind of infrastructure. It is an
installed npm package that registers under a name; the plan names the provider and core refuses a
name that is not registered. Configuration never names a module path.

| interface | reference provider | state |
|---|---|---|
| secrets | `vault-transit` | not started |
| registry (resolver snapshot source) | `registry-postgres` | not started |
| identity | OIDC profiles for the intended and the fallback identity provider | not started |
| alias issuer | none; core's generated label is the default | not started |
| alias policy | `claims-disabled` | not started |

Vault service login is a deployment shape, not a provider; see [`secrets/vault-agent/`](secrets/vault-agent/README.md).

The trusted-peer predicate is configuration, not a provider. Each provider will ship its kit's
results from `conformance/`.
