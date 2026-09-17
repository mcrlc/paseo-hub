#!/bin/sh
# Usage: watch.sh <seconds>   samples sprite machine rows and their daemon every 2 s, prints on change (UTC).
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(docker exec qa-acwri-pg psql -U qa -d hub -At -F ' | ' -c "select m.source->>'spriteName', m.status, m.specs::text, coalesce(m.shutdown_reason,''), coalesce(d.presence,'-'), coalesce(to_char(d.connected_at,'HH24:MI:SS.MS'),'-'), coalesce(to_char(d.disconnected_at,'HH24:MI:SS.MS'),'-') from machines m left join daemons d on d.machine_id = m.id where m.source->>'kind'='sprite' order by m.started_at")
  if [ "$now" != "$last" ]; then echo "== $(date -u +%H:%M:%S)"; echo "$now"; last="$now"; fi
  sleep 2
done
