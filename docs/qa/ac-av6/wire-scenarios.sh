#!/bin/zsh
# Usage: wire-scenarios.sh <s1|s2|s3> <base> <slug> <state-dir> <pg-container> <token-file> <value-a> <value-b>
# Raw wire probes for scenarios 1-3 against the production build; prints a transcript on stdout.
set -u
step=$1 B=$2 S=$3 ST=$4 PG=$5 TOK=$6 VA=$7 VB=$8
W=${0:A:h}/wire.sh
psql() { docker exec "$PG" psql -U postgres -d hub "$@" }
env_of() { psql -tAc "select coalesce((select env::text from organization_sprites_configuration where organization_id = (select id from organization where slug = '$1')), '<no row>')" }
row_digest() { psql -tAc "select md5(string_agg(row(c.*)::text, '|' order by organization_id)) from organization_sprites_configuration c" }
result() { /usr/bin/grep -a '^{' | node -e '
  const t = require("fs").readFileSync(0, "utf8");
  // Pull status plus message / data strings out of the seroval frame for a one-line summary.
  const status = /"k":\["status","(?:error|data)"\],"v":\[\{"t":1,"s":"(\w+)"\}/.exec(t)?.[1];
  const message = /"k":\["message"[^\]]*\],"v":\[\{"t":1,"s":"([^"]*)"/.exec(t)?.[1];
  const kind = /"failureKind"[^}]*?"s":"(\w+)"/.exec(t)?.[1];
  console.log(`  => status=${status}${message ? ` message=${JSON.stringify(message)}` : ""}`);
' }
say() { print -- "$@" }

case $step in
s1)
  say "# Scenario 1 (wire part): values never reach a client"
  say "values: A=<value-a> (${#VA} chars, set in the UI as CLAUDE_CODE_OAUTH_TOKEN), B=<value-b> (${#VB} chars)"
  say "\n## Store B again through the wire as OPENAI_API_KEY (UI journey removed it)"
  $W setenv $B $S $ST/admin.json OPENAI_API_KEY "$VB" | sed "s/$VB/<value-b>/g" > /tmp/acav6/s1-set.txt; /usr/bin/grep -a '^HTTP\|^> POST' /tmp/acav6/s1-set.txt; result < /tmp/acav6/s1-set.txt
  say "stored env keys: $(psql -tAc "select string_agg(k, ',' order by k) from organization_sprites_configuration, jsonb_object_keys(env) k")"
  say "stored value lengths: $(psql -tAc "select string_agg(k || '=' || length(env->>k), ',' order by k) from organization_sprites_configuration, jsonb_object_keys(env) k")"
  for who in admin owner member none; do
    st=$ST/$who.json; [[ $who == none ]] && st=none
    $W snapshot $B $S $st > /tmp/acav6/s1-snapshot-$who.txt
    say "\n## Raw snapshot as $who"
    /usr/bin/grep -a -v '^> ' /tmp/acav6/s1-snapshot-$who.txt | /usr/bin/grep -a '^HTTP\|^{'
    say "hits: A=$(/usr/bin/grep -a -cF "$VA" /tmp/acav6/s1-snapshot-$who.txt) B=$(/usr/bin/grep -a -cF "$VB" /tmp/acav6/s1-snapshot-$who.txt)"
  done
  for who in admin owner; do
    $W page $B $S $ST/$who.json > /tmp/acav6/s1-page-$who.html
    say "\n## SSR page /o/$S/settings/sprites as $who: $(wc -c < /tmp/acav6/s1-page-$who.html | tr -d ' ') bytes, $(head -1 /tmp/acav6/s1-page-$who.html | tr -d '\r')"
    say "contains envKeys: $(/usr/bin/grep -a -c 'CLAUDE_CODE_OAUTH_TOKEN' /tmp/acav6/s1-page-$who.html); hits: A=$(/usr/bin/grep -a -cF "$VA" /tmp/acav6/s1-page-$who.html) B=$(/usr/bin/grep -a -cF "$VB" /tmp/acav6/s1-page-$who.html)"
  done
  ;;
