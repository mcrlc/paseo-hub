#!/bin/sh
# Usage: docs/qa/ac-vni/s4-watch.sh <seconds> > log
# Samples sprite machine rows and daemons every 2 s with a UTC timestamp (only prints on change).
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(docker exec qa-acvni-pg psql -U qa -d hub -At -F ' | ' -c "select m.id, m.status, m.source->>'spriteName', m.specs::text, coalesce(m.shutdown_reason,''), coalesce(d.slug,'-'), coalesce(d.presence,'-') from machines m left join daemons d on d.machine_id = m.id where m.source->>'kind'='sprite' order by m.started_at")
  if [ "$now" != "$last" ]; then echo "== $(date -u +%H:%M:%S)"; echo "$now"; last="$now"; fi
  sleep 2
done
