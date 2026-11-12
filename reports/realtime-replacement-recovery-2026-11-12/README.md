# Controlled replacement recovery focused proof

[Exact source, hashes, counts and scope](proof.json) separate native mechanisms
from instrumented boundaries. The shipping helper now journals before effects,
uses an inherited Linux flock descriptor, identifies never-started versus actual
new boots, quiesces exact orphan publishers, and requires explicit `--recover`
to publish a fresh confirmed generation. The existing product publisher retains
the exclusive fence around stop, activation, eligible readiness and route cutover.

Reproduced controls: interrupted operations at each listed fault site recover;
normal retry refuses without `--recover`; changed container/process/source/project,
mutated custody and unsuccessful actual termination refuse. The no-op stop command
returns success while its actual process stays alive; publication remains refused.
Restored explicit recovery completes. An actual Docker CLI retains the inherited
lock after its host is killed; recovery cannot infer absence before that creator
exits. Only uniquely owned fixture containers/processes/files were removed.

The native image is an existing immutable local paired image used to run an idle
Node process. The new helper runs on the host. Product publication/fence/readiness
is simulated in that fixture; this is not acceptance of the new helper inside a
shipping image, clinical behavior, alarms, restore, or a full multitenant stack.
The readiness unit uses an exact archived core library without borrowed dependencies.
No capacity or cloud run occurred. Parent owns joined full application acceptance.

Commands (supply the recorded immutable image or another explicitly selected pair):

```bash
node bindings/compose/multitenant/replace-realtime.test.js
node bindings/compose/multitenant/replacement-recovery.test.js
NS_UI_TEST_CORE="$PINNED_CORE" node bindings/compose/multitenant/placement-control.test.js
NS_REPLACEMENT_PLATFORM_NATIVE=1 NS_REPLACEMENT_IMAGE="$PINNED_IMAGE_ID" \
  node bindings/compose/multitenant/replacement-platform.test.js
```

The native opt-in creates only unique synthetic projects and idle Node containers,
without tenant data or PostgreSQL. It requires a local Docker host and Linux flock.
