# Fly Sprites spikes for `docs/sprite-targets.md`

Run 2026-09-16 against Sprites API `0.0.1-rc48`, CLI `2026-09-02 (6390abf)`, org `michael-ehrlich`;
spike 6 on 2026-09-17. Scripts in this directory reproduce each result. Sprites used: `hub-spike`,
`hub-spike-2`, `hub-spike-3`.

## Base environment

| Fact         | Value                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| Kernel       | `6.12.105-fly`, x86_64                                                        |
| CPU / memory | 8 cores, 16 GB                                                                |
| Disk         | 99 GB overlay                                                                 |
| User         | `sprite` (uid 1001), not root                                                 |
| Tools        | node 24.18, python3, npm, git, curl, `sprite-env`. No `websocat`.             |
| Create time  | Under one second; the VM is pre-provisioned (uptime predates the create call) |

## Spike 1: does an outbound socket keep a sprite awake? (`wsping.js`, `spike1-poll.sh`)

**No.** With a service holding an outbound WebSocket and sending a ping every 10 s, the sprite went
`warm` 60 s after the last exec session closed and stayed warm for the rest of the four-minute poll.
The pinger's log has a gap from the pause until the next exec woke it. The process survived the
pause with the same pid, and its WebSocket resumed on the same connection after a five-minute
freeze.

The docs agree: activity is "active exec/console commands", "open TCP connections (like your
app's URL)", "running TTY sessions", and "active Services with open connections", all inbound.
No documented warm-to-cold duration exists; a sprite in this run stayed warm for over ten minutes.

Consequence for the PRD: Hub's outbound daemon socket does not count as activity. A sprite running
only the daemon pauses on its own. Hub must hold the sprite while an execution is active (spike 2c).

## Spike 2: wake and hold from outside (`spike2-wake-hold.sh`, `spike2-run.sh`)

| Test                                               | Result                                                                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated GET to the sprite URL, auth=sprite | `302`, sprite stayed `warm`. Does not wake.                                                                                                                                         |
| GET to the sprite URL with auth=public             | Wakes it (`last_running_at` advanced), but with no service bound to an `http_port` the edge held the request 30 s and returned `502`, and the sprite was warm again within seconds. |
| `sprite exec` on a `warm` sprite                   | Wakes it. 0.39 s wall clock. Status `running` afterwards.                                                                                                                           |
| `POST /v1/tasks` via `sprite-env` inside an exec   | Holds. Status stayed `running` for the whole window with no other activity.                                                                                                         |
| Re-`POST` same task name                           | `409 task "hub-hold" already exists`. Not a refresh.                                                                                                                                |
| `PUT /v1/tasks/:name`                              | Refreshes: new `expires_at`, same `started_at`. This is the heartbeat call.                                                                                                         |
| `PATCH /v1/tasks/:name`                            | `405`.                                                                                                                                                                              |
| `expire` above 3600 s                              | `400 expire 10800 seconds exceeds maximum 3600 seconds`. `60m` accepted.                                                                                                            |
| `DELETE /v1/tasks/:name`                           | `204`. Sprite was `warm` within 15 s of release.                                                                                                                                    |
| Control-plane `GET /v1/sprites/:name`              | Does not wake. One poll in ~40 returned an empty body; treat status reads as retryable.                                                                                             |

Consequence for the PRD: exec is the wake call. The sprite URL stays `auth: sprite`, no `http_port`, no
inbound surface, and `PASEO_PASSWORD` is belt and braces only. Provider `hold(executionId)` = exec `POST /v1/tasks {name, expire: 60m}`,
`refresh` = exec `PUT`, `release` = exec `DELETE`. Exec itself wakes a paused sprite, so hold does not
need a separate wake. `sprite-env curl` rejects `-o` and `-w`; keep calls plain.

## Spike 3: service semantics across warm and cold (`spike3-service.sh`, `spike3-run.sh`)

