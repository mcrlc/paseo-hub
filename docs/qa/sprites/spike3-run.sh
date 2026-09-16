#!/usr/bin/env bash
# Spike 3 driver: wait for the sprite to reach the target state, then wake it with `report`.
# Usage: spike3-run.sh <sprite> <warm|cold> [max polls of 15s]
set -uo pipefail
S=${1:?}; TARGET=${2:?}; N=${3:-36}
st() { sprite api "/v1/sprites/$S" -- -s 2>/dev/null | grep -o '{.*}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null; }
for i in $(seq 1 "$N"); do
  s=$(st); echo "$(date -u +%H:%M:%S) status=$s"
  if [ "$s" = "$TARGET" ]; then sleep 45; echo "--- waking from $TARGET via exec report ---"; ./spike3-service.sh "$S" report; exit 0; fi
  sleep 15
done
echo "did not reach $TARGET in $((N*15))s"; exit 1
