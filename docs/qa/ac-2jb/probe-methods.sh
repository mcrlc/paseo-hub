#!/bin/sh
# Usage: probe-methods.sh <base-url> <hub-log-file> <label>
# Probes the session and execution MCP routes with non-POST methods and prints
# status line, headers, body, plus the Hub log lines emitted during the probes.
set -u
base="$1"; log="$2"; label="$3"
sid="11111111-2222-4333-8444-555555555555"
before=$(wc -l < "$log")
probe() {
  echo "### $label: $*"
  curl -sS -i --max-time 10 "$@" | head -c 1200
  echo; echo
}
probe -X GET -H 'Accept: application/json' "$base/agent-sessions/$sid/mcp"
probe -X GET -H 'Accept: text/html' "$base/agent-sessions/$sid/mcp"
for m in DELETE PUT PATCH OPTIONS; do probe -X "$m" "$base/agent-sessions/$sid/mcp"; done
probe -I "$base/agent-sessions/$sid/mcp"
probe -X GET -H 'Accept: application/json' "$base/agent-executions/$sid/mcp"
probe -X DELETE "$base/agent-executions/$sid/mcp"
sleep 1
echo "### $label: Hub log lines emitted during probes"
tail -n +"$((before + 1))" "$log" | sed 's/\x1b\[[0-9;]*m//g'
echo "### end of log ($(($(wc -l < "$log") - before)) lines)"