Service `probe` registered with `env: {PROBE_ENV: set-at-create}`; logs pid, boot id, uptime, and
the env value every 5 s.

| Transition    | Result                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm resume   | Same pid, same boot id, env intact. The log gap equals wall-clock pause time and `/proc/uptime` jumps to match, so guest time is corrected.                                                                                                                                                                                                                         |
| Cold wake     | `hub-spike` reached `cold` on its own about an hour after its last activity. Exec woke it in 1.05 s wall clock. Same pids, same boot id, env intact, `/proc/uptime` continued from where it froze. In this run "cold" still restored process memory; nothing restarted. The docs' "processes start fresh" case was only reproduced by the checkpoint restore below. |
| Restart proxy | `sprite checkpoint create` then `sprite restore v1` on `hub-spike-2` (`spike3-restore.sh`): environment restarted (service pid reset to 5), the `paseo` service came back unprompted, `paseo status` showed the same server id from disk 25 s after the restore returned. Service definitions are part of the checkpoint.                                           |
| Crash restart | `kill -9` on the service pid: restarted in under 10 s with a new pid and the same env. `state.restart_count` is exposed on the service.                                                                                                                                                                                                                             |

### Hub-side consequence of warm resume

Hub's daemon registry (`src/daemons/registry.ts`) only reacts to socket `close` and `error`; there is no
application-level ping. The pinger's socket survived a five-minute freeze, so a paused sprite's daemon
will still look connected to Hub. `canDispatchToDaemon` returning true is therefore not proof the
sprite is running. For a sprite target Hub must hold first and dispatch second. Hold goes through
exec, and exec wakes the sprite, so the ordering costs nothing.

## Resources and network policy

