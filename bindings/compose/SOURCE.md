# Compose source and core contract

The Compose plan and its helpers are maintained in this repository under
`bindings/compose/multitenant`. Core publishes its configuration loaders,
`nightscout plan check`, and the schema described in its
`docs/multitenant-plan-contract.md`. Core keeps a small synthetic test plan;
there is no shared five-helper copy or patch comparison.

`tools/plan-contract-check.sh --prospective CORE EXACT_COMMIT NEW_OUTPUT`
archives the exact core commit and this committed binding into scratch, runs
the actual deployment document generator, and passes its output to core's CLI.
The result records both commits and the binding tree. No service starts.
`tools/compose-identity-check.sh` checks committed deployment custody only.
Native application, clinical, restore and operator qualification retain their
own exact source/image attribution.

The archival overlay supplies core libraries to the deployment-owned modules;
it does not patch core modules or compare a copy of the deployment plan in core.
`tools/compose-overlay.sh CORE NEW_DIRECTORY EXACT_CORE_COMMIT` prepares that
same packaging layout for execution. Build/preparation still check both source
commits and the image labels. A report-only helper change does not require an
application image build.

The original import provenance and historical comparisons remain unchanged in
[SOURCE.history.md](SOURCE.history.md) and [SOURCE.delta.patch](SOURCE.delta.patch).
They describe historical inputs and are not active compatibility gates.
