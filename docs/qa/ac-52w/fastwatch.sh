#!/bin/sh
# Usage: docs/qa/ac-52w/fastwatch.sh <seconds> <machine-id>
# DB-only (never touches the sprite): every 0.5 s prints on change the sprite daemon presence/connected_at and the
# newest run with its execution status, started_at, and intent machineId.
P="docker exec -i qa-ac52w-pg psql -U qa -d hub -At -F |"
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  now=$($P -c "select 'daemon', presence, to_char(connected_at at time zone 'utc','HH24:MI:SS.MS'), to_char(disconnected_at at time zone 'utc','HH24:MI:SS.MS') from daemons where machine_id='$2'" \
    -c "select 'run', r.status::text, coalesce(r.failure_reason,''), coalesce(e.id::text,'-'), coalesce(e.status::text,'-'), coalesce(to_char(e.started_at at time zone 'utc','HH24:MI:SS.MS'),''), coalesce(e.launch_intent->'environment'->>'machineId','-'), coalesce(e.daemon_agent_id,'') from trigger_runs r left join workflow_step_runs s on s.trigger_run_id = r.id left join agent_executions e on e.id = s.agent_execution_id order by r.created_at desc limit 1")
  if [ "$now" != "$last" ]; then echo "== $(date -u +%H:%M:%S) $(perl -MTime::HiRes=time -e 'printf "%.1f", time')"; echo "$now"; last="$now"; fi
  case "$now" in *"run|failed"*|*"run|succeeded"*) break;; esac
  sleep 0.5
done