| Endpoint                                 | Result                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sprites/:name/policy/resources` | `{"memory":{"limit_mb":8192,"autoscale":false}}` by default on a 16 GB host.                                                                 |
| `POST` same path                         | Sets it; `limit_mb: 16384` accepted. `PUT` and `PATCH` are `405`. A `cpu` field is rejected: `unknown field "cpu"`. Memory is the only knob. |
| `GET /v1/sprites/:name/policy/network`   | `{"rules": []}`. A DNS allowlist is available if Hub ever wants to fence a sprite's egress.                                                  |

So `size` in the PRD maps to a memory limit only, set after create rather than at create.

## Spike 4a: bootstrap on a fresh sprite (`spike4-bootstrap.sh`)

As the non-root `sprite` user, no Hub involved:

| Step                                       | Time |
| ------------------------------------------ | ---- |
| `npm install -g @getpaseo/cli` (0.8.0)     | 16 s |
| `npm install -g @anthropic-ai/claude-code` | 4 s  |
| `git clone --depth 1` of `getpaseo/hub`    | 1 s  |

Gotchas: `npm install -g @anthropic-ai/claude-code` on the sprite does not run its postinstall, so
`claude` reports a version but the agent SDK fails with "claude native binary not installed" at
first launch; the bootstrap must run `node <prefix>/lib/node_modules/@anthropic-ai/claude-code/install.cjs`
explicitly. Changing a service's `env` needs `DELETE` then `PUT`; a `PUT` with the same `cmd`
is ignored ("Service already running with that command") even after `stop`. The exec shell is non-login and the npm global bin dir
(`/.sprite/languages/node/nvm/versions/node/v24.18.0/bin`) is not on its `PATH`, so service
definitions and bootstrap commands use absolute paths or set `PATH` in the service `env`.
`paseo start --foreground` exists and is the service command. The global prefix is 909 MB after
both installs.

Daemon as a service (`spike4-daemon-resume.sh`): `PUT /services/paseo` with
`cmd: <prefix>/bin/paseo start --foreground --listen 127.0.0.1:6767 --no-relay --no-web-ui`,
`env: {HOME, PASEO_HOME, PATH}`, `dir: /home/sprite`. Listening in about 3 s; `paseo status` shows
a server id and the keypair under `PASEO_HOME`. On first boot the daemon also downloads local speech
models into `PASEO_HOME/models`; no start flag disables that, so it is part of first-boot time and
disk. `paseo hub connect --api-key` is present in 0.8.0. Identity across a warm pause: same server id (`srv_QH4lHEqnZvc6`), same runner and worker pids,
service `started_at` unchanged. `PASEO_HOME` is 985 MB after first boot, almost all of it the local
speech models.

## Spike 4b: enrollment against a real Hub (`spike5-trigger.yml`)

Local Hub from this tree, production build (`npm run build && npm start`), exposed with a
cloudflared quick tunnel. Findings that matter for the PRD:

- `paseo hub connect --api-key` enrolls with **no permissions** unless `--permission hub.execute`
  is passed. The Hub API defaults to `hub.execute` only when the client omits `permissions`; the
  CLI sends an explicit empty list. The daemon then shows "Connected only" and is not a valid
  target. The PRD's entrypoint must pass `--permission hub.execute`.
- A daemon holds one Hub relationship. Re-pointing it needs `paseo hub disconnect` first.
- A second enrollment from the same hostname got slug `hub-spike-2-102c06ad`, confirming the
  one-shot suffix the PRD relies on.
- `npm run dev` (Vite) never completes the daemon WebSocket upgrade at `/api/daemons/socket`;
  only the built server does. Not a sprite issue, but it cost an hour.
- Sign-in requires the browser origin to equal `PASEO_HUB_APP_URL`; localhost fails when the app
  URL is the tunnel.
- The daemon connected with `hub.execute` through the tunnel on the first try.

Manual run `input` is a plain string that becomes `${{ paseo.prompt }}`; declared `inputs` are parsed
from typed headers in that string, not from a JSON object. Spike 5 uses manual runs with `continuation: { mode: key }` instead of GitHub events. Manual
dispatch resolves the trigger by name (the `projectSlug` field is ignored when an organization
trigger matches) and goes through the same durable event path as provider events.

## Spike 5: continuation across a pause (`spike5-run.sh`, `spike5-continuation.sh`)

Agent credential is a Claude Code OAuth token in the daemon service env (`CLAUDE_CODE_OAUTH_TOKEN`),
which the daemon-spawned agent inherited: a direct `claude -p` under the daemon's env answered,
and the Hub-dispatched agent answered too. This is the PRD 5.9 inheritance claim, proven.

Run 1 (`run-2a`): dispatched 15:18:35, agent created 15:18:56 (about 20 s after the previous
attempt's stale `claude --version` check), reply sent, workspace archived at terminal. The run
ended `failed` by `idle_timeout` (2 m) because the prompt never asked for `finish_execution`; the
e2e harness convention is "Call the finish_execution MCP tool exactly once. Do not use curl, shell,
or direct HTTP." and later runs use it.

MCP from the sprite through the tunnel works: `initialize` 200, `notifications/initialized` 202,
`tools/list` 200 with `finish_execution`, using the bearer from the agent record. The Hub log
still shows two side requests from Claude Code's client: `GET /agent-sessions/:id/mcp` returns
500 "Only HTML requests are supported here" because the route has no GET handler (a 405 would be
correct), and one `POST` returned 400. Neither blocks tool calls.

**Follow-up against a paused sprite (`run-3`, `spike5-continuation.sh`): fails.** The sprite was
`warm`; Hub still saw the daemon socket as connected and dispatched. Nothing woke the sprite. After
`timeoutMs: 120000` Hub failed the run with `DaemonDispatchFailure code=daemon_timeout`
(`DaemonSpawnAckTimeoutError` from `spawnPreparedDispatch`). When an exec woke the sprite four
minutes later, the daemon flushed the failed run's archive and reconnected; the follow-up was never
delivered to the agent. This is the concrete failure that PRD 5.5 must prevent: for a sprite
target, dispatch is not "socket live" but "held, then socket live". Today's deferral path never
runs because the socket never closes.

**Follow-up with a hold first (`run-4`, `spike5-held.sh`): passes.** Exec `POST /v1/tasks` woke the
sprite; the daemon's Hub socket re-established within seconds ("Client connected via hello"); Hub
dispatched, the daemon logged "Agent resumed from persistence" for the same agent, the message was
sent 15:29:27, the agent replied at 15:29:32 and called `finish_execution`, the workspace was
archived, and Hub recorded the run as Succeeded. The Claude transcript on the sprite is one session:
"Remember the word pineapple" / "OK" at 15:19, then "What word…" / `finish_execution` / "pineapple"
at 15:29, across a pause, an idle-timeout failure, a daemon-timeout failure, and an archive plus
restore. That is PRD 5.7 continuation across sleep, proven with today's Hub and no code change.

Timing for the PRD: hold to daemon-reconnected about 5 s; dispatch to reply about 6 s. The 20 s to
60 s "Created agent" lag seen on the first runs was the stale Claude binary check, not Sprites.

## Spike 6: the provider surface over the HTTP API (`spike6-http-api.sh`, `spike6-decode.mjs`)

Spikes 1 to 5 drove everything through the `sprite` CLI. Hub runs in Node and will not shell out to
a logged-in CLI, so this spike repeats the calls the PRD's provider needs as plain HTTP against
`https://api.sprites.dev` with `Authorization: Bearer <org token>`. `sprite api` is only an
authenticated curl and was used as the client; the token comes from the CLI's keyring, or
`SPRITES_TOKEN` in CI, and is minted at `sprites.dev/account`. Fresh sprite `hub-spike-3`.

