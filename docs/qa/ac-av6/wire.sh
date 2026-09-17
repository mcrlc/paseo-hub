#!/bin/zsh
# Usage: wire.sh <subcommand> ...   (against the production build: node dist/index.js on Postgres)
#   snapshot <base> <slug> <state.json|none>          raw GET of spritesSettingsSnapshot
#   save <base> <slug> <state.json|none> <token-file> raw POST of saveSpritesSettings (memoryMb 8192)
#   setenv <base> <slug> <state.json|none> <key> <value>
#                                                     raw POST of setSpritesEnv
#   rmenv <base> <slug> <state.json|none> <key>       raw POST of removeSpritesEnv
#   page <base> <slug> <state.json>                   raw GET of /o/<slug>/settings/sprites (SSR HTML)
#   rows <pg-container>                               every organization_sprites_configuration row, token redacted
# Server-function ids are read from .output/server/assets/functions-*.js of this build.
set -eu
SNAPSHOT_FN=0b5193d78110ddc23b5da169e50d2f2d33893954a9938dc47f8cbdc33caefb93
SAVE_FN=76522ab385cab7d2d1a2f76850d758df52966bdd6dba3a45c91a83a1cf1be5bb
SETENV_FN=a9da5ccd0f56ebd45c44089e07123b9139f99bda31a6270a4c5cfa2780b80deb
RMENV_FN=3ca31b6fc7bb7a152e68951fc16f295ad54a1b605ddf54b7cddc0d2b1ac92394
strip() { /usr/bin/grep -a -iv '^date:\|^connection:\|^keep-alive:\|^set-cookie:' }
cookie() {
  [[ "$1" == none ]] && return 0
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(s.cookies.map(c=>`${c.name}=${c.value}`).join("; "))' "$1"
}
# body <json-object-of-string-fields>: TanStack Start serialized payload with string fields
body() {
  node -e '
    const o = JSON.parse(process.argv[1]);
    const k = Object.keys(o), v = k.map((key) => (typeof o[key] === "number" ? {t:0,s:o[key]} : {t:1,s:o[key]}));
    process.stdout.write(JSON.stringify({t:{t:10,i:0,p:{k:["data"],v:[{t:10,i:1,p:{k,v},o:0}]},o:0},f:63,m:[]}));
  ' "$1"
}
post() {
  local base=$1 fn=$2 state=$3 payload=$4 shown=$5
  echo "> POST $base/_serverFn/$fn  cookie: $([[ $state == none ]] && echo none || echo "<session of ${state:t:r}>")"
  echo "> data: $shown"
  curl -sS -i -X POST "$base/_serverFn/$fn" -H "cookie: $(cookie $state)" -H "origin: $base" \
    -H 'content-type: application/json' -H 'x-tsr-serverfn: true' -H 'sec-fetch-site: same-origin' \
    -H 'accept: application/x-tss-framed, application/x-ndjson, application/json' -d "$payload" | strip
  echo
}
cmd=$1; shift
case $cmd in
  snapshot)
    base=$1 slug=$2 state=$3
    payload=$(node -e 'process.stdout.write(encodeURIComponent(JSON.stringify({t:{t:10,i:0,p:{k:["data"],v:[{t:10,i:1,p:{k:["organizationSlug"],v:[{t:1,s:process.argv[1]}]},o:0}]},o:0},f:63,m:[]})))' "$slug")
    echo "> GET snapshot  cookie: $([[ $state == none ]] && echo none || echo "<session of ${state:t:r}>")"
    curl -sS -i "$base/_serverFn/$SNAPSHOT_FN?payload=$payload" -H "cookie: $(cookie $state)" \
      -H 'x-tsr-serverfn: true' -H 'sec-fetch-site: same-origin' -H 'accept: application/x-tss-framed, application/x-ndjson, application/json' | strip
    echo
    ;;
  save)
    base=$1 slug=$2 state=$3 tokenfile=$4
    token=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).token)' "$tokenfile")
    post "$base" $SAVE_FN "$state" "$(body "{\"organizationSlug\":\"$slug\",\"token\":\"$token\",\"memoryMb\":8192}")" "{organizationSlug:$slug, token:<temporary Sprites token>, memoryMb:8192}"
    ;;
  setenv)
    base=$1 slug=$2 state=$3 key=$4 value=$5
    json=$(node -e 'process.stdout.write(JSON.stringify({organizationSlug:process.argv[1],key:process.argv[2],value:process.argv[3]}))' "$slug" "$key" "$value")
    shown=$json; (( ${#value} > 80 )) && shown="{organizationSlug:$slug, key:$key, value:<${#value} chars>}"
    post "$base" $SETENV_FN "$state" "$(body "$json")" "$shown"
    ;;
  rmenv)
    base=$1 slug=$2 state=$3 key=$4
    json=$(node -e 'process.stdout.write(JSON.stringify({organizationSlug:process.argv[1],key:process.argv[2]}))' "$slug" "$key")
    post "$base" $RMENV_FN "$state" "$(body "$json")" "$json"
    ;;
  page)
    base=$1 slug=$2 state=$3
    curl -sS -i "$base/o/$slug/settings/sprites" -H "cookie: $(cookie $state)" -H 'accept: text/html' | strip
    ;;
  rows)
    docker exec "$1" psql -U postgres -d hub -c "select c.organization_id, o.slug, left(c.token, 6) || '…' as token_prefix, c.memory_mb, c.env, c.updated_by_user_id, c.updated_at from organization_sprites_configuration c join organization o on o.id = c.organization_id order by o.slug"
    ;;
esac
