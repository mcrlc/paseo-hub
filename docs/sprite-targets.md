# Sprite targets for Hub

PRD for running Hub-triggered agents on Fly Sprites: ephemeral compute that pauses when idle and keeps its filesystem. Status: proposal, validated by spikes, not implemented. Implementation lives entirely here; the Paseo image and entrypoint are not involved. Cross-provider continuation and agent-opened Slack threads were split out to `docs/cross-provider-continuation.md`; neither depends on the other.

Validated against `getpaseo/hub` at `1512f10 fix(executions): survive Hub restarts with active credentials (#133)`. Unprefixed `file:line` references are to this tree; Paseo paths are marked. Every claim about Sprites below was measured on 2026-09-16 and 2026-09-17 against Sprites API `0.0.1-rc48`; the scripts and numbers are in `docs/qa/sprites/README.md`. An earlier draft assumed a provider with images, sizes, regions, and explicit sleep and wake calls. Sprites has none of those, and the design got smaller once that was accepted.

## Premise probes

| Probe                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paseo HEAD                      | `0474c3e0a fix(app): stop the streaming Markdown spec at a word boundary (#4875)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Offline daemon dispatch         | Hub defers, it does not fail. `deferUnavailableDispatch` (`src/workflows/engine.ts:366-375`) releases the run's wakeup when `canDispatchToDaemon` is false, and the worker re-claims it every 250 ms. `canDispatchToDaemon` means "daemon has a live socket" (`src/app.ts:186-187`). The wait is bounded by the trigger's `max_runtime`, failing as `whole_run_timeout`. Documented in `docs/scheduled-triggers.md:101-103`. Paseo's `public-docs/hub/activity.md:35,53` still say dispatch fails; that is wrong.                                                                                                                                     |
| Daemon socket liveness          | The registry reacts only to socket `close` and `error` (`src/daemons/registry.ts:106-115`). There is no application-level ping. A paused sprite's outbound socket stays open, so Hub keeps believing the daemon is connected. Measured: dispatch into a paused sprite failed after 120 s as `DaemonDispatchFailure code=daemon_timeout` from `spawnPreparedDispatch`; the deferral path never ran.                                                                                                                                                                                                                                                    |
| Reserved `fly` / `docker` kinds | Parsed (`src/config/compiler.ts:148-161`) and rejected for any step that resolves to them (`:559-564`, `:1212-1233`), with tests pinning the rejection (`src/config/compiler.test.ts:774-820`). They exist only in the legacy bundle schema.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Canonical trigger format        | One single-run trigger document with `run.target: { daemon, cwd, worktree? }` (`src/triggers/configuration/schema.ts:79-85`). Multi-file `.paseo/hub.yml` bundles are the `legacy_multistep` lane and are not edited by the dashboard. Projects are gone from the model; Hub keeps one hidden project row per trigger as an adapter (`docs/trigger-migration.md:35-42`).                                                                                                                                                                                                                                                                              |
| Daemon binding                  | Already by immutable daemon ID. Slug resolves once at activation (`src/configuration/store.ts:494`); the compiled target and launch intent carry `daemonId` (`src/dispatcher/launch-machine-intent.ts:9-16`), and dispatch looks the daemon up by ID (`src/daemons/lifecycle.ts:361-364`).                                                                                                                                                                                                                                                                                                                                                            |
| Machines table                  | `machines` exists with `status ∈ {spawning, alive, terminated}`, `source`, `specs`, `shutdownReason`, and a 1:1 `daemons.machineId` (`src/db/schema.ts:564-583`). It is written `alive` at enrollment and read at dispatch. The one transition out of `alive` is daemon revocation: `failPendingExecutionsForDisconnectedMachine` fails the machine's pending executions as `daemon_disconnected` and marks the row `terminated` with reason `daemon_revoked` (`src/daemons/lifecycle.ts:1062-1081`, wired at `src/app.ts:433-438`).                                                                                                                  |
| Enrollment                      | `POST /api/v1/daemons/enrollment-tokens` needs scope `daemons:enroll`, which already exists (`src/auth/api-key-contract.ts:3-9`). Tokens live ten minutes (`src/daemons/registration.ts:273`). The token row records `issuedByApiKeyId`, and the daemon row records `registeredByApiKeyId` (`src/db/schema.ts:585-596`, `:603-610`). The API grants `hub.execute` only when the client omits `permissions` (`src/daemons/registration.ts:218-221`); the Paseo CLI sends an explicit empty list, so `paseo hub connect --api-key` without `--permission hub.execute` enrolls a daemon that shows "Connected only" and is not a valid target. Measured. |
| `startup_timeout`               | Starts after the daemon is connected and covers agent creation, restore, and first prompt (`src/daemons/lifecycle.ts:1476-1495`). Default two minutes. It does not cover the offline wait. The spawn-ack wait inside dispatch is a separate 120 s (`daemon.dispatch.spawn-ack`).                                                                                                                                                                                                                                                                                                                                                                      |
| Idle and restart                | `idle_timeout` and `max_runtime` are per-execution persisted deadlines re-armed on daemon reconnect (`src/daemons/lifecycle.ts:771-835`, `:940-1046`). There is no per-daemon "any active execution" query.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Continuation                    | Sessions store `daemonId` but every continuation dispatches to the current target's daemon (`src/daemons/lifecycle.ts:361-364`). If that daemon no longer has the agent, the run fails with "Continuation agent was deleted" (`src/daemons/agents/index.ts:138-145`). The compatibility fingerprint ignores daemon identity (`src/agent-sessions/index.ts:81-93`). Measured across a pause: the same agent resumed from persistence and answered from earlier context.                                                                                                                                                                                |
| Session identity                | Keyed by the trigger's hidden project plus a continuation key (`src/agent-sessions/index.ts:47-58`). Two triggers never share an agent. One trigger may listen to several events: `on` is a map of event name to per-event filters (`src/triggers/configuration/schema.ts:121`). GitHub's conversation key is `["github", repositoryId, number]` for any event carrying a pull request or issue (`src/triggers/github/provider.ts:346-359`); Slack's is `["slack", team, channel, thread]` (`src/triggers/slack/provider.ts:183-191`).                                                                                                                |
| Credentialed sessions           | A session whose run has a `github` grant or any env value templated from a connection is credentialed (`src/agent-sessions/index.ts:274-281`). Once all its executions finish, the next arrival clears the key and creates a new agent (`:68-88`). Continuation across idle days needs an agent with no leased credential.                                                                                                                                                                                                                                                                                                                            |
| Clone                           | Hub never clones. `cwd` must be an existing absolute path and worktree modes assume a git repo there. Hub uses ten daemon RPCs, none of which touch the filesystem outside agent creation (`src/daemons/agents/index.ts:119-181`).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Per-machine env                 | `DaemonEnvironmentTarget.env` exists (`src/dispatcher/launch-machine-intent.ts:14`) but no authored surface writes it. All credentials are leased per execution and revoked at terminal (`src/execution-authority/index.ts:39-45`).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Agent env inheritance (Paseo)   | Verified. `resolveShellEnv` copies the daemon's `process.env` once per daemon lifetime (Paseo `packages/server/src/server/agent/provider-launch-config.ts:160`) and every agent launch gets it. Measured: a `CLAUDE_CODE_OAUTH_TOKEN` set only in the sprite's service env reached a Hub-dispatched agent, which answered.                                                                                                                                                                                                                                                                                                                            |
| Daemon state on disk (Paseo)    | Server id, keypair, Hub credential, agent records, and provider session files live under `PASEO_HOME`. Restart reconnects with the stored credential and no re-enrollment. Measured across a warm pause, a natural cold pause, and a checkpoint restore: same server id every time.                                                                                                                                                                                                                                                                                                                                                                   |
| Sprites: what is activity       | Inbound only: exec and console sessions, open TCP connections to the sprite URL, services handling HTTP, and held tasks. Measured: a service holding an outbound WebSocket and pinging every 10 s did not keep the sprite awake; it paused 60 s after the last exec closed.                                                                                                                                                                                                                                                                                                                                                                           |
| Sprites: pause and wake         | `active` → `warm` (memory frozen) → `cold` (docs say memory dropped). Warm resume kept pids, env, and the open TCP socket; guest time is corrected. A natural cold wake took 1.05 s and in this run also kept pids and memory; only a checkpoint restore restarted processes. Services came back unprompted after the restore in 25 s. Exec wakes a paused sprite in 0.4 s. An inbound URL request also wakes it but with no `http_port` the edge holds the request 30 s and returns 502.                                                                                                                                                             |
| Sprites: hold                   | `POST /v1/tasks {name, expire}` on the in-sprite management socket holds the sprite active; `expire` is capped at 3600 s; `PUT /v1/tasks/:name` refreshes; re-`POST` of an existing name is 409; `DELETE` releases and the sprite was warm within 15 s. All callable from outside through exec, and exec itself wakes the sprite first.                                                                                                                                                                                                                                                                                                               |
| Sprites: create and shape       | `POST /v1/sprites {name}` is the whole create body; no image, region, size, or env. The environment is a fixed full-Linux image (8 vCPU, 16 GB host, 99 GB overlay, node 24, python3, git) pre-provisioned in under a second. `policy/resources` exposes a memory limit only (default 8192 MB, `POST` to change); a `cpu` field is rejected.                                                                                                                                                                                                                                                                                                          |
| Sprites: services               | `PUT /v1/sprites/:name/services/:svc {cmd, args, env, dir, http_port, needs}`. Starts at boot, restarts on crash (measured under 10 s), survives checkpoint restore, and is the only way to set process env. A `PUT` with the same `cmd` is ignored even after `stop`; changing env is `DELETE` then `PUT`.                                                                                                                                                                                                                                                                                                                                           |
| Sprites: bootstrap              | As the non-root `sprite` user: `npm install -g @getpaseo/cli` 16 s, `@anthropic-ai/claude-code` 4 s, shallow clone 1 s. The Claude package's postinstall does not run, so its native binary is missing until `node <prefix>/lib/node_modules/@anthropic-ai/claude-code/install.cjs` is run. The exec shell is non-login and the npm global bin dir is not on `PATH`. First daemon boot downloads about 1 GB of local speech models into `PASEO_HOME`.                                                                                                                                                                                                 |

## 1. Problem

Hub dispatches only to a daemon someone enrolled by hand on a machine that stays up. Running a trigger for a repository means owning a build box, keeping it patched, and paying for it while idle. Trigger authors have no way to say "run this on a machine you create for me".

## 2. Goals

- A trigger declares a sprite target. Hub creates the sprite, bootstraps it, enrolls it, runs the agent, and lets the sprite pause on its own when nothing is running. No person touches the machine.
- Continuation survives a pause. A comment on a PR three days later continues the same agent with the same checkout, provided the trigger holds no leased credential (5.7).
- Idle targets cost storage only.
- No daemon protocol change and no Paseo change. A sprite runs a stock daemon installed from npm.
- Reuse Hub's existing dispatch wait, `machines` table, enrollment scope, and per-execution authority instead of adding parallel mechanisms.

## 3. Non-goals

- Workspaces created from the Paseo app or SDK landing on sprites. Only Hub triggers wake a sprite.
- Warm pools shared across triggers. A sprite belongs to one trigger.
- Hub cloning repositories. See 5.6.
- An execution backend inside the daemon. The daemon stays machine-local.
- Live observation of a sprite in the Paseo app. Hub Activity is the surface. Pairing a sprite as an app host stays possible and manual.
- Sprite support in the legacy multi-step bundle format. The `fly` and `docker` kinds are removed from it.
- Cloud-agnostic provisioning beyond one small provider interface. Fly Sprites is the first implementation. Fly Machines with a volume is the obvious second and would need image, size, region, and explicit stop and start added back to the interface.
- Choosing CPU or region. Sprites offers neither.
- Cross-provider continuation and agent-opened Slack threads. See `docs/cross-provider-continuation.md`.

## 4. Concepts

- **Sprite target.** A `run.target` whose `kind` is `sprite`. It is a template Hub materializes, unlike a daemon target, which references a daemon that exists.
- **Sprite.** One Sprites environment, owned by Hub and bound to one trigger. Its filesystem persists and is backed to object storage by the provider. It runs the Paseo daemon as a Sprites service, holds `/home/sprite` and the checkout, and enrolls as a daemon. Its row is the existing `machines` row.
- **Pause and wake.** Provider-owned compute states. The provider pauses a sprite about 30 s after the last inbound activity and wakes it on the next exec. Hub never asks for either directly. The daemon process, its env, and its identity survive both.
- **Hold.** A Sprites task that keeps a sprite active while it exists. Hub holds a sprite for the life of each execution on it and releases at terminal. Holding is the only way Hub spends compute on purpose.

One trigger maps to one sprite. Two triggers on the same repository get two sprites and two clones. A cross-trigger environment identity does not exist in Hub today and is not introduced here.

## 5. Requirements

### 5.1 Configuration

**Decision: `run.target` gains a `kind` discriminator. `kind: daemon` is the default and keeps today's shape. The legacy bundle drops `fly` and `docker`.**

```yaml
name: review
on: github.pull_request_comment_created
run:
  target:
    kind: sprite
    bootstrap: |
      npm install -g @getpaseo/cli @anthropic-ai/claude-code
      node "$(npm prefix -g)/lib/node_modules/@anthropic-ai/claude-code/install.cjs"
      git clone git@github.com:acme/project.git /home/sprite/workspace/project
    cwd: /home/sprite/workspace/project
    memory: 16384
    env:
      ANTHROPIC_API_KEY: sk-ant-...
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
  agent: { provider: claude, mode: bypassPermissions }
  prompt: ...
