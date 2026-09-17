#!/bin/zsh
# Usage: wire.sh <subcommand> ...   (run against the production build: node dist/index.js on Postgres)
#   cookie <state.json>                          print the Cookie header value from a Playwright storage state
#   snapshot <base> <slug> <state.json|none>     raw GET of the spritesSettingsSnapshot server function
#   save <base> <slug> <state.json|none> <token> [memoryMb|omit]
#                                                raw POST of the saveSpritesSettings server function
#   page <base> <slug> <state.json>              raw GET of /o/<slug>/settings/sprites (SSR HTML)
#   row <pg-container>                           the stored organization_sprites_configuration row
# Server-function ids are the ones the admin's browser used against this build (see ui-first.log).
set -eu
SNAPSHOT_FN=0b5193d78110ddc23b5da169e50d2f2d33893954a9938dc47f8cbdc33caefb93
SAVE_FN=76522ab385cab7d2d1a2f76850d758df52966bdd6dba3a45c91a83a1cf1be5bb
strip() { grep -iv '^date:\|^connection:\|^keep-alive:\|^set-cookie:' }
cookie() {
  [[ "$1" == none ]] && return 0
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(s.cookies.map(c=>`${c.name}=${c.value}`).join("; "))' "$1"
}
cmd=$1; shift
case $cmd in
  cookie) cookie "$1" ;;
  snapshot)
    base=$1 slug=$2 state=$3
    payload=$(node -e 'process.stdout.write(encodeURIComponent(JSON.stringify({t:{t:10,i:0,p:{k:["data"],v:[{t:10,i:1,p:{k:["organizationSlug"],v:[{t:1,s:process.argv[1]}]},o:0}]},o:0},f:63,m:[]})))' "$slug")
    curl -sS -i "$base/_serverFn/$SNAPSHOT_FN?payload=$payload" -H "cookie: $(cookie $state)" \
      -H 'x-tsr-serverfn: true' -H 'sec-fetch-site: same-origin' -H 'accept: application/x-tss-framed, application/x-ndjson, application/json' | strip
    ;;
  save)
    base=$1 slug=$2 state=$3 token=$4 memory=${5:-omit}
    body=$(node -e '
      const [slug, token, memory] = process.argv.slice(1);
      const k = ["organizationSlug", "token"], v = [{t:1,s:slug}, {t:1,s:token}];
      if (memory !== "omit") { k.push("memoryMb"); v.push({t:0,s:Number(memory)}); }
      process.stdout.write(JSON.stringify({t:{t:10,i:0,p:{k:["data"],v:[{t:10,i:1,p:{k,v},o:0}]},o:0},f:63,m:[]}));
    ' "$slug" "$token" "$memory")
    echo "> POST $base/_serverFn/$SAVE_FN  cookie: $([[ $state == none ]] && echo none || echo "<session of ${state:t:r}>")"
    echo "> body: $body"
    curl -sS -i -X POST "$base/_serverFn/$SAVE_FN" -H "cookie: $(cookie $state)" -H "origin: $base" \
      -H 'content-type: application/json' -H 'x-tsr-serverfn: true' -H 'sec-fetch-site: same-origin' \
      -H 'accept: application/x-tss-framed, application/x-ndjson, application/json' -d "$body" | strip
    echo
    ;;
  page)
    base=$1 slug=$2 state=$3
    curl -sS -i "$base/o/$slug/settings/sprites" -H "cookie: $(cookie $state)" -H 'accept: text/html' | strip
    ;;
  row)
    docker exec "$1" psql -U postgres -d hub -x -c "select organization_id, token, memory_mb, updated_by_user_id, updated_at from organization_sprites_configuration"
    ;;
esac
