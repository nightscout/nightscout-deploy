# Focused evaluator shipping proof instruments

The fixed evaluator overlay is selected by `NS_EVALUATOR_WORKERS`; the private
pool operator uses the existing source membership protocol. These test-only
instruments qualify that composition without adding an operator ownership or
configuration-authority issuance protocol.

Use a fresh owned project/state/image tuple for each repaired source. The
acceptance project must match `ns-evaluator-binding-proof-YYYYMMDD` with an
optional hyphen and a lowercase alphanumeric suffix of at most 16 characters.
Never reset or overlay a retained failed/suspended project to obtain a passing
result. The source and deployment image/labels remain the authority for the
actual composition; a matching project name alone is not acceptance.

`shipping-sharding.integration.test.js` supports the explicit `evaluator`
profile through `NS_COMPOSE_SHARDING_PROFILE=evaluator`, including the generated
`compose.evaluator.yaml`. With `NS_EVALUATOR_SETTINGS_TRAFFIC=1`, four real B
status/settings readers continue throughout the actual A restore. Its existing
stock polling, WebSocket, API3, history/correction, lifecycle census, activation
and B socket/data assertions remain in place.

`shipping-evaluator.integration.test.js` requires explicit
`NS_EVALUATOR_BINDING_STATE`, `NS_EVALUATOR_BINDING_PROJECT`,
`NS_EVALUATOR_BINDING_PORT` and `NS_UI_TEST_CORE`. It observes real private
per-member inspection, private pool membership changes, durable outbox rows,
registered-host alarm/data sockets and B progress. Provisioning, configuration
setup and cleanup are separate operations. No setting is silently enabled by
the test.

`fixtures/evaluator-settings-setup.cjs` bootstraps only synthetic test authority
and a narrow writer role in the owned project; it never writes settings values.
`fixtures/evaluator-settings-control.cjs` performs settings changes through the
actual source owner-configuration/store and operation-window fences. This is
lower-port fixture setup, not a shipping owner bootstrap API. Wrong-tenant,
revoked-authority and excess-grant controls use the same source boundaries.
Private generated configuration contains credentials and stays outside commits.

The private probe observes membership/census and duplicate-ordinal refusal.
The constructor and window probes preserve the original source diagnoses;
they are diagnostics, not substitutes for the actual shipping acceptance.
The stock/restore and two-to-three clinical-effect criteria are separate runs.
Results belong in immutable alignment reports with exact source, binding,
image, instrument and fixture-setup attribution; a skipped runner is unmeasured.
