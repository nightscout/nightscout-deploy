# Secrets: Vault Agent service login

*Pointer. The mechanism and its files live in the Compose binding.*

Core's Vault Transit provider (`lib/secrets/vault-transit.js` at `ed2ced00`) takes a `getToken`
callback and nothing else about login. How the token gets there is a deployment concern, and the
decision of record (release record `releases/cgm-remote-monitor-16.0.0/decisions.md`, anchor
`vault-agent-sidecar`) is **Vault Agent as a sidecar**: AppRole auto-auth, a token sink file,
renewal and re-authentication all belong to the Agent. The application reads the sink on every
call (`tokenFile` in the tenant's `vault` block, the alternative to `tokenEnv`).

- Compose: [`bindings/compose/vault-agent/`](../../../bindings/compose/vault-agent/README.md),
  the wave 3 "Vault service login" deliverable on the [roadmap](../../../docs/roadmap.md).
- Kubernetes: the same `agent.hcl` as a native sidecar (init container with
  `restartPolicy: Always`) sharing an `emptyDir` with the application containers; the AppRole
  method is replaced by the Kubernetes auth method. Not started; see `bindings/kubernetes/`.

Not a provider in the sense of `providers/README.md`: no npm package, no registration name. It is
the login shape the `vault-transit` reference provider is deployed with. The one design point it
raises (one AppRole for all tenant keys versus one Agent per tenant) is stated in the binding's
README and is for the maintainer to decide.
