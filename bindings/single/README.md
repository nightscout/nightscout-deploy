# DIY single-tenant targets

A target is one way to run `nightscout single` on MongoDB at a vendor. Each target has an owner,
a last-verified date, an expiry date and a smoke test. `tools/targets-check.js` fails on an expired
target or a missing field; renewing a target means re-running its smoke test. This is how vendor
pricing and availability churn stays out of core.

`targets.json` is empty on purpose. The first two targets land in wave 4 with their smoke tests.