```

| Field       | Required | Notes                                                                                                                                                                                                                                                                                                              |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`      | yes      | `sprite`. Omitted or `daemon` keeps the current `{ daemon, cwd, worktree }` object.                                                                                                                                                                                                                                |
| `bootstrap` | yes      | Shell run once by exec after create, as the `sprite` user, with the npm global bin dir on `PATH`. It must install the agent CLIs and populate `cwd`. Hub installs the Paseo CLI before it runs and enrolls the daemon after it succeeds. Exit non-zero fails the sprite.                                           |
| `cwd`       | yes      | Absolute directory on the sprite. `bootstrap` is responsible for it existing and being a git checkout.                                                                                                                                                                                                             |
| `memory`    | no       | Memory limit in MB, applied through the resources policy after create. Defaults to the organization's configured default memory, 8192 unless changed (5.2). The only shape knob Sprites exposes.                                                                                                                   |
| `env`       | no       | Daemon service environment. Connection templates are resolved once when the service is written and stored on the sprite, so they are not per-execution leases and do not make sessions credentialed (5.7, 5.9). Templates resolve only for connection kinds Hub has; other provider keys are literal values (5.9). |
| `worktree`  | no       | Same schema and semantics as a daemon target.                                                                                                                                                                                                                                                                      |

There is no `idle` field. The provider pauses about 30 s after Hub releases the last hold, and there is nothing cheaper than that to ask for.

