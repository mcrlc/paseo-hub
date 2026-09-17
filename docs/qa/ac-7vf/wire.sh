#!/bin/zsh
# Usage: wire.sh recreate <base> <slug> <state.json|none> <triggerId>
# Raw POST of the recreateSprite server function, the way the browser sends it.
# The id is read from .output/server/assets/functions-B11mzLTJ.js of the build under test.
set -eu
RECREATE_FN=0bb0ea8e01d9b86ff50d2aaefe133428e6fc7b52fe98a6e09f2c42acba3503ca
strip() { /usr/bin/grep -a -iv '^date:\|^connection:\|^keep-alive:\|^set-cookie:' }
cookie() {
  [[ "$1" == none ]] && return 0
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(s.cookies.map(c=>`${c.name}=${c.value}`).join("; "))' "$1"
}
body() {
  node -e '
    const o = JSON.parse(process.argv[1]);
    const k = Object.keys(o), v = k.map((key) => ({t:1,s:o[key]}));
    process.stdout.write(JSON.stringify({t:{t:10,i:0,p:{k:["data"],v:[{t:10,i:1,p:{k,v},o:0}]},o:0},f:63,m:[]}));
  ' "$1"
}
cmd=$1; shift
case $cmd in
  recreate)
    base=$1 slug=$2 state=$3 trigger=$4
    json=$(node -e 'process.stdout.write(JSON.stringify({organizationSlug:process.argv[1],triggerId:process.argv[2]}))' "$slug" "$trigger")
    echo "> POST $base/_serverFn/$RECREATE_FN  cookie: $([[ $state == none ]] && echo none || echo "<session of ${state:t:r}>")"
    echo "> data: $json"
    curl -sS -i -X POST "$base/_serverFn/$RECREATE_FN" -H "cookie: $(cookie $state)" -H "origin: $base" \
      -H 'content-type: application/json' -H 'x-tsr-serverfn: true' -H 'sec-fetch-site: same-origin' \
      -H 'accept: application/x-tss-framed, application/x-ndjson, application/json' -d "$(body "$json")" | strip
    echo
    ;;
esac
