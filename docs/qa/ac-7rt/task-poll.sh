#!/bin/sh
# Usage: task-poll.sh <seconds> <sprite> <interval> -- execs `sprite-env curl /v1/tasks` every <interval> s,
# the same path client.ts hold/release use. The hold task carries started_at and expires_at; a refresh PUT
# moves them forward, which is how a refresh is proved (the refresh path logs nothing on success).
# NOTE: an exec wakes a paused sprite; only run it while a run is held or when a wake does not matter.
end=$(( $(date +%s) + $1 )); iv=${3:-30}
while [ "$(date +%s)" -lt "$end" ]; do
  t=$(sprite api "/v1/sprites/$2/exec?cmd=sprite-env&cmd=curl&cmd=-s&cmd=/v1/tasks" -- -s -X POST 2>/dev/null \
      | sed -n '/^Calling API\|^URL/!p' | LC_ALL=C tr -d '\001\002\003\000')
  echo "$(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))') $t"
  sleep "$iv"
done
