# Single-tenant targets

Will hold one entry per way of running `nightscout single` on MongoDB at a vendor, each with an
owner, a last-verified date, an expiry date and a smoke test. `tools/targets-check.js` fails on an
expired target or a missing field; renewing a target means re-running its smoke test.

`targets.json` exists and holds no targets yet; the checker runs in `npm test`.
