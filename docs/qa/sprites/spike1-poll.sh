#!/usr/bin/env bash
# Spike 1 poll: with only an outbound WebSocket active (wsping service), does the sprite pause?
# Polls the control plane (not the sprite URL) so the poll itself is not inbound activity.
set -uo pipefail
S=${1:-hub-spike}; N=${2:-16}; EVERY=${3:-15}
for i in $(seq 1 "$N"); do
  sprite api "/v1/sprites/$S" -- -s 2>/dev/null | grep -o '{.*}' \
    | python3 -c 'import sys,json,datetime; d=json.load(sys.stdin); print(datetime.datetime.utcnow().strftime("%H:%M:%S"), d["status"], "running_at=",d["last_running_at"], "warming_at=",d["last_warming_at"])'
  sleep "$EVERY"
done
