#!/bin/sh
# Usage: sprite-exec.sh <sprite> <sh-command>   -- one exec of `sh -c <command>`; this WAKES a paused sprite.
sprite api "/v1/sprites/$1/exec?cmd=sh&cmd=-c&cmd=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$2")" -- -s -X POST 2>/dev/null \
  | sed -n '/^Calling API\|^URL/!p' | LC_ALL=C tr -d '\001\002\003\000'
