#!/bin/bash
# Capture real exec response bodies (HTTP/2 and HTTP/1.1) from api.sprites.dev through the logged-in
# `sprite api` (an authenticated curl), decode them with the PR's decodeExec, and check that a PUT on a
# task that does not exist creates it (the assumption hold() relies on). Destroys its sprite at the end.
set -u
S=${1:?sprite name}
DIR=$(mktemp -d)
api() { sprite api "$@" 2>/dev/null | grep -a -v -E '^(Calling API|URL:)'; }
enc() { node -e 'console.log(encodeURIComponent(process.argv[1]))' "$1"; }
raw() { sprite api "/v1/sprites/$S/exec?$2" -- -sS -m 60 -X POST $3 -o "$DIR/$1" ${4:+--data-binary "$4"} >/dev/null 2>&1; echo "--- $1 ($(wc -c < "$DIR/$1" | tr -d ' ') bytes) head=$(xxd -p "$DIR/$1" | tr -d '\n' | head -c 60) tail=$(xxd -p "$DIR/$1" | tr -d '\n' | tail -c 12)"; npx tsx -e "import {decodeExec} from './src/daemons/sprites/client.ts'; import {readFileSync} from 'node:fs'; const r=decodeExec(new Uint8Array(readFileSync('$DIR/$1'))); console.log(JSON.stringify({...r, stdout: r.stdout.length>200 ? '<'+r.stdout.length+' chars, all x: '+/^x+\\n\$/.test(r.stdout)+'>' : r.stdout}))"; }

api /v1/sprites -- -s -X POST -H 'Content-Type: application/json' -d "{\"name\":\"$S\"}" -o /dev/null -w 'create http=%{http_code}\n'
C1=$(enc 'echo out; echo err >&2; exit 3')
raw h2-interleaved "cmd=sh&cmd=-c&cmd=$C1" ""
raw h11-interleaved "cmd=sh&cmd=-c&cmd=$C1" "--http1.1"
raw h2-5000 "cmd=sh&cmd=-c&cmd=$(enc 'head -c 4999 /dev/zero | tr "\0" x; echo')" ""
raw h2-utf8 "cmd=sh&cmd=-c&cmd=$(enc 'printf "héllo ✓ 日本\n"; printf "ошибка\n" >&2; exit 200')" ""
raw h11-exit10 "cmd=sh&cmd=-c&cmd=$(enc 'exit 10')" "--http1.1"
raw h2-stdin "cmd=sh&cmd=-s&stdin=true" "" $'echo line1\necho line2 >&2\necho line3\nexit 7\n'
echo "=== task PUT on a missing name (hold's upsert), PUT again, DELETE, DELETE again ==="
B=$(enc '{"name":"hub-verify","expire":"5m"}')
for step in "PUT&cmd=/v1/tasks/hub-verify&cmd=-d&cmd=$B" "PUT&cmd=/v1/tasks/hub-verify&cmd=-d&cmd=$B" "DELETE&cmd=/v1/tasks/hub-verify" "DELETE&cmd=/v1/tasks/hub-verify"; do
  raw task "cmd=sprite-env&cmd=curl&cmd=-s&cmd=-X&cmd=$step" ""
done
api "/v1/sprites/$S" -- -s -X DELETE -w 'destroy http=%{http_code}\n'
api "/v1/sprites/$S" -- -s -o /dev/null -w 'get after destroy http=%{http_code}\n'
rm -rf "$DIR"
