"""Executed only by the owned pinned Authentik worker's `ak shell` command.
No Nightscout database, Vault credential, Docker socket or serving source mount.
"""
import json
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from django.db import transaction
from authentik.core.models import User, Application
from authentik.flows.models import Flow
from authentik.crypto.models import CertificateKeyPair
from authentik.providers.oauth2.models import OAuth2Provider, ScopeMapping, RedirectURI, RedirectURIMatchingMode, RedirectURIType
from authentik.common.oauth.constants import SubModes

root=Path('/run/profile')
config=json.loads((root/'private/bootstrap.json').read_text())
name='ns-'+config['nonce']
output=root/'output/provider.json'
if output.exists():
    raise RuntimeError('AUTHENTIK_PROFILE_ALREADY_BOOTSTRAPPED')
with transaction.atomic():
    if Application.objects.filter(slug=name).exists() or OAuth2Provider.objects.filter(name=name).exists():
        raise RuntimeError('AUTHENTIK_PROFILE_PARTIAL_OR_FOREIGN')
    key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
    dn=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Synthetic OIDC signing')])
    now=datetime.now(timezone.utc)
    cert=(x509.CertificateBuilder().subject_name(dn).issuer_name(dn).public_key(key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1))
          .not_valid_after(now+timedelta(days=7)).sign(key,hashes.SHA256()))
    signing=CertificateKeyPair.objects.create(name=name,certificate_data=cert.public_bytes(serialization.Encoding.PEM).decode(),
          key_data=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode())
    provider=OAuth2Provider.objects.create(name=name,client_type='confidential',client_id=name,client_secret=config['clientSecret'],
        authentication_flow=Flow.objects.get(slug='default-authentication-flow'),
        authorization_flow=Flow.objects.get(slug='default-provider-authorization-implicit-consent'),
        invalidation_flow=Flow.objects.get(slug='default-invalidation-flow'),signing_key=signing,
        sub_mode=SubModes.USER_ID,issuer_mode='per_provider',access_code_validity='minutes=1',
        access_token_validity='minutes=5',include_claims_in_id_token=True,
        logout_uri=config['backchannel'] or '')
    provider.redirect_uris=[RedirectURI(matching_mode=RedirectURIMatchingMode.STRICT,url=url,redirect_uri_type=RedirectURIType.AUTHORIZATION) for url in config['callbacks']]
    provider.full_clean();provider.save()
    mappings=list(ScopeMapping.objects.filter(scope_name='openid'))
    if len(mappings)!=1:raise RuntimeError('AUTHENTIK_OPENID_SCOPE_AMBIGUOUS')
    provider.property_mappings.set(mappings)
    Application.objects.create(name=name,slug=name,provider=provider,meta_launch_url=config['origins'][0])
    people=[]
    for person in config['people']:
        if User.objects.filter(username=person['username']).exists():raise RuntimeError('AUTHENTIK_PROFILE_USER_EXISTS')
        user=User.objects.create(username=person['username'],name='Synthetic profile account',is_active=True)
        user.set_password(person['password']);user.save()
        # USER_ID is explicit, so the issuer's actual durable PK is its subject.
        people.append({'username':person['username'],'providerSubject':str(user.pk),'tenant':person['tenant'],'principal':person['principal'],'purposes':person['purposes'],'origin':person['origin']})
fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as file:json.dump({'version':1,'nonce':config['nonce'],'clientId':name,'providerId':provider.pk,'people':people},file)
print('AUTHENTIK_PROFILE_BOOTSTRAPPED')
