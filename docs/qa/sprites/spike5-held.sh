#!/usr/bin/env bash
# Spike 5 positive half: hold the sprite first (what the PRD's provider.hold does), then dispatch
# the follow-up on the same continuation key and check the restored agent remembers.
set -uo pipefail
S=${1:-hub-spike-2}; DK=${2:-run-4}
cd "$(dirname "$0")"
st() { sprite api "/v1/sprites/$S" -- -s 2>/dev/null | grep -o '{.*}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null; }
echo "$(date -u +%H:%M:%S) before hold: $(st)"
sprite exec -s "$S" -- bash -c 'sprite-env curl -s -X POST /v1/tasks -d "{\"name\":\"hub-run-4\",\"expire\":\"10m\"}"; echo'
sleep 5; echo "$(date -u +%H:%M:%S) after hold: $(st)"
./spike5-run.sh "$DK" "What word did I ask you to remember earlier in this conversation? Reply with just that word, then call the finish_execution MCP tool exactly once. Do not use curl, shell, or direct HTTP."
for i in $(seq 1 9); do sleep 20; n=$(sprite exec -s "$S" -- bash -c 'grep -c "finish_execution\|pineapple" /home/sprite/.paseo/agents/home-sprite-workspace-hub/*.json 2>/dev/null | tail -1'); echo "$(date -u +%H:%M:%S) status=$(st) matches=$n"; done
echo "===== daemon log since dispatch ====="
sprite exec -s "$S" -- bash -c 'grep -v windowMs /.sprite/logs/services/paseo.log | grep -o "^[^ ]*\|\"msg\":\"[^\"]*\"\|\"requestType\":\"[^\"]*\"\|\"error\":\"[^\"]\{0,120\}" | paste - - 2>/dev/null | tail -n 14'
echo "===== agent record: reply text ====="
sprite exec -s "$S" -- bash -c 'grep -oh "pineapple[^\"]\{0,40\}\|finish_execution[^\"]\{0,40\}" /home/sprite/.paseo/agents/home-sprite-workspace-hub/*.json 2>/dev/null | sort | uniq -c | head; ls /home/sprite/.paseo/agents/home-sprite-workspace-hub/'
echo "===== release hold ====="; sprite exec -s "$S" -- bash -c 'sprite-env curl -s -X DELETE /v1/tasks/hub-run-4; echo rc=$?'
echo "===== hub log tail ====="; tail -n 60 "$HUBLOG" | grep -i "execution\|dispatch\|succeeded\|failed\|timeout\|mcp\|error" | cut -c1-200 | tail -12
