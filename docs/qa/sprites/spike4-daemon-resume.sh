#!/usr/bin/env bash
# Spike 4a (cont.): does the Paseo daemon service keep its identity and come back after a pause?
# Waits for the sprite to pause, then wakes it via exec and compares server id and pid.
set -uo pipefail
S=${1:?sprite}; P=/.sprite/languages/node/nvm/versions/node/v24.18.0
st() { sprite api "/v1/sprites/$S" -- -s 2>/dev/null | grep -o '{.*}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null; }
for i in $(seq 1 16); do s=$(st); echo "$(date -u +%H:%M:%S) status=$s"; [ "$s" = warm ] || [ "$s" = cold ] && break; sleep 15; done
sleep 45
echo "--- wake via exec; daemon status ---"
sprite exec -s "$S" -- bash -c "$P/bin/paseo status 2>&1 | grep -E 'Server ID|Local Daemon|Connected'; echo pid=\$(pgrep -f 'paseo start' | head -1); du -sh /home/sprite/.paseo /home/sprite/.paseo/models 2>/dev/null; tail -n 2 /.sprite/logs/services/paseo.log | cut -c1-200"
sprite api "/v1/sprites/$S/services/paseo" -- -s 2>/dev/null | grep -o '"state":{[^}]*}'