`auto_archive` must be `true` on a trigger with a sprite target; validation rejects `false`. Only an archived workspace is guaranteed restorable, and Hub does not control when the provider drops memory.

`TriggerTargetSchema` becomes a discriminated union with `kind` defaulting to `daemon`, so stored trigger YAML without `kind` keeps parsing. `compileTriggerDocument` stops hard-coding `kind: "daemon"` (`src/triggers/configuration/index.ts:42-46`) and passes the compiled target through.

Changing `bootstrap` on an active trigger destroys the sprite after in-flight executions finish and recreates it on the next arrival. The filesystem does not migrate. Changing `env` rewrites the service (delete then create) and restarts the daemon, which reconnects with its stored credential; no recreation. Changing `memory` updates the resources policy in place. The trigger editor shows a warning on save when `bootstrap` changes.

The legacy bundle compiler (`src/config/compiler.ts`) removes the `fly` and `docker` kinds and their rejection tests. No user can have a working reference to them.

Activation validates the target and checks that the organization has a Sprites credential configured. It creates the `machines` row and starts provider `create` plus bootstrap immediately, so the first arrival usually finds an enrolled, paused sprite and a bad `bootstrap` fails at activation rather than at first arrival.

That work runs inside the Hub process as a fire-and-forget job; nothing about it is durable except the `machines` row. The row is written `spawning` before the first provider call, and a Hub restart mid-bootstrap leaves it there until the recovery scan in 5.5 either finds an enrolled daemon for it and marks it `alive`, or destroys the half-built sprite, marks the row `terminated`, and lets the next arrival recreate it. No job table and no retry state.

