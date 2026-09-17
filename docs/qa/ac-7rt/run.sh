#!/bin/sh
# Usage: QA_DIR=<private dir> docs/qa/ac-7rt/run.sh <trigger-name> <delivery-key>
# Fires one manual run through the public API on localhost.
K=$(cat "$QA_DIR/api-key")
echo "fire $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))') $1 $2"
curl -s -X POST http://localhost:3000/api/v1/manual-runs -H "Authorization: Bearer $K" \
  -H 'Content-Type: application/json' \
  -d "{\"projectSlug\":\"default\",\"trigger\":\"$1\",\"actor\":\"qa\",\"deliveryKey\":\"$2\",\"input\":\"\"}"; echo
