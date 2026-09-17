#!/usr/bin/env bash
# Runs spike 2 phases in order, waiting for the sprite to pause before each wake test.
set -uo pipefail
S=${1:-hub-spike-2}
st() { sprite api "/v1/sprites/$S" -- -s 2>/dev/null | grep -o '{.*}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])'; }
waitpaused() { for i in $(seq 1 20); do s=$(st); echo "$(date -u +%H:%M:%S) waiting, status=$s"; [ "$s" != running ] && return 0; sleep 15; done; echo "never paused"; return 1; }
echo "===== phase url ====="; waitpaused && ./spike2-wake-hold.sh "$S" url
echo "===== phase exec ====="; waitpaused && ./spike2-wake-hold.sh "$S" exec
echo "===== phase hold ====="; ./spike2-wake-hold.sh "$S" hold