### 5.2 Provider

**Decision: one interface with six calls, all plain HTTP requests to the Sprites API from Hub's own process. No CLI on the Hub host, no WebSocket client. Wake is not a call; exec wakes.**

| Call      | Input                              | Output                                                       |
| --------- | ---------------------------------- | ------------------------------------------------------------ |
| `create`  | name, memory                       | provider sprite id                                           |
| `exec`    | sprite, command, env               | exit code and output; wakes a paused sprite as a side effect |
| `service` | sprite, cmd, args, env, dir        | none; delete-then-put so env changes apply                   |
| `hold`    | sprite, task name, expiry ≤ 3600 s | none; one idempotent `PUT` that creates or refreshes         |
| `release` | sprite, task name                  | none                                                         |
| `destroy` | sprite                             | none; the filesystem is deleted                              |

`create` names the sprite after the trigger id, applies the memory policy, execs the Paseo CLI install (`npm install -g @getpaseo/cli@0.9.1`) and then the authored `bootstrap`, execs `paseo hub connect <origin> --api-key … --permission hub.execute` once, and writes the daemon service with `cmd: <prefix>/bin/paseo daemon run --home /home/sprite/.paseo`, `dir: /home/sprite`, and `env: { HOME, PASEO_HOME, PATH, PASEO_LISTEN=127.0.0.1:6767, PASEO_RELAY_ENABLED=false, PASEO_WEB_UI_ENABLED=false, PASEO_PASSWORD, …target.env }` with connection templates resolved. The sprite URL stays at `auth: sprite` and no service sets `http_port`; the sprite has no inbound surface and all traffic is the daemon's outbound Hub socket.

Transport, measured in spike 6 (`docs/qa/sprites/README.md`): every call is `fetch` against `https://api.sprites.dev` with `Authorization: Bearer <org token>`. `create` is `POST /v1/sprites {name}`; memory is `POST /v1/sprites/:name/policy/resources {memory: {limit_mb}}`; services are `PUT` and `DELETE` on `/v1/sprites/:name/services/:svc`, and a `PUT` whose `cmd` matches the running service is ignored, so an env change is `DELETE` then `PUT`. `exec` is `POST /v1/sprites/:name/exec` with `cmd` repeated once per argv element, optional `env=KEY=VALUE` (repeated) and `dir`, and `stdin=true` to send the request body to the process, which is how the multi-line `bootstrap` script reaches `sh -s`. The response is a byte stream in which each HTTP chunk is one frame: a channel byte (1 stdout, 2 stderr, 3 exit) followed by payload, with the exit frame last and carrying one exit-code byte. A silent 90 s command completes; nothing at the edge cuts an idle response. The task endpoints are not reachable from outside the sprite (`/v1/sprites/:name/tasks` is 404), so `hold` and `release` are `exec` of `sprite-env curl` against the in-sprite `/v1/tasks`. `PUT /v1/tasks/:name` creates the task when it is missing and refreshes `expires_at` when it exists, so hold and refresh are the same idempotent call and no 409 handling exists; `DELETE` of a missing task returns 404, which release tolerates. `sprite-env curl` exits 22 on any HTTP error and names the status in stderr. The WebSocket form of exec exists for TTY sessions and is not used. The decoder is `docs/qa/sprites/spike6-decode.mjs`.

