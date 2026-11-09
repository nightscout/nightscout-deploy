# Working in this repository

Contributor-facing. These rules were each earned elsewhere; every one applies here.

1. **Synthetic data only.** No names, emails, hostnames that identify a person, tenant identifiers,
   glucose traces or exports. No credentials, tokens or connection strings in files, examples, test
   fixtures or commit messages; describe a credential by location, never by value.
2. **Read-derived is a hypothesis; measured is evidence.** Label every figure and every claim.
   `UNMEASURED` is never green.
3. **A check that has never failed is not yet evidence.** Every conformance kit ships a red control:
   break the thing under test, confirm the check fails, put it back, and say what the symptom was.
4. **Config names a registered provider; it never names a module path.** Providers are installed at
   image build time and registered by name. A loader that accepts a path is a defect.
5. **The trusted-peer predicate is configuration, not a provider.**
6. **Pins, not tags.** Images by digest, core by commit, providers by exact version. A floating
   reference turns every restart into an uncontrolled upgrade.
7. **One home per fact.** Rationale and decisions live in the alignment workspace and in core's
   release records; this repository links to them and does not restate them.
8. **A vendor target has an owner and an expiry date.** `tools/targets-check.js` fails on an expired
   target. Renewing it means re-running its smoke test, not editing the date.
9. **Say "multitenant", never "hosted"**, for the tenancy target.
10. **Agents never push.** Hand the maintainer the branch and the plain commands.
11. **Commit messages carry no trailers** (no `Co-Authored-By`); the author is git's configured identity.
