#!/usr/bin/env bash
# Own disposable, populated ordinary two-tenant project only. No automatic retry
# or reopening after a failed oracle. Raw captures stay in the private state.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${NS_DRILL_CORE:?prepared core}" "${NS_DRILL_PROJECT:?owned project}" "${NS_DRILL_IMAGE:?immutable image ID}"
[[ "$NS_DRILL_IMAGE" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo DRILL_IMAGE_ID_REQUIRED >&2; exit 64; }
"$here/stack.sh" verify-profile
exec node "$here/container/pgstream-recovery.cjs" host
