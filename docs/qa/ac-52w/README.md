# ac-52w: verification of PR #11 (hold a sprite before dispatching to it)

Head verified: `d70e75d` (`git rev-parse --short HEAD` = `origin/sprite-targets/hold-before-dispatch`, checked
after `git fetch origin`). The branch is one docs-only commit behind `origin/main` and was neither merged nor rebased.
No product code was changed. All times are UTC on 2026-09-17.

Hub start recipe (production build, fresh database):

1. `docker run -d --rm --name qa-ac52w-pg -e POSTGRES_PASSWORD=qa -e POSTGRES_USER=qa -e POSTGRES_DB=hub -p 55452:5432 postgres:17-alpine`
2. `npm run build`
3. `cloudflared tunnel --url http://localhost:3000` (quick tunnel; hostname kept in a private temp dir)
4. `node dist/index.js` with `DATABASE_URL=postgres://qa:qa@127.0.0.1:55452/hub`, `PASEO_HUB_APP_URL=<tunnel>`,
   `PASEO_HUB_AUTH_SECRET=<random>`, `PASEO_BOOTSTRAP_ORGANIZATION=qa-ac52w`,
   `PASEO_BOOTSTRAP_OWNER_EMAIL=qa-ac52w@example.com`, and `PASEO_BOOTSTRAP_OWNER_PASSWORD=<random>`. Startup ran the
   migrations and provisioned the organization.
5. Temporary Sprites org token: `sprite api /v1/tokens -- -X POST`, stored chmod 600 in a private dir.
   `QA_PG=… SPRITES_TOKEN_FILE=… API_KEY_FILE=… npx tsx docs/qa/ac-52w/seed-hub.ts` stores it on the org and mints a
   `configuration:install, projects:read, runs:dispatch` key. The seed script uses no entitlement override.
6. Install `trigger.yml` with `POST /api/v1/triggers/install`. Fire runs with `run.sh <deliveryKey>`, which calls
   `POST /api/v1/manual-runs`. The trigger name resolves the hidden project, so `projectSlug` is ignored.

`trigger.yml` is the final revision. Version 1 had no Claude Code install in its bootstrap and used key `qa-ac52w`.
Version 2 added the Claude Code install and postinstall. Versions 3 to 6 only changed the continuation key
(`-v2` for s6, `-v3` for s3, `-v4` for s4, `-v5` for s5), so every scenario got a fresh agent.
The trigger always had `max_runtime: 5m` and `idle_timeout: 2m`. The environment has no Claude credential.
Every run that reached an agent therefore ended with `step_idle_timeout`, which is a valid terminal state here.

Helpers: `watch.sh` samples machine, daemon, run, and sprite status every 2 s. `fastwatch.sh` polls only the database
every 0.5 s and never touches the sprite. `tasks.sh` lists the in-sprite tasks with an exec of `sprite-env curl /v1/tasks`,
the same path `client.ts` uses; that exec wakes a paused sprite. `s5-fire-when-paused.sh` fires a run at a chosen
pause age. `runs-summary.log` lists every run, execution, and daemon (ids shortened to 8 characters).

| #   | Scenario                                | Command                                                                                           | Result                            | Evidence                            |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| 1   | Harness regression                      | `npx vitest run src/daemons/sprites/dispatch.test.ts src/daemons/lifecycle.test.ts src/workflows` | pass, 77/77 (2 runs), gaps listed | `s1-harness.log`                    |
| 2   | Fresh-DB entitlement                    | Hub startup on an empty Postgres; `select * from organization_entitlements`; `seed-hub.ts`        | pass, no override                 | `s2-entitlement.log`                |
| 3   | Awake sprite: hold, handoff, release    | `run.sh qa-run-1`, `qa-run-1c`, `qa-run-3` with `tasks.sh` and `watch.sh`                         | pass                              | `s3-awake-hold-handoff-release.log` |
| 4   | Paused sprite, daemon socket closed     | wait for `daemons.presence = offline`, `run.sh qa-run-2`, `fastwatch.sh`                          | pass                              | `s4-paused-socket-closed.log`       |
| 5   | Paused sprite, daemon socket still open | `s5-fire-when-paused.sh … qa-run-3b` (fired 42 s into the pause), `fastwatch.sh`, daemon log      | pass (3rd attempt)                | `s5-paused-socket-open.log`         |
| 6   | Recreate path on a real sprite          | `update machines set status='terminated', shutdown_reason='qa'`, `run.sh qa-run-4`, `watch.sh`    | pass, findings 4 and 5            | `s6-recreate.log`                   |
| 7   | Cleanup and secret grep                 | `DELETE /v1/sprites/<n>`, `DELETE /v1/tokens/<id>`, kill by PID, `docker stop`, `grep -rF`        | pass                              | `s7-cleanup.log`                    |

