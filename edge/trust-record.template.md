# Deployment trust record (template)

Filled by the deployment operator before admission; reviewed once for the reference deployment.
Describe credentials by location, never by value. Probes are run, not asserted.

| item | value for this deployment | evidence |
|---|---|---|
| Edge peers trusted for Host/forwarded headers and `TRUST_PROXY` | | spoof probe result, date |
| TLS termination and CA | | certificate chain check, date |
| Secrets provider, authentication method, renewal, unseal custody | | service-login probe, outage probe |
| Identity provider, issuer, audience | | OIDC kit result |
| Core commit and image digests | | rendered plan |
| Provider packages and versions | | kit results |
| Backup location, restore rehearsed on | | restore record |
| Known gaps and accepted deferrals | | decision reference |
