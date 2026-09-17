#!/usr/bin/env bash
# Spike 5: fire a manual run on the sprite-spike trigger and follow it in the Hub log.
# Usage: spike5-run.sh <delivery-key> "<message>"
set -uo pipefail
K=$(cat /tmp/hub-spike-data/api-key); U=$(cat /tmp/hub-spike-data/hub-url)
DK=${1:?delivery key}; MSG=${2:?message}
python3 -c 'import json,sys; print(json.dumps({"projectSlug":"default","trigger":"sprite-spike","actor":"spike","deliveryKey":sys.argv[1],"input":sys.argv[2]}))' "$DK" "$MSG" > /tmp/hub-spike-data/run.json
date -u +%H:%M:%S; curl -s -X POST "$U/api/v1/manual-runs" -H "Authorization: Bearer $K" -H 'Content-Type: application/json' --data @/tmp/hub-spike-data/run.json; echo
