#!/bin/sh
# Usage: QA_DIR=<private dir> docs/qa/ac-50k/install.sh <trigger.yml>
# POSTs the YAML to /api/v1/triggers/install and prints the wall-clock latency of the save.
# Installing the same trigger name again reuses the trigger id, so this is an edit.
K=$(cat "$QA_DIR/api-key"); U=$(cat "$QA_DIR/url")
BODY=$(node -e 'console.log(JSON.stringify({yaml:require("fs").readFileSync(process.argv[1],"utf8")}))' "$1")
echo "save $1 at $(date -u +%H:%M:%S.%3N 2>/dev/null || perl -MTime::HiRes=time -e 'my $t=time;my @g=gmtime($t);printf "%02d:%02d:%06.3f\n",$g[2],$g[1],$g[0]+($t-int($t))')"
S=$(perl -MTime::HiRes=time -e 'print time')
curl -s -w '\nHTTP %{http_code}\n' -X POST "$U/api/v1/triggers/install" \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d "$BODY"
perl -e "printf \"latency %.3f s\n\", time - $S" -MTime::HiRes=time
