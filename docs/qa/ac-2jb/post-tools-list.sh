#!/bin/sh
# Usage: post-tools-list.sh <base-url> <postgres-container> <database> <hub-log-file>
# Seeds one agent_sessions row whose capabilityTokenHash matches a known bearer
# token, then sends real MCP tools/list POSTs to /agent-sessions/<id>/mcp.
set -eu
base="$1"; pg="$2"; db="$3"; log="$4"
sid="22222222-3333-4444-8555-666666666666"
pid="33333333-4444-4555-8666-777777777777"
token="ac2jb-session-bearer-token"
hash=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1],"utf8").digest("base64url"))' "$token")
data=$(node -e 'const [id,projectId,capabilityTokenHash]=process.argv.slice(1);process.stdout.write(JSON.stringify({id,organizationId:"ac2jb-org",projectId,continuationKey:"ac2jb",daemonId:"44444444-5555-4666-8777-888888888888",agentId:null,workspaceId:null,compatibility:"ac2jb",creationOptions:{provider:"codex",cwd:"/repo",env:{},toolPolicy:{preapproved:[]}},capabilityTokenHash,tools:[{name:"complete",description:"Complete the execution.",inputSchema:{type:"object",properties:{summary:{type:"string"}},required:["summary"]}}]}))' "$sid" "$pid" "$hash")
docker exec -i "$pg" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -q <<SQL
insert into organization (id, name, slug) values ('ac2jb-org', 'AC 2JB', 'ac2jb-org') on conflict do nothing;
insert into projects (id, organization_id, name, slug) values ('$pid', 'ac2jb-org', 'AC 2JB', 'ac2jb') on conflict do nothing;
insert into agent_sessions (id, organization_id, project_id, continuation_key, data)
values ('$sid', 'ac2jb-org', '$pid', 'ac2jb', '$data'::jsonb) on conflict (id) do update set data = excluded.data;
SQL
before=$(wc -l < "$log")
body='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
echo "### POST tools/list with the session bearer"
echo "> POST $base/agent-sessions/$sid/mcp  body: $body"
curl -sS -i -X POST "$base/agent-sessions/$sid/mcp" -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$body" | grep -iv '^date:\|^connection:\|^keep-alive:'
echo; echo
echo "### POST tools/list with a wrong bearer"
curl -sS -i -X POST "$base/agent-sessions/$sid/mcp" -H "Authorization: Bearer wrong" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$body" | grep -iv '^date:\|^connection:\|^keep-alive:'
echo; echo
sleep 1
echo "### Hub log lines emitted during POSTs"
tail -n +"$((before + 1))" "$log" | sed 's/\x1b\[[0-9;]*m//g'
echo "### end of log"
