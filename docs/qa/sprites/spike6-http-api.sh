#!/bin/bash
# Spike 6: drive the whole provider surface over the Sprites HTTP API, no CLI exec, no WebSocket.
# `sprite api` is only an authenticated curl; Hub would send the same requests with fetch() and
# `Authorization: Bearer $SPRITES_TOKEN`. Decode exec bodies with spike6-decode.mjs.
set -u
S=${1:-hub-spike-3}
D="$(dirname "$0")/spike6-decode.mjs"
api() { sprite api "$@" 2>/dev/null | grep -a -v -E '^(Calling API|URL:)'; }
x() { api "/v1/sprites/$S/exec?$1" -- -sS -m "${2:-60}" -X POST ${3:+--data-binary "$3"} | node "$D"; }
enc() { node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"; }

echo "=== create ==="; api /v1/sprites -- -s -X POST -H 'Content-Type: application/json' -d "{\"name\":\"$S\"}" -w '\nhttp=%{http_code}\n'
echo "=== memory policy ==="; api "/v1/sprites/$S/policy/resources" -- -s -X POST -H 'Content-Type: application/json' -d '{"memory":{"limit_mb":16384}}' -w 'http=%{http_code}\n'; api "/v1/sprites/$S/policy/resources" -- -s; echo
echo "=== exec: stdout, stderr, exit code, env, dir ==="
x "cmd=sh&cmd=-c&cmd=$(enc 'echo out; echo err >&2; exit 3')"
x "cmd=sh&cmd=-c&cmd=$(enc 'echo FOO=$FOO USER=$(id -un) PWD=$PWD; echo PATH=$PATH')&env=$(enc FOO=bar)&dir=/tmp"
echo "=== exec: script over stdin (how bootstrap would be sent) ==="
x "cmd=sh&cmd=-s&stdin=true" 60 $'echo line1\necho line2 >&2\nexit 7\n'
echo "=== tasks are not reachable from outside ==="; api "/v1/sprites/$S/tasks" -- -s -o /dev/null -w 'http=%{http_code}\n'
echo "=== hold / conflict / refresh / release via exec ==="
body=$(enc '{"name":"hub-hold","expire":"5m"}')
x "cmd=sprite-env&cmd=curl&cmd=-s&cmd=-X&cmd=POST&cmd=/v1/tasks&cmd=-d&cmd=$body"
x "cmd=sprite-env&cmd=curl&cmd=-sf&cmd=-X&cmd=POST&cmd=/v1/tasks&cmd=-d&cmd=$body"
x "cmd=sprite-env&cmd=curl&cmd=-s&cmd=-X&cmd=PUT&cmd=/v1/tasks/hub-hold&cmd=-d&cmd=$body"
x "cmd=sprite-env&cmd=curl&cmd=-s&cmd=-X&cmd=DELETE&cmd=/v1/tasks/hub-hold"
x "cmd=sprite-env&cmd=curl&cmd=-sf&cmd=-X&cmd=DELETE&cmd=/v1/tasks/hub-hold"
echo "=== service: put, same-cmd put ignored, delete, put with new env ==="
svc='{"cmd":"/bin/sh","args":["-c","while true; do date >> /home/sprite/probe.log; sleep 5; done"],"env":{"PROBE":"%s"},"dir":"/home/sprite"}'
api "/v1/sprites/$S/services/probe" -- -s -X PUT -H 'Content-Type: application/json' -d "$(printf "$svc" 1)"; echo
api "/v1/sprites/$S/services/probe" -- -s -X PUT -H 'Content-Type: application/json' -d "$(printf "$svc" 2)"; echo
api "/v1/sprites/$S/services/probe" -- -s -X DELETE -w 'delete http=%{http_code}\n'
api "/v1/sprites/$S/services/probe" -- -s -X PUT -H 'Content-Type: application/json' -d "$(printf "$svc" 2)"; echo
api "/v1/sprites/$S/services/probe" -- -s | grep -o '"env":{[^}]*}'
echo "=== destroy ==="; api "/v1/sprites/$S" -- -s -X DELETE -w 'http=%{http_code}\n'