s2)
  say "# Scenario 2: capability on the wire"
  say "roles: $(psql -tAc "select string_agg(u.email || '=' || m.role, ', ' order by u.email) from member m join \"user\" u on u.id = m.user_id")"
  say "env before: $(env_of $S)"; d0=$(row_digest); say "row digest before: $d0"
  for who in member none; do
    st=$ST/$who.json; [[ $who == none ]] && st=none
    say "\n## $who: setenv MEMBER_KEY"; $W setenv $B $S $st MEMBER_KEY member-value | tee /tmp/acav6/s2-$who-set.txt | /usr/bin/grep -a '^HTTP\|^> '; result < /tmp/acav6/s2-$who-set.txt
    say "## $who: setenv OPENAI_API_KEY (overwrite attempt)"; $W setenv $B $S $st OPENAI_API_KEY member-overwrite | tee /tmp/acav6/s2-$who-over.txt | /usr/bin/grep -a '^HTTP\|^> '; result < /tmp/acav6/s2-$who-over.txt
    say "## $who: rmenv CLAUDE_CODE_OAUTH_TOKEN"; $W rmenv $B $S $st CLAUDE_CODE_OAUTH_TOKEN | tee /tmp/acav6/s2-$who-rm.txt | /usr/bin/grep -a '^HTTP\|^> '; result < /tmp/acav6/s2-$who-rm.txt
    say "## $who: snapshot"; $W snapshot $B $S $st | tee /tmp/acav6/s2-$who-snap.txt | /usr/bin/grep -a '^HTTP\|^> '; result < /tmp/acav6/s2-$who-snap.txt
    say "envKeys in $who snapshot response: $(/usr/bin/grep -a -c 'envKeys' /tmp/acav6/s2-$who-snap.txt)"
    say "row digest after $who: $(row_digest) (unchanged: $([[ $(row_digest) == $d0 ]] && echo yes || echo NO))"
  done
  say "\n## admin: setenv ADMIN_KEY"; $W setenv $B $S $ST/admin.json ADMIN_KEY admin-value | tee /tmp/acav6/s2-admin-set.txt | /usr/bin/grep -a '^HTTP\|^> '; result < /tmp/acav6/s2-admin-set.txt
  say "env after admin set: $(env_of $S | sed "s/$VA/<value-a>/; s/$VB/<value-b>/")"
  say "## admin: snapshot"; $W snapshot $B $S $ST/admin.json | /usr/bin/grep -a -o '"envKeys".*"o":0}' | head -c 300; echo
  say "## admin: rmenv ADMIN_KEY"; $W rmenv $B $S $ST/admin.json ADMIN_KEY | tee /tmp/acav6/s2-admin-rm.txt | /usr/bin/grep -a '^HTTP\|^> '; result < /tmp/acav6/s2-admin-rm.txt
  say "env after admin remove: $(env_of $S | sed "s/$VA/<value-a>/; s/$VB/<value-b>/")"
  ;;