What each scenario showed:

1. All 7 `dispatch.test.ts` cases from the PR's "Changes" list exist and pass, as do lifecycle (10) and workflows (60).
   Checked against the claims:
   - Awake: the hold call and the intent's `machineId`/`daemonId` are asserted. The test does not check that the hold
     came before the handoff; providerCalls and dispatches are separate arrays.
   - Socket closed: one hold across 3 claims with no dispatch, then a handoff once the socket opens, still one hold.
     Asserted.
   - Spawning: no provider call and no dispatch. Asserted. The run status is not checked.
   - Terminated: `activations === 2` after 3 claims. **Gap**: the stub activation inserts a `spawning` row, so claims 2
     and 3 defer on `spawning`. The `recreatedSpriteExecutions` guard is never exercised. Neither is the
     "terminated again for the same execution → `sprite_unavailable`" branch.
   - Recreation fails: `failed` / `sprite_unavailable`. Asserted.
   - Hold error: row `terminated` with `Sprites API 503: unavailable`, no dispatch, next claim recreates. Asserted.
   - Two executions: distinct holds, two releases in order, one via completion callback, one via
     `failPendingExecutionsForDisconnectedMachine`. Asserted.
   - Untested branches: an `alive` row with no daemon yet (defer), and a release error that is swallowed.
2. The stored document is `granted.canUseSpriteTargets: true`, `overrides: {}`, source `provisioning`, `plan_id` null.
   `seed-hub.ts` read the effective value as `true`. No later scenario used an override.
3. Run 1 was on the first sprite, awake. The hold task was named by the execution id with a 60 m expiry at 10:46:55.
   The intent carried `machineId` = the machine row id. The daemon answered at 10:46:57.8 with
   `Provider 'claude' is not available`, and the task was gone by 10:47:04. Run 3 was on the recreated sprite, which
   has Claude Code. Hold at 10:55:19, handoff at 10:55:19.4, and the agent called Hub's session MCP at 10:55:21.
   All 30 task samples up to 10:57:20 listed the hold. Terminal `step_idle_timeout` at 10:57:22.1; no task at 10:57:26.
4. The sprite paused at 10:57:31 and Hub marked the daemon offline at 10:59:31.6. The run was fired at 10:59:48 and
   was `running` with no execution row at 10:59:49.7. Hold task at 10:59:49, daemon reconnect at 10:59:50.417,
   handoff at 10:59:50.555. **Hold to reconnect was 0.4 to 1.4 s; hold to handoff 0.6 to 1.5 s.** Terminal at 11:01:52.8,
   task released at 11:01:53.
5. The sprite paused at 11:26:38. At 11:27:20 (42 s later) presence was still `connected`, with `connected_at` unchanged
   since 11:26:28.8. Hold at 11:27:20, handoff at 11:27:20.66, agent created at 11:27:21.5. The daemon log has no
   disconnect or reconnect: the same socket survived the pause. Terminal `step_idle_timeout` at 11:29:24, **not
   `daemon_timeout`**, and the task was released. Two earlier attempts missed: one through a bug in my fire
   script, one because the sprite paused before the script started.
6. After the terminate, a new row `spawning` appeared within 0.25 s, along with exactly one new enroll key. The Hub log
   has "destroy leftover" before "create", and the sprite id changed. The run deferred for 32 s. The new daemon
   connected at 10:52:16.108 and the handoff followed at 10:52:16.123, with an intent carrying the new
   `machineId`/`daemonId`. The agent was created on the new sprite's daemon.
7. Sprite `DELETE` 204, then `GET` 404 and an empty list. Token `DELETE` 204, then 401 with that token. Hub exited 2 s
   after SIGTERM, but no daemon was connected by then, so ac-rst was not exercised. Tunnel and Postgres stopped.
   The grep of this folder for the Sprites token, the tunnel hostname, the owner password, the auth secret, the public
   API key, and `PASEO_PASSWORD=` found 0 matches.

