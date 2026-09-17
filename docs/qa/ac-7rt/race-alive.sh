#!/bin/sh
# Usage: QA_DIR=<dir> docs/qa/ac-7rt/race-alive.sh <attempt-n>
# Scenario 5: produce a `spawning` machine row that already has a bound daemon, so restart recovery
# takes the reconcile-to-alive branch instead of the terminate branch. The window is the gap between
# enrollment inserting the daemon row and the lifecycle transitioning the row to `alive` (measured
# under 1 s). Terminate trigger B's row, fire a run to force the recreate path, then poll the machine
# status and its daemon count as fast as docker exec allows and kill -9 Hub the instant the row is
# still `spawning` and a daemon exists.
set -e
cd "$(dirname "$0")/../../.."
docker exec -i qa-ac7rt-pg psql -U qa -d hub -At -c \
  "update machines set status='terminated', shutdown_reason='qa race attempt $1' where source->>'spriteName' like 'trigger-3315590f%' and status <> 'terminated'" > /dev/null
docs/qa/ac-7rt/run.sh qa-ac7rt-sprite-b "qa-7rt-s5-attempt$1"
PID=$(cat "$QA_DIR/hub.pid")
i=0
while [ "$i" -lt 4000 ]; do
  R=$(docker exec -i qa-ac7rt-pg psql -U qa -d hub -At -F'|' -c \
    "select m.id, m.status, (select count(*) from daemons d where d.machine_id=m.id) from machines m where m.source->>'spriteName' like 'trigger-3315590f%' and m.status <> 'terminated' limit 1" 2>/dev/null)
  case "$R" in
    *"|spawning|1"*)
      echo "HIT $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))') $R"
      kill -9 "$PID"; echo "killed pid $PID"; echo "$R" > "$QA_DIR/s5-hit"; exit 0;;
    *"|alive|"*) echo "MISS $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))') row went alive before the poll caught spawning+daemon: $R"; exit 1;;
  esac
  i=$((i+1))
done
echo "MISS timed out"; exit 1
