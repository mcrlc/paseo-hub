#!/bin/sh
# Usage: db-poll.sh <seconds> -- DB only, never touches the sprite. Prints on change, ms wall clock (UTC).
# Machines, daemon presence, newest executions and run. Same shape as ac-52w/r2-db-poll.sh on port 55471.
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(docker exec -i qa-ac7rt-pg psql -U qa -d hub -At -F'|' \
    -c "select 'machine', substr(id::text,1,8), status::text, coalesce(shutdown_reason,'-'), source->>'spriteName' from machines order by started_at" \
    -c "select 'exec', substr(e.id::text,1,8), e.status::text, coalesce(e.hub_action,'-'), coalesce(to_char(e.started_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(to_char(e.completed_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(to_char(e.hub_action_completed_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(e.launch_intent->'environment'->>'machineId','-') from agent_executions e order by e.started_at desc limit 2" \
    -c "select 'run', r.status::text, coalesce(r.failure_reason,'') from trigger_runs r order by r.created_at desc limit 2" \
    -c "select 'daemon', substr(machine_id::text,1,8), presence, to_char(connected_at at time zone 'utc','HH24:MI:SS.MS'), coalesce(to_char(disconnected_at at time zone 'utc','HH24:MI:SS.MS'),'-') from daemons" 2>&1)
  [ "$now" != "$last" ] && { echo "== $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))')"; echo "$now"; last="$now"; }
  sleep 0.5
done
