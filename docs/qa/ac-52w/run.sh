#!/bin/sh
# Usage: QA_DIR=<private dir> docs/qa/ac-52w/run.sh <delivery-key>
# Fires one manual run on qa-ac52w-sprite through the public API (tunnel URL and API key read from QA_DIR).
K=$(cat "$QA_DIR/api-key"); U=$(cat "$QA_DIR/url")
echo "fire $(date -u +%H:%M:%S)"
curl -s -X POST "$U/api/v1/manual-runs" -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d "{\"projectSlug\":\"default\",\"trigger\":\"qa-ac52w-sprite\",\"actor\":\"qa\",\"deliveryKey\":\"$1\",\"input\":\"\"}"; echo