## Findings

1. **Release comes before the `auto_archive` hub action, so the archive stalls on a paused sprite.**
   `notifyExecutionTerminal` releases the hold first, and the sprite pauses within about 1 s. The archive hub action
   then times out: `daemon.execution.hub-action failed {hubAction: archive}` fired 30 s after terminal for executions
   `35e7ace7` and `fcc0340c`. The archive only completes on the next wake: 10:59:50.509, 46 ms before the next
   handoff, and 11:18:46, when an unrelated exec woke the sprite 17 min later. It happened in both runs where nothing
   else kept the sprite awake. PRD 5.7 assumes the workspace is archived at terminal. The hold should outlive the
   terminal hub action.
2. **The pause follows the last release within about 1 s, not about 30 s** (PRD 5.8). The sprite reported
   `last_warming_at` 10:54:18 for terminal 10:54:18.6, and 11:01:53 for terminal 11:01:52.8. This is what makes
   finding 1 bite.
3. **Pause to Hub-offline varies: 5 s, 120 s, 125 s, 110 s** over four pauses. ac-vni measured 74 s. A socket that is
   still open 42 s into a pause is common, and so is a closed one. The PR handled both.
4. **After recreation, the execution records the old daemon.** For s6's execution `eee20edc`, the intent and the agent
   are on the new daemon `eb616a99`. `agent_executions.daemon_id` is the old `06e580e0`, copied from the continuation
   session's `daemonId` in `attachAgentToExecution`. That execution's archive hub action never completed
   (`hub_action_completed_at` null). The session was created by a run that never reached an agent, so no stale agent
   existed to fail on. The PR says "Sessions. Continuation on sprite targets needs no change". This shows recreation needs the
   PRD 5.7 session reset, currently ac-50k. The old daemon row stays `active` (offline, not revoked), as the PR's
   follow-ups state.
5. **Changing `bootstrap` does not recreate the sprite and breaks key continuation.** Re-saving with a new bootstrap
   left the `alive` row on the old `bootstrapHash`. The next run with the same key failed immediately with
   "Continuation settings differ from the existing agent". The compatibility fingerprint includes the target and its
   bootstrap. PRD section 6 says to destroy and recreate; that is ac-50k scope, recorded because it shaped this run
   plan.
6. **Hub logs nothing for a successful hold, release, or handoff.** Only failures are logged. The spawn and handoff
   times here come from `agent_executions` rows, in-sprite task `started_at`, and the daemon log. No Hub line proves
   a handoff.
7. The hold on the recreated sprite in s6 was not sampled during that run. It is inferred: the intent carries
   `machineId`, and `prepareSpriteDispatch` returns `ready` only after `hold` resolves. s3 to s5 show the hold
   directly on the same sprite.
8. The daemon detects providers at startup. Installing Claude Code on a running sprite still gave
   `Provider 'claude' is not available` until the sprite was recreated from a bootstrap that installs it. Both such
   runs held, handed off, failed fast, and released correctly. This belongs in the 5.6 bootstrap docs, not the PR.
9. With no Claude credential, the agent calls `/agent-sessions/:id/mcp` (POST 400, then GET 405). It never finishes,
   and the run ends as `step_idle_timeout` after 2 m, not as an authentication failure. The daemon logs
   "Claude query operation did not settle cleanly".
10. A cold wake is slow. After about 10 min warm, the sprite went `cold`. An exec from cold took 64 s to a daemon
    reconnect, and the daemon logged a 30 s `git rev-parse` timeout. A hold-first dispatch from cold would defer about
    1 min, far above PRD 5.5's "about 5 s". The run survives, since the deferral is bounded by `max_runtime`.
11. Test gaps in `dispatch.test.ts`, from scenario 1: the recreate-once guard and the "terminated again → unavailable"
    branch are not exercised. Also untested: an `alive` row with no daemon, a swallowed release error, and
    hold-before-handoff ordering.
12. The hold task is created before the execution row exists. In s4 the task `started_at` was 10:59:49 and the row
    was created at 10:59:50.555. This matches the PR's follow-up: an unreleased hold falls back to the 60 m expiry.
13. After recreation the daemon slug is `trigger-<id>-<daemonId[0:8]>` (hostname collision suffix), not the trigger
    name (ac-vni finding 4).
