#!/usr/bin/env bash
# Spike 4a: time a real bootstrap on a fresh sprite as the non-root `sprite` user:
# Paseo CLI + Claude Code CLI via npm -g, plus a clone. No Hub or keys needed.
set -uo pipefail
S=${1:?sprite}
sprite exec -s "$S" -- bash -c '
set -u
t() { local s=$(date +%s); "$@" >/tmp/step.log 2>&1; local rc=$?; echo "$(( $(date +%s)-s ))s rc=$rc  $*"; [ $rc -ne 0 ] && tail -5 /tmp/step.log; }
echo "npm prefix: $(npm prefix -g)"
t npm install -g @getpaseo/cli
t npm install -g @anthropic-ai/claude-code
t git clone --depth 1 https://github.com/getpaseo/hub /home/sprite/workspace/hub
echo "--- versions ---"
paseo --version 2>&1 | head -1; claude --version 2>&1 | head -1
echo "--- paseo subcommands ---"
paseo --help 2>&1 | grep -iE "daemon|serve|start|hub" | head -8
echo "--- disk used ---"; du -sh "$(npm prefix -g)" /home/sprite/workspace 2>/dev/null'
