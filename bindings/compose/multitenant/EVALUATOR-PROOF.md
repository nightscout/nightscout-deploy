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

All shipping instruments load every explicitly selected generated API, realtime
and evaluator overlay from the prepared .env, refusing missing, unselected or
unknown overlays. Controlled replacement also accepts the same bounded fresh
evaluator-proof project name.

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

The clinical oracle classifies exact source effect digests and causes. The initial
A/B urgent alarms and the intentional changed B reading are three expected
accepted normal effects; unchanged A and the changed B payload must not repeat
early. Cancelled superseded rows are classified separately, accepted clears and
extra live/pending effects refuse, socket fanout matches those typed effects, and
the new B frame must carry its exact upload timestamp. The verdict must finish
before both original durable repeat deadlines; it never changes heartbeat cadence.

Initial client diagnostics record bounded typed connect/error/disconnect/reconnect,
subscribe ACK, root-authorize ACK and initial-frame metadata without credentials
or event bodies. They retain the same two successful alarm ACKs plus B frame
predicate and20-second bound. An authorize ACK can follow the initial frame;
its absence alone does not identify denial. The separate
`fixtures/evaluator-client-prerequisites.cjs <core> <state> <port>` observes only
that pre-mutation predicate and explicitly does not qualify clinical effects.
A later successful observation cannot reclassify an earlier unclassified timeout.

The final clinical effect observation shares the existing B401-frame absolute
20-second window with durable acceptance and exact source-digest fanout. It
retains at least 1500 ms of observation after the exact frame is observed, even
when acceptance is faster. Only absent/pending/attempting changed effects or
incomplete fanout are waiting states; duplicate effects, clears, invalid
identities, cancelled changed effects and unexpected transport uncertainty fail
immediately. Uncertain is a nonterminal durable state, but does not qualify this
clean handoff proof. The unchanged strict oracle is still required for success.
Fanout is copied before primary SQL reads; events arriving during a read belong
to the next observation. Original repeat deadlines and the monotonic budget are
checked after each read, whose Docker command is bounded by remaining time.
PASS/FAIL output retains bounded final typed rows/fanout, SQL read start/end,
fanout-copy time, observation count and a last-16 trajectory. The acceptedAt
field is an application finishedAt timestamp taken before the finish commit;
its difference from created is not measured SQL commit latency.
