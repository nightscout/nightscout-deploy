# Current-source IdP diagnostic preparation — 2026-11-12

Focused source readiness PASS at
`769184b3bf9b2c3b33eac70da18640b5a61b239a`. Ordinary merge
`627fac4c05c932ec9ef3a4fed5c43ebf63804e96` imported deployment
`cf5bda3f2d189bac5d60269df5644759c40db9e1` into the isolated IdP history;
no rebase/cherry-pick or candidate worktree change.

Actual SOURCE check confirms core
`ff5156b984424f1ef34bcef22d5bfa0071354cfa`, binding tree
`3ba19b609af18184082cbd8aa5f978c9cfde016c`, upstream reduced tree
`fdc9f8dd2644b8789c86abeb030fbc0ad7304780`, and all five reduced fixture files
plus recorded delta. Provider implementation remains outside that binding.

- Normal/restored:24PASS, no failures/cancellations/skips. These are the prior16
  source/configuration checks plus8 new finite-resource/custody recording checks.
- Actual pinned ff source's extracted pure settings() body:2PASS, no skips;
  not full serving-role startup or provider interoperability.
- Resource overlay omission: exit1,22PASS/2FAIL; exact command-file inclusion
  assertion and recording config second-selection assertion fail.
- Authority comparison omission: exit1,23PASS/1FAIL, `Missing expected exception`
  when an environment/mount/network change no longer refuses.
- Extra-API budget omission: exit1,21PASS/3FAIL; exact service count, missing-budget
  and resolved-roster assertions fail. These are semantic failures, not setup reds.
- Two syntax checks exit0. Exact commands/hashes in result.json. Source files
  were never modified by in-memory controls.

The new resource seam supplies fixed diagnostic limits for every selected base
service, API1/2/4 and transient job. Its source-owned private overlay is selected
by every original explicit-Compose command through appCompose, including install
and recreation. Real resolved-before/after configs must differ only in admitted
limits; actual running HostConfig must retain CPU/RAM/swap/PID ceilings. Provider
Compose has pinned finite limits too. Config and actual-inspection tests here
are labelled recording fixtures, not actual Docker evidence.

**Actual Compose equality, loaded image, provider, browser and runtime all remain
UNMEASURED.** No build/pull/start/stop/daemon/browser/network/host mutation took
place. No image ID exists for this new tuple; the accepted candidate image may
not be relabelled. [The concrete native plan](../../NATIVE-PLAN.md) reserves exact
owned names/ports and declares bounded resource/time/isolation/cleanup conditions.
Root reviews that resource admission and releases/authorizes a separate local
window before any resource action. This diagnostic is not a programme gate.

Old source readiness evidence remains immutable at its original executed source;
this leaf neither rewrites it nor claims Agent/backchannel lifecycle acceptance.
