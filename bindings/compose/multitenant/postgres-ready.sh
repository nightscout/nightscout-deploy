#!/bin/sh
# Selected Linux/PG16.15 profile only. Local postmaster-declared readiness;
# never a live SQL/TCP/authentication/capacity check and never opens a PG client.
# Actual finite SQL settings/epoch checks remain mandatory at bootstrap/admission.
set -eu
[ "$#" -eq 0 ]
[ "${PG_MAJOR:-}" = 16 ] && [ "${PG_VERSION:-}" = 16.15 ] || exit 1
[ "${PG_SHA256:-}" = c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed ]
data=/var/lib/postgresql/data
[ "${PGDATA:-}" = "$data" ]
[ ! -e "$data/standby.signal" ] && [ ! -e "$data/recovery.signal" ] || exit 1
f=$data/postmaster.pid
[ -f "$f" ] && [ ! -L "$f" ] && [ "$(wc -c < "$f")" -le 4096 ] && [ "$(wc -l < "$f")" -eq 8 ] || exit 1
first=$(cat "$f")
identity=$(stat -c '%d:%i:%s:%Y' "$f")
exec 3< "$f"
IFS= read -r pid <&3; IFS= read -r directory <&3; IFS= read -r started <&3
IFS= read -r port <&3; IFS= read -r socket <&3; IFS= read -r listen <&3
IFS= read -r shared <&3; IFS= read -r status <&3
exec 3<&-
[ "$pid" = 1 ] && [ "$directory" = "$data" ] && [ "$port" = 5432 ] && [ -n "$listen" ] || exit 1
[ "$status" = 'ready   ' ]
case "$started" in ''|*[!0-9]*) exit 1;; esac
# The pinned Docker entrypoint execs the final postgres as PID1; its temporary
# initialization server is a different PID and must not satisfy this check.
pg=$(command -v postgres)
[ ! -L "$pg" ] && [ "$(readlink /proc/1/exe)" = "$pg" ] || exit 1
set -- $(awk '{print $1, $3, $22}' /proc/1/stat)
[ "$#" -eq 3 ] && [ "$1" = 1 ] || exit 1
state=$2; ticks=$3
case "$state" in S|R) ;; *) exit 1;; esac
case "$ticks" in ''|*[!0-9]*) exit 1;; esac
hz=$(getconf CLK_TCK); boot=$(awk '$1=="btime" {print $2; exit}' /proc/stat); now=$(date +%s)
case "$hz:$boot:$now" in *[!0-9:]*|:*|*::*) exit 1;; esac
[ "$hz" -gt 0 ] && [ "$hz" -le 1000000 ] || exit 1
[ "$started" -ge "$((boot + ticks / hz))" ] && [ "$started" -le "$now" ] || exit 1
# Recheck exact process birth/executable and the status snapshot. PID timestamps
# have seconds resolution: sanity checks complement, never replace, SQL epoch custody.
set -- $(awk '{print $1, $3, $22}' /proc/1/stat)
[ "$#" -eq 3 ] && [ "$1" = 1 ] && [ "$3" = "$ticks" ] || exit 1
case "$2" in S|R) ;; *) exit 1;; esac
[ "$(readlink /proc/1/exe)" = "$pg" ]
[ "$(stat -c '%d:%i:%s:%Y' "$f")" = "$identity" ] && [ "$(cat "$f")" = "$first" ] || exit 1
[ ! -e "$data/standby.signal" ] && [ ! -e "$data/recovery.signal" ] || exit 1
