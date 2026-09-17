#!/bin/zsh
# Usage: install.sh <private-dir> <trigger.yml>   POST /api/v1/triggers/install through the tunnel.
T=$1
node -e 'process.stdout.write(JSON.stringify({yaml:require("fs").readFileSync(process.argv[1],"utf8")}))' "$2" |
  curl -sS -X POST "$(cat $T/tunnel)/api/v1/triggers/install" -H "authorization: Bearer $(cat $T/api-key)" \
    -H 'content-type: application/json' --data-binary @- -w '\nHTTP %{http_code} total %{time_total}s\n'
