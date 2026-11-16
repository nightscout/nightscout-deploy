#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/opt/nsperf
stage=${1:?stage}
if [ "$stage" = collect ]; then
  mkdir -p "$root/work" "$root/logs"
  inputs=(work logs)
  if [ -f "$root/input/spec.json" ]; then inputs+=(input/spec.json); else printf '%s\n' spec.json > "$root/work/collection-missing-inputs.txt"; fi
  for dir in "$root"/traffic-level[123]; do
    if [ -d "$dir" ] && [ ! -L "$dir" ]; then inputs+=("${dir#"$root"/}"); fi
  done
  status=0
  timeout 18 tar --exclude='*/dependencies' --exclude='*/.npm-cache' --exclude='*.pack' -czf "$root/evidence.tar.gz" -C "$root" "${inputs[@]}" || status=$?
  chown 1000:1000 "$root/evidence.tar.gz"
  exit "$status"
fi
python3 -I -B "$root/input/pilot-ledger.py" marker
if [ "$stage" = deploy ]; then
  export DEBIAN_FRONTEND=noninteractive
  timeout 180 cloud-init status --wait || test -f /etc/nsperf-run.json
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 git curl ca-certificates xz-utils python3 procps
  curl -fsS --retry 3 https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz -o "$root/node.tar.xz"
  echo '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6  /opt/nsperf/node.tar.xz' | sha256sum -c -
  tar -xJf "$root/node.tar.xz" -C /usr/local --strip-components=1
  systemctl enable --now docker
  [ "$(id -u nsperf)" = 1000 ] && [ "$(id -g nsperf)" = 1000 ]
  ! getent passwd 1001 >/dev/null
  useradd --uid 1001 --user-group --no-create-home --shell /usr/sbin/nologin nsload
  mkdir "$root/work" "$root/alignment"
  python3 -I -B "$root/input/pilot-docker-store.py"
  ALIGNMENT=$(python3 -c 'import json;print(json.load(open("/opt/nsperf/input/spec.json"))["alignmentCommit"])')
  git init -q "$root/alignment"
  git -C "$root/alignment" index-pack --stdin < "$root/input/alignment.pack"
  printf '%s\n' "$ALIGNMENT" > "$root/alignment/.git/shallow"
  git -C "$root/alignment" update-ref refs/heads/instrument "$ALIGNMENT"
  git -C "$root/alignment" symbolic-ref HEAD refs/heads/instrument
  git -C "$root/alignment" sparse-checkout init --no-cone
  git -C "$root/alignment" sparse-checkout set --no-cone /tools/mt-bench/external-generator/
  git -C "$root/alignment" reset --hard "$ALIGNMENT"
  K6=$(python3 -c 'import json;print(json.load(open("/opt/nsperf/input/spec.json"))["k6Image"])')
  [[ "$K6" =~ ^grafana/k6@sha256:[a-f0-9]{64}$ ]]
  docker pull "$K6"
  docker image inspect "$K6" > "$root/work/k6-image.json"
  dpkg-query -W > "$root/work/packages.txt"
  node --version > "$root/work/node-version.txt"
  docker version > "$root/work/docker-version.txt"
  exit 0
fi
case "$stage" in
  session) exec python3 -I -B "$root/input/external-setup.py" generator-session "${2:?cell index}" ;;
  client-export) exec python3 -I -B "$root/input/external-setup.py" client-export "${2:?cell index}" ;;
esac
echo EXTERNAL_GENERATOR_STAGE_REFUSED >&2
exit 64
