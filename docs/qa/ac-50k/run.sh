#!/bin/sh
# Usage: QA_DIR=<private dir> docs/qa/ac-50k/run.sh <delivery-key>
K=$(cat "$QA_DIR/api-key"); U=$(cat "$QA_DIR/url")
echo "fire $(perl -MTime::HiRes=time -e 'my $t=time;my @g=gmtime($t);printf "%02d:%02d:%06.3f",$g[2],$g[1],$g[0]+($t-int($t))')"
curl -s -X POST "$U/api/v1/manual-runs" -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d "{\"projectSlug\":\"default\",\"trigger\":\"qa-ac50k-sprite\",\"actor\":\"qa\",\"deliveryKey\":\"$1\",\"input\":\"\"}"; echo
