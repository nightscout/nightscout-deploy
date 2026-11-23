#!/bin/sh
# Check and unit-test the alert rules with promtool (a local binary, or the prom/prometheus image).
set -eu
cd "$(dirname "$0")"
if command -v promtool >/dev/null 2>&1; then
  promtool check rules multitenant.rules.yml && promtool test rules multitenant.rules.test.yml
else
  img=prom/prometheus:v3.5.0
  docker run --rm -v "$PWD:/r" -w /r --entrypoint promtool $img check rules multitenant.rules.yml
  docker run --rm -v "$PWD:/r" -w /r --entrypoint promtool $img test rules multitenant.rules.test.yml
fi
