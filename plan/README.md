# Deployment plan

Draft. [`schema/deployment-plan.schema.json`](schema/deployment-plan.schema.json) describes the single
input every binding will render from. It is read-derived from core's `deploy/multitenant/config.js` and
has not been validated against a rendered deployment; the renderer does not exist yet.

The schema's rules: secrets are references, never values; images and core are pinned by digest and
commit; providers are named, never pathed; trusted peers are a list of addresses; a plan never carries a
tenant credential.
