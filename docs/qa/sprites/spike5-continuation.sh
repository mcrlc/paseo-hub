#!/usr/bin/env bash
# Spike 5 core: wait for the sprite to pause, dispatch a follow-up on the same continuation key,
# watch what Hub and the daemon do against a frozen sprite, then wake it by exec and watch again.
set -uo pipefail
S=${1:-hub-spike-2}; DK=${2:-run-3}
cd "$(dirname "$0")"
st() { sprite api "/v1/sprites/$S" -- -s 2>/dev/null | grep -o '{.*}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null; }
dlog() { sprite exec -s "$S" -- bash -c 'grep -v windowMs /.sprite/logs/services/paseo.log | grep -o "^[^ ]*\|\"msg\":\"[^\"]*\"\|\"requestType\":\"[^\"]*\"\|\"error\":\"[^\"]\{0,120\}" | paste - - 2>/dev/null | tail -n 12'; }
for i in $(seq 1 16); do s=$(st); echo "$(date -u +%H:%M:%S) status=$s"; [ "$s" = warm ] || [ "$s" = cold ] && break; sleep 15; done
echo "===== dispatch follow-up while $(st) ====="
./spike5-run.sh "$DK" "What word did I ask you to remember earlier in this conversation? Reply with just that word, then call the finish_execution MCP tool exactly once. Do not use curl, shell, or direct HTTP."
for i in 1 2 3 4 5 6 7 8; do sleep 20; echo "$(date -u +%H:%M:%S) status=$(st)"; done
echo "===== hub log tail ====="; tail -n 30 "$HUBLOG" | grep -i "execution\|dispatch\|daemon\|error\|warn\|timeout" | cut -c1-200 | tail -12
echo "===== wake by exec; daemon log since dispatch ====="; dlog
for i in 1 2 3 4 5 6; do sleep 20; echo "$(date -u +%H:%M:%S) status=$(st)"; done
echo "===== daemon log after wake ====="; dlog
echo "===== hub log tail ====="; tail -n 40 "$HUBLOG" | grep -i "execution\|dispatch\|daemon\|error\|warn\|timeout\|mcp" | cut -c1-200 | tail -12