| Call               | Request                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create             | `POST /v1/sprites {"name"}`                                          | 200, `status: cold`, URL `auth: sprite`. Whole body is the name.                                                                                                                                                                                                                                                                                                                                               |
| memory             | `POST /v1/sprites/:n/policy/resources {"memory":{"limit_mb":16384}}` | 204; `GET` reads it back. `{"memory_mb"}` is rejected with 400 "unknown field".                                                                                                                                                                                                                                                                                                                                |
| service put        | `PUT /v1/sprites/:n/services/:svc {cmd,args,env,dir}`                | 200, streams `started` then `complete` with log paths, service `running`.                                                                                                                                                                                                                                                                                                                                      |
| service env change | same `PUT` with a new `env`                                          | 200 but ignored: "Service already running with that command". `DELETE` (204) then `PUT` applies the new env. Same as the CLI finding in spike 3.                                                                                                                                                                                                                                                               |
| exec               | `POST /v1/sprites/:n/exec?cmd=sh&cmd=-c&cmd=…`                       | 200 `application/octet-stream`. `cmd` repeats once per argv element. `env=K=V` (repeatable) and `dir` work. Runs as `sprite`, `HOME=/home/sprite`, non-login `PATH`.                                                                                                                                                                                                                                           |
| exec with stdin    | `…exec?cmd=sh&cmd=-s&stdin=true` with the script as the request body | Runs the multi-line script; stdout, stderr, and exit 7 all came back. This is how `bootstrap` is delivered.                                                                                                                                                                                                                                                                                                    |
| exec, silent 90 s  | `sleep 90; echo done`                                                | Completed in 90 s with `done`. Nothing at the edge cuts an idle response, so a quiet `npm install` is safe.                                                                                                                                                                                                                                                                                                    |
| tasks from outside | `GET`/`POST /v1/sprites/:n/tasks`                                    | 404. Holds are only reachable inside the sprite, so `hold`/`refresh`/`release` are an exec of `sprite-env curl` against `/v1/tasks`. Same shape as spike 2, confirmed over HTTP.                                                                                                                                                                                                                               |
| hold via exec      | `POST /v1/tasks {"name":"hub-hold","expire":"5m"}`                   | 200 with `expires_at`. `PUT` refreshes `expires_at`, and a `PUT` on a missing name creates it (measured 2026-09-17 on `hub-spike-5`), so hold is one idempotent `PUT`. Re-`POST` of a live name is 409. `DELETE` 200; `DELETE` again 404. `sprite-env curl` exits 22 on any HTTP error with `curl: (22) The requested URL returned error: <status>` on stderr, with or without `-f`; `-f` only hides the body. |
| exec wake          | `POST …/exec` after 4 min idle                                       | 0.34 s wall clock. The probe service's log, written every 5 s, stops at 04:39:51 and resumes at 04:43:46, so the sprite was paused and the exec woke it. Same pid afterwards.                                                                                                                                                                                                                                  |
| WebSocket exec     | `GET …/exec?cmd=…` with an `Upgrade: websocket` handshake            | 101 with the bearer, so it exists, but it is only needed for TTY sessions and is not used.                                                                                                                                                                                                                                                                                                                     |
| destroy            | `DELETE /v1/sprites/:n`                                              | 204; `GET` afterwards 404. `spike6-http-api.sh` runs create through destroy end to end on a fresh sprite in about 20 s.                                                                                                                                                                                                                                                                                        |

