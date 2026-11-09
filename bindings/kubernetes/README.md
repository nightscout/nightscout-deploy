# Kubernetes binding (deferred)

Candidate translation, from the alignment public-name contract: one Pod per application cohort,
separate role containers, a private shared socket volume for the participant transport, versioned
ConfigMaps, narrow per-role Secret mounts, a controlled no-overlap update strategy, explicit
provisioning Jobs separate from serving startup. Equivalence is proven against the table in the
contract, not inferred from YAML. Jsonnet or Helm is undecided.
