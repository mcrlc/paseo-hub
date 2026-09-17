#!/usr/bin/env bash
# Spike 2: wake and hold from outside.
#  a. time an authenticated GET to the sprite URL from a paused sprite; status after
#  b. does an exec against a paused sprite wake it on its own
#  c. Tasks API from outside: hold past the idle window, refresh by re-POST, release by DELETE
# Usage: [SPRITE_TOKEN=<org token>] spike2-wake-hold.sh <sprite> <phase: url|exec|hold>
# Without a token the sprite URL must be set to --auth public first (throwaway sprites only).
set -uo pipefail
S=${1:?sprite}; PHASE=${2:?phase}
status() { sprite api "/v1/sprites/$S" -- -s 2>/dev/null | grep -o '{.*}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["status"], d["last_running_at"])'; }
stamp() { date -u +%H:%M:%S; }
case "$PHASE" in
  url)
    URL=$(sprite url -s "$S" 2>/dev/null | grep -o 'https://[^ ]*' | tail -1)
    echo "$(stamp) before: $(status)"
    T0=$(python3 -c 'import time;print(time.time())')
    curl -s -o /dev/null -w "http=%{http_code} ttfb=%{time_starttransfer}s\n" ${SPRITE_TOKEN:+-H "Authorization: Bearer $SPRITE_TOKEN"} "$URL/"
    python3 -c "import time;print('wall=%.2fs' % (time.time()-$T0))"
    echo "$(stamp) after:  $(status)"
    ;;
  exec)
    echo "$(stamp) before: $(status)"
    T0=$(python3 -c 'import time;print(time.time())')
    sprite exec -s "$S" -- bash -c 'echo exec-ok; uptime -s'
    python3 -c "import time;print('wall=%.2fs' % (time.time()-$T0))"
    echo "$(stamp) after:  $(status)"
    ;;
  hold)
    echo "$(stamp) before: $(status)"
    sprite exec -s "$S" -- bash -c 'sprite-env curl -s -X POST /v1/tasks -d "{\"name\":\"hub-hold\",\"expire\":\"5m\"}"; echo; sprite-env curl -s /v1/tasks; echo'
    for i in 1 2 3 4 5 6; do sleep 15; echo "$(stamp) held:   $(status)"; done
    echo "--- refresh (re-POST same name) ---"
    sprite exec -s "$S" -- bash -c 'sprite-env curl -s -X POST /v1/tasks -d "{\"name\":\"hub-hold\",\"expire\":\"5m\"}"; echo; sprite-env curl -s /v1/tasks; echo'
    echo "--- release ---"
    sprite exec -s "$S" -- bash -c 'sprite-env curl -s -X DELETE /v1/tasks/hub-hold -w "%{http_code}\n"; sprite-env curl -s /v1/tasks; echo'
    for i in 1 2 3 4 5 6; do sleep 15; echo "$(stamp) released: $(status)"; done
    ;;
esac
