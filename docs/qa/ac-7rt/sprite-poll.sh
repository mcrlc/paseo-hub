#!/bin/sh
# Usage: sprite-poll.sh <seconds> <sprite> -- GET /v1/sprites/:name only; this does NOT wake the sprite.
end=$(( $(date +%s) + $1 )); last=""
while [ "$(date +%s)" -lt "$end" ]; do
  j=$(sprite api "/v1/sprites/$2" -- -s 2>/dev/null)
  now="status=$(echo "$j"|grep -o '"status":"[a-z]*"'|head -1|cut -d'"' -f4) last_running_at=$(echo "$j"|grep -o '"last_running_at":"[^"]*"'|cut -d'"' -f4) last_warming_at=$(echo "$j"|grep -o '"last_warming_at":[^,}]*'|cut -d: -f2-)"
  [ "$now" != "$last" ] && { echo "$(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))') $now"; last="$now"; }
  sleep 1
done
