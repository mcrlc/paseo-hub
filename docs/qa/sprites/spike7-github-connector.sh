#!/bin/bash
# Spike 7: what a Sprites GitHub connector gives a sprite. Run INSIDE a sprite via exec with stdin:
#   sprite api "/v1/sprites/<name>/exec?cmd=sh&cmd=-s&stdin=true" -- -X POST --data-binary @spike7-github-connector.sh
# G is the connector gateway base from GET /v1/oauth/connections.
set -u
G=${G:-https://api.sprites.dev/v1/gateway/github/<connection_id>}
echo "=== REST via gateway, no token on the sprite ==="
curl -s -w '\nhttp=%{http_code}\n' "$G/user" | head -c 400; echo
curl -s -o /dev/null -w 'repo http=%{http_code}\n' "$G/repos/mcrlc/paseo-hub"
echo "=== git ls-remote through the gateway ==="
GIT_TERMINAL_PROMPT=0 git ls-remote "$G/mcrlc/paseo-hub.git" 2>&1 | head -5
echo "=== git ls-remote against github.com with no credential (control) ==="
GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/mcrlc/paseo-hub.git 2>&1 | head -3
echo "=== smart-http info/refs through the gateway ==="
curl -s -o /dev/null -w 'info/refs http=%{http_code} type=%{content_type}\n' "$G/mcrlc/paseo-hub.git/info/refs?service=git-upload-pack"
curl -s -o /dev/null -w 'repos info/refs http=%{http_code}\n' "$G/repos/mcrlc/paseo-hub.git/info/refs?service=git-upload-pack"
echo "=== tarball via REST through the gateway (fallback for clone) ==="
curl -s -o /tmp/tb.tgz -L -w 'tarball http=%{http_code} size=%{size_download}\n' "$G/repos/mcrlc/paseo-hub/tarball/main"; tar tzf /tmp/tb.tgz 2>/dev/null | head -3
