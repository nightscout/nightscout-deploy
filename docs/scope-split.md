# Scope split: core, this repository, hoster-private

One rule: **core owns anything that defines authority or identity; this repository owns anything
that varies by hoster or vendor; a hoster owns only adapters behind published interfaces.**

The full table with rationale is in the alignment note
[claimed public names and the deploy companion §2](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/docs/30-design/tenancy/claimed-public-names-and-deploy-companion-2026-11-09.md).
The short form, for this repository's contributors:

| if the change… | it belongs in |
|---|---|
| decides who a request is for, who may act, or what a name means | core |
| renders, packages, probes, monitors or operates a deployment | here |
| implements a core interface for one operator's infrastructure | a provider package, installed at image build, registered by name |
| is a login page, billing, signup or support | nowhere in these two repositories |

Two placement rules stated as mechanisms:

1. Config names a registered provider; it never names a module path.
2. The trusted-peer predicate is configuration, not a provider.
