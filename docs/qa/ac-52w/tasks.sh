#!/bin/sh
# Usage: docs/qa/ac-52w/tasks.sh <sprite-name>
# Lists the in-sprite tasks (hold = task named by execution id) with an exec of `sprite-env curl /v1/tasks`,
# the same path client.ts hold/release use. NOTE: an exec wakes a paused sprite, so only call it while a run is held
# or when a wake does not matter. Control bytes of the exec frame format are stripped.
echo "tasks $(date -u +%H:%M:%S)"
sprite api "/v1/sprites/$1/exec?cmd=sprite-env&cmd=curl&cmd=-s&cmd=/v1/tasks" -- -s -X POST 2>/dev/null \
  | sed -n '/^Calling API\|^URL/!p' | LC_ALL=C tr -d '\001\002\003\000'; echo
