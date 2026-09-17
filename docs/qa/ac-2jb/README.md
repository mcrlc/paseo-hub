# ac-2jb: verification of PR #4 (session MCP route answers non-POST with 405)

PR: https://github.com/mcrlc/paseo-hub/pull/4, head `0f6e622`, base `origin/main` `1512f10`.

Setup for scenarios 1–5: `npm run build`, then the production entry point
`node dist/index.js` with `DATABASE_URL` pointing at a `postgres:17-alpine` container,
`PORT=4105`, `PASEO_HUB_APP_URL=http://127.0.0.1:4105`, `PASEO_HUB_AUTH_SECRET=<32+ chars>`.
The origin/main build ran the same way from a temporary worktree on port 4106 against a second
database. Both servers were killed by PID and the worktree removed afterwards. Session id used for
method probes: `11111111-2222-4333-8444-555555555555` (no row; the 405 is answered before any lookup).

| #   | Scenario                                                                    | Command                                                                                                                                                  | Result                                                                                                                                                        | Evidence                                             |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Real GET on running Hub, `Accept: application/json` and `Accept: text/html` | `docs/qa/ac-2jb/probe-methods.sh http://127.0.0.1:4105 <hub-log> PR`                                                                                     | Pass for response (405, `allow: POST`, `{"error":"method_not_allowed"}` both times). Log expectation not met literally: see F1                                | [1-real-get.txt](1-real-get.txt)                     |
| 2   | DELETE, PUT, PATCH, HEAD, OPTIONS                                           | same script                                                                                                                                              | Pass: all five 405 with `allow: POST` (HEAD and OPTIONS also go to `ANY`, see F3)                                                                             | [2-other-methods.txt](2-other-methods.txt)           |
| 3   | Before (origin/main) vs after                                               | same script against the origin/main build on :4106                                                                                                       | Pass: GET `Accept: application/json` → 500 `{"error":"Only HTML requests are supported here"}` on main, 405 on PR. Other probes differ from the brief, see F2 | [3-before-origin-main.txt](3-before-origin-main.txt) |
| 4   | Real MCP `tools/list` POST on the session route                             | `docs/qa/ac-2jb/post-tools-list.sh http://127.0.0.1:4105 ac2jb-pg hub <hub-log>`                                                                         | Pass: 200 with the seeded tool list (plus injected `executionId`); wrong bearer → 401. Identical 200 body on origin/main                                      | [4-post-tools-list.txt](4-post-tools-list.txt)       |
| 5   | Execution MCP route unchanged                                               | same probe script (last two probes)                                                                                                                      | Pass: GET and DELETE on `/agent-executions/<id>/mcp` → 405 `allow: POST`, same as origin/main                                                                 | [5-execution-route.txt](5-execution-route.txt)       |
| 6   | Gates                                                                       | `npm run format:check`; `npm run typecheck:node`/`:start`/`:e2e`; `npm run lint`; `npx vitest run src/mcp-route-method-guard.test.ts src/agent-sessions` | Pass: all exit 0; 11/11 tests                                                                                                                                 | [6-gates.txt](6-gates.txt)                           |

Scenario 4 seeds one `agent_sessions` row directly in Postgres whose `capabilityTokenHash` is the
sha256 base64url of a known bearer token, the same hash `verifyAgentExecutionCompletionToken`
checks. The POST goes through the real built server, route, auth, and MCP transport.

## Findings

- **F1: every 405 still writes a WARN with a stack to the Hub log.** Each non-POST request on the
  PR build logs, for example:
  ```
  WARN: http.response failed
      failureKind: "validation"
      method: "GET"
      path: "/agent-sessions/11111111-2222-4333-8444-555555555555/mcp"
      status: 405
      err: { "type": "Error", "stack": at forwardRequest (.../dist/http/node-server.js:35:47) ... }
  ```
  This is the generic reporter in `src/http/node-server.ts` (`response.status >= 400` →
  `reportFailure(new Error("HTTP response completed with status …"))`, logged at `warn` for expected
  kinds). It is not introduced by PR #4: the pre-existing execution route logs the same WARN for its
  405s on both builds, and a 401 POST logs the same shape with `failureKind: "authentication"`. The
  PR does fix the severity: on origin/main the same GET logged `ERROR: http.response failed`,
  `failureKind: "internal"`, `status: 500`. If the goal is a silent log for expected 405s, that is
  a change to the shared reporter, not this route.
- **F2: on origin/main only the JSON GET produced a 500.** GET with `Accept: text/html` returned
  `HTTP/1.1 200 OK`, `content-type: text/html; charset=utf-8`, the SPA shell, and no log line.
  DELETE, PUT, PATCH, OPTIONS, and HEAD also returned 200 HTML. So the bug on main was broader than
  the 500: every non-POST method except a JSON GET silently rendered the app shell. The PR fixes all
  of them (scenario 2).
- **F3: HEAD and OPTIONS are not handled by the framework.** On the PR build both reach the `ANY`
  handler and return 405 `allow: POST`. OPTIONS gets no CORS preflight response. That is harmless
  for the server-to-server MCP client but worth knowing if a browser ever calls this route.
