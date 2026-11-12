"""Explicit owned-provider semantic control, never a production policy tool."""
import json
import os
import secrets
from pathlib import Path
from authentik.providers.oauth2.models import OAuth2Provider
root=Path('/run/profile')
seed=json.loads((root/'private/bootstrap.json').read_text())
proof=json.loads((root/'output/provider.json').read_text())
if proof['nonce']!=seed['nonce']:
    raise RuntimeError('AUTHENTIK_CONTROL_SOURCE')
provider=OAuth2Provider.objects.get(pk=proof['providerId'],client_id='ns-'+seed['nonce'])
mode=os.environ.get('NS_IDP_ISSUER_MODE')
if mode not in ('global','per_provider'):
    raise RuntimeError('AUTHENTIK_CONTROL_MODE')
before={'providerId':provider.pk,'clientId':provider.client_id,'signingKeyId':str(provider.signing_key_id),'mode':provider.issuer_mode}
provider.issuer_mode=mode
provider.save(update_fields=['issuer_mode'])
provider.refresh_from_db()
after={'providerId':provider.pk,'clientId':provider.client_id,'signingKeyId':str(provider.signing_key_id),'mode':provider.issuer_mode}
if any(before[k]!=after[k] for k in ('providerId','clientId','signingKeyId')) or after['mode']!=mode:
    raise RuntimeError('AUTHENTIK_CONTROL_IDENTITY_CHANGED')
fd=os.open(root/'output'/('issuer-control-'+secrets.token_hex(12)+'.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as file:json.dump({'nonce':seed['nonce'],'before':before,'after':after},file)
print('AUTHENTIK_ISSUER_CONTROL_APPLIED')
