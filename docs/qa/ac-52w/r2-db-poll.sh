#!/bin/sh
# Usage: db-poll.sh <seconds>  -- DB only, never touches the sprite. Prints on change with ms-resolution wall clock.
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(docker exec -i qa-ac52w-pg psql -U qa -d hub -At -F'|' \
    -c "select 'exec', substr(e.id::text,1,8), e.status::text, coalesce(e.hub_action,'-'), coalesce(to_char(e.completed_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(to_char(e.hub_action_ready_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(to_char(e.hub_action_completed_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(e.result::text,'') from agent_executions e order by e.started_at desc limit 2" \
    -c "select 'run', r.status::text, coalesce(r.failure_reason,'') from trigger_runs r order by r.created_at desc limit 1" \
    -c "select 'daemon', presence, to_char(connected_at at time zone 'utc','HH24:MI:SS.MS'), coalesce(to_char(disconnected_at at time zone 'utc','HH24:MI:SS.MS'),'-') from daemons" 2>&1)
  [ "$now" != "$last" ] && { echo "== $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))')"; echo "$now"; last="$now"; }
  sleep 0.5
done