Organization settings hold the Sprites org token and the default memory, in a new `organization_sprites_configuration` table keyed by organization id with `token`, `memory_mb`, `updated_at`, and `updated_by_user_id`, following `organization_api_keys`. An earlier draft pointed at `runtime_provider_configuration` (`src/db/schema.ts:1245-1246`); that table is one row per Hub instance per provider with a CHECK limited to the four connection providers and mandatory verified-identity columns, so it cannot hold a per-organization credential. The connection tables cannot either, since each is provider-specific and there is no generic API-key connection. Hub has no secret encryption layer; adding one is out of scope and the security section says so.

### 5.3 Enrollment and binding

**Decision: bind sprite to daemon through a per-sprite API key. No new token column, no CLI change, no Paseo change.**

At `create`, Hub mints an organization API key scoped `daemons:enroll` only, stores its id on the `machines` row, and passes it to `paseo hub connect` by exec. Enrollment records `registeredByApiKeyId` on the daemon row, so Hub matches daemon to sprite through that key and links `daemons.machineId` to the pre-created row instead of inserting a fresh machine. Hub revokes the key once the daemon is enrolled. The ten-minute enrollment token lifetime is not a constraint, because the CLI mints the token immediately before using it. `--permission hub.execute` is mandatory: without it the daemon enrolls with no permissions and is not a dispatch target.

A daemon holds exactly one Hub relationship. Recreation is a new sprite with a fresh `PASEO_HOME`, so this never needs `paseo hub disconnect`.

Hostname-derived slugs collide across sprites; the existing one-shot suffix `<slug>-<daemonId[0:8]>` handles it (`src/db/pg.ts:1598`) and was observed. Hub renames the slug to the trigger name after enrollment so the Daemons page reads well.

The daemon enrolls with `hub.execute` and nothing sprite-specific.

### 5.4 Ledger

**Decision: the `machines` row is the sprite ledger. No new table, no new status, no new columns.**

- `MachineSource` gains `{ kind: "sprite"; triggerId; spriteName; apiKeyId }`.
- `MACHINE_STATUSES` stays `{ spawning, alive, terminated }`. `spawning` covers create and bootstrap. Pause is a provider state Hub neither stores nor needs; the daemon socket plus the hold set are the truth.
- `specs` holds the bootstrap hash and memory as materialized.

Daemon revocation already marks the row `terminated` through `failPendingExecutionsForDisconnectedMachine`; for a sprite Hub also calls `destroy`, and a revoked sprite is recreated on the next arrival. Trigger deletion destroys the sprite. A provider-reported loss marks the row `terminated`; the next arrival creates a new sprite with a new daemon identity, and 5.7 handles the sessions bound to the old one.

### 5.5 Dispatch

**Decision: hold before dispatch. The socket is not proof of anything.**

Measured: a paused sprite keeps its outbound socket open, so `canDispatchToDaemon` stays true, Hub dispatches into a frozen daemon, and the run fails 120 s later as `daemon_timeout`. The deferral path never runs. So for a sprite target the launch intent carries `machineId`, and before `handoffLaunchMachineIntent` the lifecycle does:

1. If the row is `terminated`, create a new sprite as in 5.1 and defer as today.
2. If the row is `spawning`, defer. Concurrent arrivals see the durable status and never call the provider twice.
3. `hold(sprite, execution id, 60m)`. Exec wakes the sprite if it was paused; the daemon's socket resumes or reconnects within seconds (measured: about 5 s from hold to "Client connected via hello").
4. If the socket is not live yet, defer as today. The engine's 250 ms re-claim picks it up the moment the daemon connects. The wait stays bounded by the trigger's `max_runtime`, exactly as an offline daemon target is today.
5. Hand off.

Measured from a warm pause: the daemon reconnects 0.4 to 1.4 s after the hold and the handoff follows within 1.5 s. From a cold sprite (about 10 minutes after the pause) a wake took 64 s to a daemon reconnect, with a 30 s `git rev-parse` timeout in the daemon, so a dispatch from cold defers about a minute. The deferral is bounded by the trigger's `max_runtime`, so authors need nothing. Pause to Hub marking the daemon offline varied from 5 s to 125 s across runs, so both the open-socket and the closed-socket case occur in practice and the lifecycle handles both.

