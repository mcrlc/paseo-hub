#!/bin/sh
# Usage: QA_DIR=<dir> docs/qa/ac-52w/s5-fire-when-paused.sh <sprite-name> <machine-id> <delivery-key> [age-seconds]
# Polls GET /v1/sprites/:name (no wake) and daemons.presence every 1 s. Once the sprite is warm (paused)
# and the pause (last_warming_at) is >= age s old (default 42) while Hub still says connected, fires the run.
S=$1; M=$2; DK=$3; AGE=${4:-42}; last=""
for i in $(seq 280); do
  j=$(sprite api "/v1/sprites/$S" -- -s 2>/dev/null)
  st=$(echo "$j" | grep -o '"status":"[a-z]*"' | head -1 | cut -d'"' -f4)
  lw=$(echo "$j" | grep -o '"last_warming_at":"[^"]*"' | cut -d'"' -f4)
  pr=$(docker exec -i qa-ac52w-pg psql -U qa -d hub -At -c "select presence from daemons where machine_id='$M'")
  now="$st $lw $pr"; [ "$now" != "$last" ] && echo "$(date -u +%T) status=$st last_warming_at=$lw presence=$pr"; last="$now"
  if [ "$st" = warm ]; then
    age=$(( $(date -u +%s) - $(date -j -u -f %Y-%m-%dT%H:%M:%SZ "$lw" +%s) ))
    if [ "$pr" = offline ]; then echo "$(date -u +%T) offline ${age}s after pause, too late"; exit 1; fi
    if [ "$age" -ge "$AGE" ]; then echo "$(date -u +%T) pause age ${age}s presence=$pr -> fire"; "$(dirname "$0")/run.sh" "$DK"; exit 0; fi
  fi
  sleep 1
done
