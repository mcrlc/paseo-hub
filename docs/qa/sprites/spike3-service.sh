#!/usr/bin/env bash
# Spike 3: service semantics across warm resume and cold wake.
# Registers a probe service that logs pid, an env var, and boot id every 5s, then reports what
# the log shows across each transition. Run `record` before a pause and `report` after a wake.
# Usage: spike3-service.sh <sprite> install|record|report
set -uo pipefail
S=${1:?sprite}; CMD=${2:?install|record|report}
case "$CMD" in
  install)
    sprite api "/v1/sprites/$S/services/probe" -- -s -X PUT -H 'Content-Type: application/json' -d '{
      "cmd":"bash","args":["-c","while true; do echo \"$(date -u +%FT%TZ) pid=$$ boot=$(cat /proc/sys/kernel/random/boot_id) up=$(cut -d. -f1 /proc/uptime) PROBE_ENV=$PROBE_ENV\" >> /home/sprite/probe.log; sleep 5; done"],
      "env":{"PROBE_ENV":"set-at-create"}}'
    echo; sleep 8; sprite exec -s "$S" -- tail -2 /home/sprite/probe.log
    ;;
  record)
    sprite exec -s "$S" -- bash -c 'tail -1 /home/sprite/probe.log; pgrep -f "probe.log" | head -1'
    ;;
  report)
    # Show the gap around the pause: last line before, first line after, and whether pid/boot changed.
    sprite exec -s "$S" -- python3 - <<'EOF'
import re, datetime
lines = open("/home/sprite/probe.log").read().splitlines()
prev = None
for l in lines:
    t = datetime.datetime.strptime(l[:20], "%Y-%m-%dT%H:%M:%SZ")
    if prev and (t - prev[0]).total_seconds() > 20:
        print("GAP", (t - prev[0]).total_seconds(), "s")
        print("  before:", prev[1])
        print("  after: ", l)
    prev = (t, l)
print("last:", lines[-1])
EOF
    ;;
esac