The hold in step 3 is issued once per execution attempt, not once per claim. A deferred run is re-claimed every 250 ms, and the engine's claim loop must not reach the provider on each pass: the lifecycle keeps an in-memory set of execution ids it has already held and skips step 3 when the id is present. The set is cleared when the execution reaches terminal; the refresh tick (5.8) re-issues the same idempotent call on its own schedule.

`startup_timeout` keeps its meaning and still starts when the daemon is connected. Measured dispatch-to-reply on a woken sprite was about 6 s, so authors need nothing special.

The hold runs beside the claim loop, not in it, so a slow wake defers only its own run. A `hold` that times out after 20 s or fails on the provider side (a 5xx, or `curl` failing inside the exec) is not an error of the sprite: the row stays `alive`, Hub logs a warning, and the next visit holds again until the trigger's `max_runtime`. A 404 means the sprite is gone: like any other `hold` error or a provider error from `create`, it marks the row `terminated` with the provider message as `shutdownReason`, and the next claim recreates the sprite. A new failure reason `sprite_unavailable` is raised at deferral time when the row is `terminated` and recreation also failed, so authors do not wait two hours to learn about a bad bootstrap.

On Hub restart, a recovery scan reconciles every `spawning` sprite against provider state and re-holds every sprite with an active execution, like `recoverWorkflowDeadlines` does for runs.

### 5.6 Repository materialization

**Decision: `bootstrap` populates `cwd`. Hub does not clone.**

Hub has no clone operation, its GitHub tokens are leased per execution, and Hub's own rule is that it never acts with authority a step did not declare. A first-boot clone by Hub would need a machine-scoped credential lease, which this PRD avoids.

The authored `bootstrap` clones, using a deploy key or token the author puts in `target.env` or writes to the sprite during bootstrap. The docs carry the three measured gotchas: run the Claude Code postinstall explicitly, use absolute paths because the exec shell is non-login, and install Claude Code in `bootstrap` before the service starts, because the daemon detects agent providers at startup — installing it on a running sprite leaves every run failing with `Provider 'claude' is not available` until the sprite is recreated. A Hub-driven clone with a machine-scoped lease is a follow-up.

### 5.7 Continuation

Continuation works across pauses because trigger, sprite, and daemon are one-to-one and the daemon identity persists on the filesystem. The session model does not change. Two things around it do.

**Measured.** With a fixed continuation key, a first run said "Remember the word pineapple" and got "OK". The sprite paused, one dispatch failed for want of a hold, then a held dispatch restored the archived workspace, the daemon logged "Agent resumed from persistence" for the same agent, and the agent answered "pineapple" and called `finish_execution`. The Claude transcript on the sprite is one session across the pause, both failures, and the archive plus restore. No Hub code changed for this.

**Worked example: a PR reviewer.** One trigger listens to `github.pull_request_label_added` with a `label` filter and `github.pull_request_comment_created` with a `from_users` filter. Both events on one PR derive the same conversation key, so the comment lands on the agent that did the review. Two separate triggers would be two hidden projects and two agents; the PRD documents this in the Hub trigger docs.

On the second arrival Hub attaches the execution to the session, then: an execution still active on the sprite means the agent is alive and held, and the comment is sent as a new message that steers the running review; no active execution means the workspace was archived at terminal, because sprite targets require `auto_archive` (5.1), so Hub holds, which wakes the sprite, sends `workspace.recovery.restore.request`, then sends the message; a closed or errored agent fails the run `agent_interrupted`.

**Decision: a sprite reviewer that must remember across days runs without per-execution leased credentials.** A `run.github` grant or a connection template in `run.env` makes the session credentialed (`hasTemporaryCredentials`, `src/agent-sessions/index.ts:274-281`), and Hub clears the key once every execution finishes. Comments while a review is active continue the agent; a comment the next day gets a fresh agent. To keep memory across idle days, provider keys go in the target's `env` (5.1), which lives in the service definition and is not a lease, and the GitHub credential lives on the sprite with the trigger omitting `run.github`. The trigger editor warns when a sprite target is combined with `continuation.mode: conversation` and either `run.github` or a connection template in `run.env`, because the author is asking for something the two settings cancel. This trade is a security decision and is recorded in 5.10.

**Sprite recreated.** When a sprite is recreated with a new daemon identity, Hub clears `continuationKey` on every session bound to the old daemon, the same transition already used to invalidate a session (`src/agent-sessions/index.ts:88`). The next arrival creates a fresh agent instead of failing with "Continuation agent was deleted". Activity notes the reset on that run.

**Cross-provider continuation.** A Slack thread joining a PR's agent is `docs/cross-provider-continuation.md`. It changes the continuation key scope and adds conversation aliases; nothing here depends on it.

### 5.8 Hold

**Decision: one hold per execution, named by execution id, refreshed by a tick, released at terminal. No idle deadline of Hub's own.**

