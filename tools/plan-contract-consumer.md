# Deployment contract consumer

Run against an exact committed core and this committed deployment binding:

```bash
tools/plan-contract-check.sh --prospective /absolute/core-checkout EXACT_CORE_COMMIT /absolute/new-private-output
```

The existing pinned core dependency cache is reused after its lock is checked.
No installation or service starts. The actual deployment generator produces
synthetic registry-mode role documents; core's `nightscout plan check` validates
them using its published loaders and schema. The archival packaging overlay
supplies core libraries without changing core code. The check covers the ordinary
plan and API replicas. Selected evaluator partition is explicitly refused by the
actual maintained plan (PGSTREAM_EVALUATOR_PARTITION_UNQUALIFIED); the producer
tests retain that refusal. Selected realtime placement is also refused until its
actual placement maps are supplied.

The retained result records exact core/deploy commits, binding tree, generated
inputs and CLI reports. A wrong source, generator failure or rejected document
fails. This source check grants no native or performance acceptance. Optional
measurements and failed/partial observations remain separately attributed.

The shared bound is 120 seconds; each Node phase is at most 30 seconds with a
two-second kill grace and a two-MiB output ceiling. Source archives and private
results stay outside Git. Historical helper byte comparisons remain in the
source history and are not executed.
