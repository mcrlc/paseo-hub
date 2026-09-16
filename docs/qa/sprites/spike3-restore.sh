#!/usr/bin/env bash
# Spike 3 proxy for cold wake: checkpoint + restore restarts the environment ("active sessions are
# terminated"). Checks that services come back and the daemon keeps its on-disk identity.
set -uo pipefail
S=${1:?sprite}; P=/.sprite/languages/node/nvm/versions/node/v24.18.0
echo "--- before ---"
sprite exec -s "$S" -- bash -c "$P/bin/paseo status 2>&1 | grep -E 'Server ID'; echo pid=\$(pgrep -f 'paseo start' | head -1); cat /proc/sys/kernel/random/boot_id"
echo "--- checkpoint ---"; sprite checkpoint create -s "$S" 2>&1 | tail -3
CK=$(sprite checkpoint list -s "$S" 2>&1 | grep -oE '\bv[0-9]+\b' | tail -1); echo "checkpoint=$CK"
echo "--- restore ---"; T0=$(date +%s); sprite restore -s "$S" "$CK" 2>&1 | tail -3
for i in $(seq 1 20); do sleep 5
  out=$(sprite exec -s "$S" -- bash -c "$P/bin/paseo status 2>&1 | grep -E 'Server ID|Local Daemon'; echo pid=\$(pgrep -f 'paseo start' | head -1); cat /proc/sys/kernel/random/boot_id" 2>&1)
  if echo "$out" | grep -q "running"; then echo "daemon back after $(( $(date +%s)-T0 ))s"; echo "$out"; break; fi
  echo "$(date -u +%H:%M:%S) not yet: $(echo "$out" | tr '\n' ' ' | cut -c1-120)"
done
sprite api "/v1/sprites/$S/services" -- -s 2>/dev/null | grep -o '"state":{[^}]*}'