- `hold` at execution `spawning` (5.5 step 3), with the maximum expiry of 3600 s.
- A scheduler tick re-issues the same idempotent `PUT` for every execution that is still `spawning` or `running`, on every pass, by default every 5 minutes. There is no age test: the `PUT` is one exec on a sprite the hold already keeps awake, so comparing the hold's age buys nothing and costs a clock read. Because `PUT` creates a missing task, a task that did not survive a provider restart is recreated by the same call.
- `release` when the execution reaches a terminal state. Sibling executions on the same sprite each hold their own task, so nothing is counted.
- The provider pauses the sprite within about 1 s of the last release (measured: `last_warming_at` 10:54:18 for a terminal at 10:54:18.6, and 11:01:53 for a terminal at 11:01:52.8). Release therefore has to come after the terminal hub action (archive or interrupt) has been delivered, not at terminal itself, which is how the lifecycle now orders it; releasing at terminal left the `auto_archive` action to time out 30 s later and complete only on the next wake.
- Startup recovery re-holds from execution rows, like execution deadlines.

Because a hold is bound to an execution row, an agent mid-turn is by construction held, and a follow-up on a continuing agent holds again. A workspace script an agent started is not tracked; first cut ignores it. The cost of a lapse is a frozen turn, not lost work: the process and its memory survived every pause measured, and the daemon reconnects on the next hold.

### 5.9 Credentials

**Decision (2026-09-17): provider credentials live in the organization's Sprites configuration, not in the trigger.** The sprite runs stock Claude Code with the operator's Claude subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, minted with `claude setup-token`), and Sprites connectors cannot carry it: the Anthropic connector accepts API keys only, and a Custom API connector cannot send Anthropic's required `anthropic-version` and `anthropic-beta` headers (its save-time probe answers 400). So `organization_sprites_configuration` holds an `env` map beside the org token, managed on the Settings → Sprites page with write-only values, and Hub writes it into every sprite's daemon service env below the target's `env` (target wins on a clash). The same map is the environment of the `bootstrap` exec (below the target's `env` there too), so a clone credential for a private repository lives in it as well and `bootstrap` reads it as an ordinary variable; nothing is written to disk by Hub. Rotation is a settings save that rewrites every live sprite's service, the same delete-then-put path as a target `env` change. Nothing secret enters trigger YAML or revision history. The target's `env` stays for per-trigger, non-secret values; a `${{ paseo.connections.<slug>.<value> }}` template there resolves only for a connection kind Hub has and only when it needs no execution lease, which today means none of them, so activation fails such a template with a message naming the key. The GitHub connector of Sprites (spike 7) proxies the GitHub REST API for a sprite with no token on it and is optional tooling for continuation, not part of this design; it does not carry git. Hub resolves templates once when it writes the daemon service, the provider keeps them in the service definition for the sprite's life, and the daemon and the agents it spawns inherit them. Measured with a Claude Code OAuth token, which also works here because the agent is Claude Code and reads `CLAUDE_CODE_OAUTH_TOKEN`. Rotation is rewriting the service, which restarts the daemon in seconds and needs no recreation. Measured cost of a change to the org `env` map: every alive sprite's service is rewritten one at a time inside the request, about 6.7 s each (the delete-then-put restarts the daemon, which was offline for about 4.7 s), a paused sprite is woken by the put, and the settings save waits for all of them. `run.env` connection templates still work on a sprite target, but they are per-execution leases: they make the session credentialed and end continuation at terminal (5.7). Follow-ups reuse the existing agent's environment. Sprites hold no interactive provider logins; a bootstrap that needs one is a misconfiguration and the docs say so.

GitHub authority for the agent uses the existing `run.github` grant with per-execution leased installation tokens when the author accepts that continuation ends at terminal. A trigger that needs memory across idle days omits `run.github` and relies on a credential on the sprite (5.7).

### 5.10 Security

- The per-sprite API key has scope `daemons:enroll` only and is revoked after enrollment.
- The sprite has no inbound surface. Its URL stays organization-only and no service binds an `http_port`. `PASEO_PASSWORD` is set so a misconfiguration that exposes the daemon port is not open.
- The Sprites org token is stored as plain text in `organization_sprites_configuration`, unencrypted. It can exec into every sprite in the org, so operators self-hosting Hub should treat the database as holding shell access to their sprites.
- `SECURITY.md` and Paseo `public-docs/hub/security.md` state that a sprite runs untrusted trigger input with whatever `bootstrap` installed. The bootstrap is the trust boundary.
- Provider keys in the service env (5.9), including the operator's Claude subscription token, and a long-lived GitHub credential on the sprite (5.7) trade per-execution leases for memory across idle days. An untrusted pull request comment reaches an agent that holds them; the operator accepts that for a self-hosted instance. They live as long as the sprite and reach every agent on it. The docs say so and recommend a fine-grained GitHub token scoped to the one repository, since untrusted PR comments reach an agent holding it.
- Sprites offers a DNS egress allowlist (`policy/network`). Not used in the first cut; noted as the cheap way to fence a sprite later.

