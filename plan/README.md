# Deployment plan

A plan is the single input every binding renders from. It is derived from the documents core's
`deploy/multitenant/config.js` (at `ed2ced00`) already emits for the Compose reference: per-role
configuration, per-role environment, operation-cohort participants, the admission file, the public
UI projection and the grants SQL.

`schema/deployment-plan.schema.json` is a **draft** of the inputs side. It is read-derived from
that file and has not been validated against a rendered deployment; wave 1's gate is a renderer
that reproduces the accepted reference's documents from a plan instance.

Rules the schema encodes:

- Secrets are **references** (`secretRefs`), never values. A plan may be committed.
- Images and core are pinned (`images.*.digest`, `core.commit`).
- Providers are named (`providers.<interface>.name`), never pathed.
- Trusted peers are a list of addresses or CIDRs, not a provider.
- Tenants carry a stable `id`, optional internal name, and aliases with `kind` and optional
  `expiresAt`; a plan never carries a tenant credential.
