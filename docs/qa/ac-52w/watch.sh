#!/bin/sh
# Usage: docs/qa/ac-52w/watch.sh <seconds> <sprite-name>
# Every 2 s, prints on change (UTC): sprite machine rows + linked daemon presence, sprite provider status
# (GET /v1/sprites/:name does not wake it), and the latest trigger runs with their execution.
P="docker exec -i qa-ac52w-pg psql -U qa -d hub -At -F |"
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  db=$($P -c "select 'machine', m.id, m.status, coalesce(m.shutdown_reason,''), coalesce(d.id::text,'-'), coalesce(d.presence,'-'), coalesce(to_char(d.disconnected_at at time zone 'utc','HH24:MI:SS.MS'),'') from machines m left join daemons d on d.machine_id = m.id where m.source->>'kind'='sprite' order by m.started_at" \
    -c "select 'run', r.id, r.status::text, coalesce(r.failure_reason,''), coalesce(e.id::text,'-'), coalesce(e.status::text,'-'), coalesce(e.launch_intent->'environment'->>'machineId','-'), coalesce(e.result::text,'') from trigger_runs r left join workflow_step_runs s on s.trigger_run_id = r.id left join agent_executions e on e.id = s.agent_execution_id order by r.created_at desc limit 2" 2>&1)
  sp=$(sprite api "/v1/sprites/$2" -- -s 2>/dev/null | grep -o '"status":"[a-z]*"' | head -1)
  now="$db
sprite $sp"
  if [ "$now" != "$last" ]; then echo "== $(date -u +%H:%M:%S)"; echo "$now"; last="$now"; fi
  sleep 2
done
