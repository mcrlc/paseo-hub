#!/bin/sh
# Usage: db-poll.sh <seconds>  -- Postgres only, never touches the sprite. Prints on change.
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(docker exec -i qa-ac50k-pg psql -U qa -d hub -At -F'|' \
    -c "select 'machine', substr(id::text,1,8), status::text, coalesce(shutdown_reason,'-'), specs::text from machines order by started_at" \
    -c "select 'daemon', substr(id::text,1,8), status::text, presence, coalesce(to_char(connected_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(to_char(disconnected_at at time zone 'utc','HH24:MI:SS.MS'),'-'), substr(coalesce(machine_id::text,'-'),1,8) from daemons order by created_at" \
    -c "select 'exec', substr(e.id::text,1,8), e.status::text, substr(coalesce(e.daemon_id::text,'-'),1,8), coalesce(e.agent_session_action,'-'), coalesce(to_char(e.completed_at at time zone 'utc','HH24:MI:SS.MS'),'-'), coalesce(e.result::text,'') from agent_executions e order by e.started_at desc limit 3" \
    -c "select 'run', r.status::text, coalesce(r.failure_reason,'') from trigger_runs r order by r.created_at desc limit 2" \
    -c "select 'session', substr(id::text,1,8), coalesce(continuation_key,'-'), substr(coalesce(data->>'daemonId','-'),1,8), substr(coalesce(data->>'agentId','-'),1,8) from agent_sessions" 2>&1)
  [ "$now" != "$last" ] && { echo "== $(perl -MTime::HiRes=time -e 'my $t=time;my @g=gmtime($t);printf "%02d:%02d:%06.3f",$g[2],$g[1],$g[0]+($t-int($t))')"; echo "$now"; last="$now"; }
  sleep 0.5
done
