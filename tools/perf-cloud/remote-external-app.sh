#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/opt/nsperf
stage=${1:?stage}
adapter="$root/alignment/tools/mt-bench/m7-joined/adapter.py"
cell="$root/work/level1-pilot"
if [ "$stage" = collect ]; then
  mkdir -p "$root/work" "$root/logs"
  # Capture partial setup even if a large upload or bootstrap was interrupted.
  inputs=(logs work)
  : > "$root/work/collection-missing-inputs.txt"
  admission_files=(pilot-authorization.json pilot-acceptance.json)
  selected=$(python3 -c 'import json;from pathlib import Path;s=json.load(open(Path("/opt/nsperf/input/spec.json")));p=s.get("profile");print("pilot-authorization.json" if p=="joined-baseline-diagnostic-v1" else "pilot-acceptance.json" if p=="joined-pilot-v1" else "")' 2>/dev/null) || selected=''
  case "$selected" in pilot-authorization.json|pilot-acceptance.json) admission_files=("$selected");; esac
  if [ "$selected" = pilot-authorization.json ]; then admission_files+=(pilot-measurement-capabilities.json); fi
  for file in spec.json "${admission_files[@]}" pilot-instrument.json pilot-capabilities.json pilot-native-expectation.json pilot-native-identity.json pilot-native-artifact.bin pilot-receipt-gate.json pilot-qualified-image.json; do
    if [ -f "$root/input/$file" ]; then inputs+=("input/$file"); else printf '%s\n' "$file" >> "$root/work/collection-missing-inputs.txt"; fi
  done
  status=0
  timeout 18 tar --exclude='*/core' --exclude='*/dependencies' --exclude='*/state' \
      --exclude='checkpoint-level*.tar.gz*' --exclude='*.pack' \
      -czf "$root/evidence.tar.gz" -C "$root" "${inputs[@]}" || status=$?
  chown 1000:1000 "$root/evidence.tar.gz"
  exit "$status"
fi
python3 -I -B "$root/input/pilot-ledger.py" marker
if [ "$stage" = deploy ]; then
  export DEBIAN_FRONTEND=noninteractive
  timeout 180 cloud-init status --wait || test -f /etc/nsperf-run.json
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 git curl ca-certificates openssl bc xz-utils python3 procps
  curl -fsS --retry 3 https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz -o "$root/node.tar.xz"
  echo '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6  /opt/nsperf/node.tar.xz' | sha256sum -c -
  tar -xJf "$root/node.tar.xz" -C /usr/local --strip-components=1
  systemctl enable --now docker
  worker=$(getent passwd 1000 | cut -d: -f1)
  [ "$worker" = nsperf ] && [ "$(id -g "$worker")" = 1000 ] || { echo JOINED_SSH_RUNTIME_UID_MISMATCH >&2; exit 1; }
  usermod -aG docker "$worker"
  mkdir "$root/sources" "$root/work" "$root/alignment"
  python3 -I -B "$root/input/pilot-docker-store.py"
  read -r CORE DEPLOY ALIGNMENT < <(node -e 'const s=require("/opt/nsperf/input/spec.json");console.log(s.coreCommit,s.deployCommit,s.alignmentCommit)')
  for name in core deploy; do
    commit=$CORE; [ "$name" != deploy ] || commit=$DEPLOY
    repo="$root/sources/$name.git"
    git init --bare -q "$repo"
    git --git-dir="$repo" index-pack --stdin < "$root/input/$name.pack"
    printf '%s\n' "$commit" > "$repo/shallow"
    git --git-dir="$repo" update-ref refs/heads/paired "$commit"
  done
  git init -q "$root/alignment"
  git -C "$root/alignment" index-pack --stdin < "$root/input/alignment.pack"
  printf '%s\n' "$ALIGNMENT" > "$root/alignment/.git/shallow"
  git -C "$root/alignment" update-ref refs/heads/instrument "$ALIGNMENT"
  git -C "$root/alignment" symbolic-ref HEAD refs/heads/instrument
  git -C "$root/alignment" sparse-checkout init --no-cone
  git -C "$root/alignment" sparse-checkout set --no-cone /tools/mt-bench/m7-joined/ /tools/mt-bench/capacity/ /tools/mt-bench/compose-baseline/ /tools/queue/gates/m7_joined_receipt.py /tools/mt-bench/external-generator/
  git -C "$root/alignment" reset --hard "$ALIGNMENT"
  python3 -c 'import json,shutil;from pathlib import Path;r=Path("/opt/nsperf");s=json.load(open(r/"input/spec.json"));f="pilot-authorization.json" if s["profile"]=="joined-baseline-diagnostic-v1" else "pilot-acceptance.json";shutil.copyfile(r/"input"/f,r/"work/receipt.json")'
  dpkg-query -W > "$root/work/packages.txt"
  docker version > "$root/work/docker-version.txt"
  docker compose version >> "$root/work/docker-version.txt"
  node --version > "$root/work/node-version.txt"
  chown -R 1000:1000 "$root"
  ulimit -n 65536
  exec setpriv --reuid "$worker" --regid 1000 --init-groups --reset-env -- bash "$0" build
fi
if [ "$(id -u)" = 0 ]; then
  worker=$(getent passwd 1000 | cut -d: -f1)
  ulimit -n 65536
  exec setpriv --reuid "$worker" --regid 1000 --init-groups --reset-env -- bash "$0" "$stage" "${2:-}"
fi
if [ "$stage" = build ]; then
  python3 -B "$adapter" manifest > "$root/work/instrument-manifest.json"
  python3 -c 'import json; a=json.load(open("/opt/nsperf/work/instrument-manifest.json")); b=json.load(open("/opt/nsperf/input/pilot-instrument.json")); assert a==b,"PILOT_INSTRUMENT_TRANSPORT_MISMATCH"'
  python3 -B "$adapter" capabilities > "$root/work/runtime-capabilities.json"
  python3 -c 'import json; a=json.load(open("/opt/nsperf/work/runtime-capabilities.json")); b=json.load(open("/opt/nsperf/input/pilot-capabilities.json")); assert a==b,"PILOT_RUNTIME_CAPABILITY_MISMATCH"'
  if [ -f "$root/input/pilot-authorization.json" ]; then
    python3 -B "$adapter" measurement-capabilities > "$root/work/runtime-measurement-capabilities.json"
    python3 -c 'import json;from pathlib import Path;r=Path("/opt/nsperf");assert json.load(open(r/"work/runtime-measurement-capabilities.json"))==json.load(open(r/"input/pilot-measurement-capabilities.json")),"UNACCEPTED_RUNTIME_ADMISSION_DESCRIPTOR_CHANGED"'
  fi
  python3 -I -B "$root/input/pilot-native-witness.py" stage --alignment "$root/alignment" --expected "$root/input/pilot-native-expectation.json" --identity "$root/input/pilot-native-identity.json" --gate-description "$root/input/pilot-receipt-gate.json" --artifact "$root/input/pilot-native-artifact.bin" --record "$root/work/native-witness-verification.json"
  python3 -B "$root/input/pilot-ledger.py" build
  exit 0
fi
case "$stage" in
  prepare|port|deploy-cell|session|client-import|down)
    operation=$stage; [ "$stage" != deploy-cell ] || operation=deploy; [ "$stage" != session ] || operation=app-session
    exec python3 -I -B "$root/input/external-setup.py" "$operation" "${2:?cell index}" ;;
esac
echo 'UNSUPPORTED_PILOT_STAGE' >&2
exit 64
