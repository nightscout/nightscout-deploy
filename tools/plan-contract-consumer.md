# Prospective core deployment-contract consumer

This source-only tool extends the existing contract lane. It does not select a
core/deployment pair, repin SOURCE, remove a helper comparison, change a package
default, build an image, or start a service.

```bash
tools/plan-contract-check.sh --prospective \
  /absolute/core-checkout \
  <exact-core-commit> \
  /absolute/new-private-output
```

Use the existing pinned Node/dependency cache; no installation occurs. The tool
checks the core commit contains the contract and its dependency lock matches the
provided cache. It archives that exact core and this committed deployment binding,
then executes the actual registry plan generator and core `nightscout plan check`.
The producer is kept outside the shipping binding and is copied into scratch.
Generated connection values are synthetic placeholders. Default, two-API and
two-evaluator topologies are checked under scrubbed environments. A selected
placement topology is explicitly refused by this producer until its actual
published map is supplied by the placement owner; the core contract independently
supports actual placement 1/2 inputs. UI/edge are deployment-owned protocols and
are not represented as invented core roles.

The existing `compose-identity-check.sh` still runs, including its recorded tree
and all five core helper comparisons. Its failure remains sticky. Unselected
receiver candidates currently have stale SOURCE custody; the tool records that
failure while separately measuring prospective document conformance. It exits
nonzero if either component fails. A green document check is not an overall
candidate pass or native acceptance. The result carries exact core/deployment
commits and binding tree. No source or image identity is silently normalized.

The new private directory retains source archives, generated inputs, raw child
stderr, core reports and the combined result. Source archive/identity commands
are local metadata reads. The six Node producer/check phases have a shared
120-second budget, at most 30 seconds each with a 2-second termination grace,
and a 2 MiB file ceiling per raw command output; the caller must also supervise
the outer script. Scratch archives are removed; retained receipts are not
rewritten or retried. No private content belongs in Git.

Focused producer tests run on the same archival overlay:

```bash
node --test tools/prospective-plan-documents.test.js
```

The test and producer must be copied from the committed tools directory into the
scratch core's tools directory, alongside the unchanged archived deployment
binding at deploy/multitenant. The existing default npm/identity checks remain
unchanged. Final selected source/image/custody and comprehensive/native acceptance
belong to the coordinator's later coherent integration.
