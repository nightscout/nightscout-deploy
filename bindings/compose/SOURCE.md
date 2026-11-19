# Compose source and core contract

The Compose plan and its helpers are maintained in this repository under
`bindings/compose/multitenant`. Core documents role settings in `docs/multitenant-settings.md`. The platform sets public
values in the container environment and mounts scoped credential files. Role startup and the
binding tests exercise those inputs through the core loaders.

The archival overlay supplies core libraries to the deployment-owned modules;
it does not patch core modules or compare a copy of the deployment plan in core.
`tools/compose-overlay.sh CORE NEW_DIRECTORY EXACT_CORE_COMMIT` prepares that
same packaging layout for execution. Build/preparation still check both source
commits and the image labels. A report-only helper change does not require an
application image build.

The original import provenance and historical comparisons remain unchanged in
[SOURCE.history.md](SOURCE.history.md) and [SOURCE.delta.patch](SOURCE.delta.patch).
They describe historical inputs and are not active compatibility gates.