s3)
  O2=other-org-acav6
  say "# Scenario 3: round trip and rules on Postgres"
  say "\n## Second organization (inserted directly; Hub has no second-org UI on a bootstrap instance)"
  psql -c "insert into organization (id, name, slug) values ('org2-acav6', 'Other', '$O2') on conflict do nothing" -c "insert into organization_sprites_configuration (organization_id, token, memory_mb, env) values ('org2-acav6', 'other-org-token', 4096, '{\"OTHER_KEY\": \"other-org-value\"}') on conflict do nothing"
  o2=$(psql -tAc "select row(c.*)::text from organization_sprites_configuration c where organization_id='org2-acav6'"); say "org2 row: $o2"
  say "admin setenv against org2's slug (not a member):"; $W setenv $B $O2 $ST/admin.json X_KEY v | result
  say "\n## Reset $S to 'no token yet': delete its configuration row"
  psql -c "delete from organization_sprites_configuration where organization_id = (select id from organization where slug = '$S')"
  say "## setenv before any token"; $W setenv $B $S $ST/admin.json CLAUDE_CODE_OAUTH_TOKEN before-token | tee /tmp/acav6/s3-pre.txt | /usr/bin/grep -a '^HTTP'; result < /tmp/acav6/s3-pre.txt
  say "## rmenv before any token"; $W rmenv $B $S $ST/admin.json CLAUDE_CODE_OAUTH_TOKEN | result
  say "row for $S: $(env_of $S)"
  say "## snapshot before token"; $W snapshot $B $S $ST/admin.json | /usr/bin/grep -a -o '"k":\["configured".*' | head -c 260; echo
  say "\n## Save token (wire)"; $W save $B $S $ST/admin.json $TOK | result; say "env: $(env_of $S)"
  say "\n## Set ROUND_TRIP=first"; $W setenv $B $S $ST/admin.json ROUND_TRIP first | result
  say "snapshot envKeys: $($W snapshot $B $S $ST/admin.json | /usr/bin/grep -a -o '"t":9,"i":3,"a":\[[^]]*\]' | head -1)"
  say "row env: $(env_of $S), updated_at $(psql -tAc "select updated_at from organization_sprites_configuration where organization_id=(select id from organization where slug='$S')")"
  say "## Set ROUND_TRIP='  second  ' (replace, padded)"; $W setenv $B $S $ST/admin.json ROUND_TRIP "  second  " | result
  say "row env: $(env_of $S), keys: $(psql -tAc "select count(*) from organization_sprites_configuration c, jsonb_object_keys(c.env) where organization_id=(select id from organization where slug='$S')"), updated_at $(psql -tAc "select updated_at from organization_sprites_configuration where organization_id=(select id from organization where slug='$S')")"
  say "snapshot envKeys: $($W snapshot $B $S $ST/admin.json | /usr/bin/grep -a -o '"t":9,"i":3,"a":\[[^]]*\]' | head -1)"
  say "\n## Rules (each must be refused; env must not change)"
  before=$(env_of $S)
  for key in lower 1ABC A-B HOME PATH PASEO_HOME PASEO_PASSWORD; do say "key=$key:"; $W setenv $B $S $ST/admin.json "$key" v | result; done
  say "empty value:"; $W setenv $B $S $ST/admin.json EMPTY_VALUE "" | result
  say "whitespace-only value:"; $W setenv $B $S $ST/admin.json EMPTY_VALUE "   " | result
  long=$(node -e 'process.stdout.write("x".repeat(8193))')
  say "8193-char value:"; $W setenv $B $S $ST/admin.json LONG_VALUE "$long" | result
  max=$(node -e 'process.stdout.write("y".repeat(8192))')
  say "8192-char value (boundary, should pass):"; $W setenv $B $S $ST/admin.json MAX_VALUE "$max" | result
  say "MAX_VALUE stored length: $(psql -tAc "select length(env->>'MAX_VALUE') from organization_sprites_configuration where organization_id=(select id from organization where slug='$S')")"
  $W rmenv $B $S $ST/admin.json MAX_VALUE | result
  say "env unchanged by the refused writes: $([[ $(env_of $S) == $before ]] && echo yes || echo NO) ($(env_of $S))"
  say "\n## Save a new token (same temporary token re-submitted) keeps the env map"
  $W setenv $B $S $ST/admin.json KEEP_ME kept | result
  e1=$(env_of $S); say "env before re-save: $e1"
  $W save $B $S $ST/admin.json $TOK | result
  say "env after re-save: $(env_of $S) (unchanged: $([[ $(env_of $S) == $e1 ]] && echo yes || echo NO))"
  say "\n## Remove"
  $W rmenv $B $S $ST/admin.json ROUND_TRIP | result
  $W rmenv $B $S $ST/admin.json KEEP_ME | result
  say "row env: $(env_of $S)"
  say "snapshot envKeys: $($W snapshot $B $S $ST/admin.json | /usr/bin/grep -a -o '"t":9,"i":3,"a":\[[^]]*\]' | head -1)"
  say "remove a key that is not there:"; $W rmenv $B $S $ST/admin.json NEVER_SET | result
  say "\n## org2 untouched"
  say "org2 row now: $(psql -tAc "select row(c.*)::text from organization_sprites_configuration c where organization_id='org2-acav6'")"
  say "identical to start: $([[ $(psql -tAc "select row(c.*)::text from organization_sprites_configuration c where organization_id='org2-acav6'") == $o2 ]] && echo yes || echo NO)"
  ;;
esac
