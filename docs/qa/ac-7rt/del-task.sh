#!/bin/sh
# Usage: del-task.sh <sprite> <task>
# Deletes one in-sprite task by the same path client.ts release uses (DELETE /v1/tasks/:name),
# to make the next refresh face a missing task -- the 404 case of the bead's acceptance criteria.
echo "delete $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))') $2"
sprite api "/v1/sprites/$1/exec?cmd=sprite-env&cmd=curl&cmd=-s&cmd=-X&cmd=DELETE&cmd=/v1/tasks/$2" -- -s -X POST 2>/dev/null \
  | sed -n '/^Calling API\|^URL/!p' | LC_ALL=C tr -d '\001\002\003\000'; echo
