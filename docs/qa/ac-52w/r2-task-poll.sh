#!/bin/sh
# Usage: task-poll.sh <seconds> <sprite>  -- execs `sprite-env curl /v1/tasks` every 1 s (same path client.ts uses).
# NOTE: an exec wakes a paused sprite. Stops only after the hold has been SEEN and is then empty twice in a row.
end=$(( $(date +%s) + $1 )); empty=0; seen=0
while [ "$(date +%s)" -lt "$end" ]; do
  t=$(sprite api "/v1/sprites/$2/exec?cmd=sprite-env&cmd=curl&cmd=-s&cmd=/v1/tasks" -- -s -X POST 2>/dev/null \
      | sed -n '/^Calling API\|^URL/!p' | LC_ALL=C tr -d '\001\002\003\000')
  echo "$(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))') $t"
  case "$t" in *'"tasks":[]'*|*'"tasks":null'*) empty=$((empty+1));; *) empty=0; seen=1;; esac
  [ "$seen" = 1 ] && [ "$empty" -ge 2 ] && break
  sleep 1
done
