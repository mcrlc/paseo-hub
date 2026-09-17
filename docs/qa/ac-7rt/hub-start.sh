#!/bin/sh
# Usage: QA_DIR=<private dir> docs/qa/ac-7rt/hub-start.sh
# Starts Hub on :3000 from the production build with the same env every time, so a kill -9 and a
# restart are byte-identical runs against the same Postgres. Appends to $QA_DIR/hub.log and writes
# the pid to $QA_DIR/hub.pid. Every secret is read from $QA_DIR (chmod 600); none is on the command line.
cd "$(dirname "$0")/../../.." || exit 1
echo "=== hub start $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%04d-%02d-%02dT%02d:%02d:%06.3fZ", $g[5]+1900,$g[4]+1,$g[3],$g[2],$g[1],$g[0]+($t-int($t))') ===" >> "$QA_DIR/hub.log"
DATABASE_URL=postgres://qa:qa@127.0.0.1:55471/hub \
PASEO_HUB_APP_URL="$(cat "$QA_DIR/url")" \
PASEO_HUB_AUTH_SECRET="$(cat "$QA_DIR/auth-secret")" \
PASEO_BOOTSTRAP_ORGANIZATION=qa-ac7rt \
PASEO_BOOTSTRAP_OWNER_EMAIL=qa-ac7rt@example.com \
PASEO_BOOTSTRAP_OWNER_PASSWORD="$(cat "$QA_DIR/owner-password")" \
nohup node dist/index.js >> "$QA_DIR/hub.log" 2>&1 &
echo $! > "$QA_DIR/hub.pid"
echo "hub pid $(cat "$QA_DIR/hub.pid") starting $(perl -MTime::HiRes=time -e 'my $t=time; my @g=gmtime($t); printf "%02d:%02d:%06.3f", $g[2],$g[1],$g[0]+($t-int($t))')"