**Exec response framing.** With `--http1.1 --raw` every chunked-encoding chunk is exactly one
frame: a channel byte followed by payload, `1` stdout, `2` stderr, `3` exit. The exit frame is
last and carries one exit-code byte (`03 00`, `03 03`, `03 c8` for 0, 3, 200); over HTTP/2 a
newline follows it. A 5000-byte stdout arrived as one frame. `spike6-decode.mjs` decodes a whole
body and self-checks; it strips channel bytes wherever they appear because `fetch()` does not
preserve chunk boundaries, which is fine for logs and JSON and wrong for binary stdout.

**Status field lags.** `GET /v1/sprites/:n` reported `warm` one second after a 90 s exec
finished and `warm` while an exec was running. Do not use it to decide whether a sprite is
awake; the hold set and the daemon socket are the truth, as the PRD says.

Consequence for the PRD: the provider is six `fetch` calls and one decoder. No CLI on the Hub
host, no WebSocket client, no new dependency.

## Spike 7: Sprites connectors, GitHub (`spike7-github-connector.sh`)

Run 2026-09-17 on `hub-spike-7` after Mic added a GitHub OAuth connector (scopes `repo,read:org`, policy
`allow_all`) in the Sprites dashboard. Connectors are organization-level credentials kept by Sprites; a sprite
calls `https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/<path>` and the gateway authenticates the
sprite by Fly's request signature and attaches the stored credential. The sprite never holds a token.

| Check                                              | Result                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET <gateway>/user` from inside the sprite        | 200, the connector's GitHub user, with no token anywhere on the sprite (`env` has none).                      |
| `GET <gateway>/repos/mcrlc/paseo-hub`              | 200.                                                                                                          |
| `git ls-remote <gateway>/mcrlc/paseo-hub.git`      | 404 "repository not found". Smart-HTTP `info/refs` via the gateway is 404 too. The gateway proxies REST only. |
| `git ls-remote https://github.com/mcrlc/paseo-hub` | Works with no credential only because the fork is public. A private repository still needs a git credential.  |
| `GET <gateway>/repos/.../tarball/main`             | 302 to codeload; not followed. A tarball is a history-less fallback, not a clone.                             |
| Gateway from outside a sprite                      | 401 without auth and 401 with the org token. A leaked connection id is useless off-sprite.                    |
| Discovery inside the sprite                        | None: `sprite-env` has no connectors command, the in-sprite API has no connectors path, and the env is empty. |

Consequence for the PRD: a connector covers the agent's GitHub REST access without a credential on the sprite,
which is the long-lived access that continuation across idle days needs (5.7, 5.9), for tooling that can take
a base URL (curl, a small wrapper), not `gh`. Cloning and pushing a private repository still need a git
credential placed by `bootstrap`. The Anthropic connector (API key, gateway with streaming) is the candidate for
the LLM key; not yet measured.