### 5.11 Dashboard

Per `docs/design.md`: state through `StatusPill`, never a badge.

- Daemons page: sprite daemons show the owning trigger as the `TwoLine` secondary line and their machine status as a `StatusPill`. Rename is disabled.
- Trigger detail: a Sprite section with status, sprite name, memory, last run, and `RowActions` for Recreate.
- Activity run detail: machine status at dispatch time (`spawning` or `alive`) is shown from the `machines` row. Execution status stays the existing closed enum.

## 6. Lifecycle summary

| Event                                | Sprite action                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Trigger activated with sprite target | create machine row, provider `create`, bootstrap, enroll, write service; provider pauses it |
| Arrival while paused                 | `hold`, which wakes it; engine defers until the socket is live; dispatch                    |
| Arrival while awake                  | `hold`, dispatch                                                                            |
| Execution terminal                   | `release` after the terminal hub action; provider pauses within about 1 s                   |
| Every tick (5 min)                   | re-issue every active hold                                                                  |
| `bootstrap` changed                  | `destroy` after in-flight executions, recreate on next arrival                              |
| `env` changed                        | rewrite service; daemon restarts and reconnects                                             |
| `memory` changed                     | update resources policy                                                                     |
| Trigger deleted                      | `destroy`                                                                                   |
| Provider reports sprite lost         | mark `terminated`, next arrival recreates, sessions reset                                   |
| Daemon revoked                       | existing path marks `terminated`; `destroy`; next arrival recreates                         |

## 7. Ceilings

- **One sprite per trigger.** A burst of arrivals on one trigger runs on one machine. Fan-out means more triggers, and two triggers on one repo clone it twice. Per-execution sprites are a later addition that gives up continuation.
- **Fixed shape.** 8 vCPU on a 16 GB host, memory limit adjustable, no CPU or region choice. A trigger that needs more is a Fly Machines target, which this interface does not yet have.
- **One hour per hold.** The refresh tick is load-bearing. A Hub outage longer than the remaining expiry on a hold lets the sprite pause mid-turn; the turn resumes on the next hold.
- **One Hub instance per database.** Restart recovery treats every `spawning` sprite row as its own; a second instance starting would retire the first's in-flight bootstraps.
- **First boot is about a minute.** Bootstrap installs in about 25 s and the daemon's first start pulls about 1 GB of speech models. A warm wake is about a second; a cold wake measured 64 s to a daemon reconnect, so an arrival on a cold sprite defers about a minute.
- **Org credential changes are serial.** A Sprites settings save rewrites every live sprite's service one at a time, about 6.7 s each, and the save waits for all of them.
- **Clone is the bootstrap's job.** Hub-driven clone waits on a machine-scoped credential lease.
- **Legacy bundles cannot target sprites.**
- **Leased credentials and long memory are exclusive.** A trigger with `run.github` or a connection template in `run.env` continues only while an execution is active. This is Hub's existing rule, not a sprite limitation; target `env` is the way around it.
- **Sprite targets always archive.** `auto_archive: false` is rejected, so an agent is never left live across a pause without a hold.

## 8. Rollout

1. **Hub.** Target schema with `bootstrap`, `memory`, `env`, and the `auto_archive` rule; removal of `fly` and `docker`; provider interface with the Sprites implementation; `machines` source extension; per-sprite API key binding with `--permission hub.execute`; hold-before-dispatch in the lifecycle; refresh tick and release at terminal; restart recovery; session reset on recreate; the editor warning for sprite targets that combine conversation continuation with a leased credential. Gated by an entitlement.
2. **Hub.** Dashboard surfaces and security doc, including the multi-event reviewer example in the trigger docs and the bootstrap gotchas.
3. **Paseo docs only.** Fix `public-docs/hub/activity.md` and `daemons.md` where they say offline dispatch fails, and document that `paseo hub connect --api-key` needs `--permission hub.execute` to be a Hub target. No code change. Making `hub.execute` the CLI default is a separate Paseo decision.
4. **Beta** on one internal trigger. Success is a week of arrivals with no manual machine touch and continuation working after a pause.

## 9. Open questions

- **Cold semantics.** The docs say cold drops memory; the one natural cold wake measured kept it. Treat cold as memory-dropping in the design and enjoy it when it is not.
- **Tasks across a provider restart.** Not measured whether a held task survives a cold restart. 5.8 handles a 404 on refresh either way.
- **Slug rename after enrollment.** Cosmetic; drop it if the Daemons page reads fine with suffixed hostnames.
- **Second provider.** Fly Machines with a volume for triggers that need shape or region. Not committed.
- **Two side requests from Claude Code's MCP client.** `GET /agent-sessions/:id/mcp` returns 500 "Only HTML requests are supported here" because the route has no GET handler; a 405 is correct. One `POST` returned 400. Neither blocked tool calls. Fix the GET while in the area.
