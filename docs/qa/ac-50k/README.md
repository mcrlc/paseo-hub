# ac-50k: verification of PR #16 (recreate, rewrite, or destroy a sprite when its trigger changes)

Head verified: `fe83ab1` (`git fetch origin`, then `git rev-parse --short HEAD` equals
`git rev-parse --short origin/sprite-targets/trigger-edits`). No product code was changed in this round;
the only writes are under `docs/qa/ac-50k/`. All times are UTC on 2026-09-17 unless a Hub log line is
quoted, which carries `+0300`.

## Recipe delta from ac-52w

The `docs/qa/ac-52w/README.md` recipe was reused as written, with these differences:

1. **Ports.** Postgres container `qa-ac50k-pg` on **55438**, Hub on **3001** (`PORT=3001`), its own
   cloudflared quick tunnel. Another verifier held 3000 and 55437 throughout; a third held 55471.
2. **The temporary token's description is honoured now.** `sprite api /v1/tokens -- -X POST -d
'{"description":"qa-ac-50k"}'` came back in the token list as `qa-ac-50k`, so `inserted_at` was not
   needed to identify it. The POST response still has no `id`; the id was read from `GET /v1/tokens`.
   The response body is preceded by two `Calling API:` / `URL:` lines that must be stripped before
   `JSON.parse`. (ac-52w r2's recipe delta 2 is out of date on the description.)
3. **`seed-hub.ts` is ac-52w's unchanged**: no entitlement override (`effective.canUseSpriteTargets: true`),
   organization default memory 8192, no organization env, and a
   `configuration:install, projects:read, runs:dispatch` key.
4. **The bootstrap installs Claude Code**, as ac-52w's does. The brief's executions have to end by
   `step_idle_timeout`, and that only happens if an agent is actually created; without Claude Code the
   daemon answers `Provider 'claude' is not available` and no agent, hence no real session, exists.
5. **New helpers** in this folder: `install.sh` (POST `/api/v1/triggers/install`, prints the save latency),
   `run.sh` (POST `/api/v1/manual-runs`), `db-poll.sh` (Postgres only, prints machines, daemons,
   executions, runs and sessions on change every 0.5 s, never touches the sprite), `sprite-exec.sh`
   (one `sh -c` exec; this wakes a paused sprite). Seven trigger YAML variants, `trigger-v1.yml` to
   `trigger-v7-enabled.yml`, are the exact bodies installed.
6. **Trigger id reuse.** `installTrigger` (`src/app.ts:358-366`) looks the name up in `store.list()` and
   passes the existing `triggerId`, and `listOrganizationTriggers` has no `enabled` filter, so a disabled
   trigger keeps its id. Every save in this round is an edit of trigger `9803bdab-…`, sprite
   `trigger-9803bdab-ed94-44cc-938d-484098f54241`.
7. **The Daemons page needs a browser.** Revocation is only reachable through the TanStack server
   function; two curl routes were tried and rejected (see `s6-daemon-revocation.log`), so scenario 6 was
   driven through the real page with Playwright, including the forced password change and app setup.

No real Claude credential was read or used. `~/.config/hub-spike/anthropic_key` was never opened.

## Results

| #   | Scenario                                     | Command                                                                                                     | Result                          | Evidence                      |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------- |
| 1   | Harness regression                           | `npx vitest run src/daemons src/triggers src/agent-sessions`                                                | pass, 596/596, 2 skipped        | `s1-harness.log`              |
| 2   | Unchanged, env-only, memory-only edits       | `install.sh trigger-v1.yml` (x2), `trigger-v2-env.yml`, `trigger-v3-memory.yml`, `db-poll.sh`, `/proc` read | pass, finding 3                 | `s2-unchanged-env-memory.log` |
| 3   | Bootstrap change while idle, then recreation | `run.sh qa-s3-run-1`, `install.sh trigger-v4-bootstrap.yml`, `run.sh qa-s3-run-2`                           | pass                            | `s3-bootstrap-idle.log`       |
| 4   | Bootstrap change while running               | `run.sh qa-s4-run-1`, `install.sh trigger-v5-bootstrap.yml` while `running`, then again once idle           | pass                            | `s4-bootstrap-running.log`    |
| 5   | Trigger disabled and re-enabled              | `install.sh trigger-v6-disabled.yml` / `trigger-v7-enabled.yml`, then disabling with a run `running`        | pass; findings 1, 2, 5 observed | `s5-disabled.log`             |
| 6   | Daemon revocation                            | Daemons page -> Actions -> Revoke (Playwright), then `run.sh qa-s6-run-1`                                   | pass                            | `s6-daemon-revocation.log`    |
| 7   | Cleanup and secret grep                      | `DELETE /v1/sprites/<n>`, `DELETE /v1/tokens/<id>`, kill by PID, `docker rm -f`, `grep -rF`                 | pass                            | `s7-cleanup.log`              |

### Scenario 1 in detail: what the new tests cover

`npx vitest run src/daemons src/triggers src/agent-sessions` -> **58 files passed, 2 skipped, 596 tests
passed, 2 skipped**, 493.89 s, one run, no reruns. The two skips are the real-Discord and real-Sprites
tests. Neither ac-shh.19 nor ac-shh.28 flaked, and nothing else did, so no `ci-flake` bead was filed.

Six new cases in `activation.test.ts` under "sprite trigger edits", one in `agent-sessions/index.test.ts`,
one in `client.test.ts`, one in `dispatch.test.ts`, plus an amended concurrency assertion. Against the
bead's four acceptance criteria:

| Bead acceptance criterion                                                                           | Covered by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changing bootstrap then sending an arrival runs on a new sprite with a fresh agent and a reset note | **Split across two tests, never end to end.** "destroys the sprite, revokes its daemon, and terminates the row when the bootstrap changes" plus "recreates the sprite on the next save once the row is terminated" cover the sprite half; "a new daemon for the same key resets the conversation and records the new daemon" covers the session half with two hand-written daemon ids and no sprite. No unit test drives bootstrap change -> arrival -> reset in one flow. Scenario 3 does. |
| Changing env restarts the daemon with the new env and no recreation                                 | "rewrites the daemon service when only the target env changes" asserts exactly one `service` call and `LITERAL: rotated` in the written env, and that the row stays `alive`. The daemon restart itself is the provider's delete-then-put; a unit test cannot see it. Scenario 2 measures it.                                                                                                                                                                                                |
| Changing memory is visible in the provider's resources policy                                       | "updates the resources policy when only the memory changes" asserts a single `setMemory(sprite, 4096)` and `specs.memoryMb`; `client.test.ts` "updates the memory limit on its own" asserts the wire call is `POST /v1/sprites/:n/policy/resources {"memory":{"limit_mb":4096}}`. Full coverage.                                                                                                                                                                                            |
| Deleting the trigger or revoking the daemon removes the sprite at the provider                      | "destroys the sprite when the trigger stops targeting one" (a daemon-target save) and `dispatch.test.ts` "destroys the sprite when its daemon is revoked". Hub still has no trigger deletion, so the nearest event is covered and real deletion is not.                                                                                                                                                                                                                                     |

Not covered by any test, and checked by hand instead:

- The `enabled: false` route into `target === undefined`. The unit test switches to a **daemon** target;
  no test disables a trigger. Scenario 5 covers it, including the reason string.
- **Retiring a sprite that has a running execution.** The guard test proves a _bootstrap_ change is
  refused, but nothing asserts what a _disable_ does while an execution runs, and that path has no guard
  at all. Findings 1 and 2.
- **`requireIdleSpriteForBootstrapChange` is only reached when `input.triggerId !== undefined`.** No test
  covers a save with no `triggerId` and a live sprite for that trigger; unreachable through
  `installTrigger`, which always resolves the id, but the store is a public class.
- The plural branch of the editor message ("N running executions") — only the singular is asserted.
- `retireSession` returning `"created"` (the same-daemon, finished-credentialed case) keeps the old
  wording; only the `"reset"` branch is asserted.
- An **unchanged** save reaching `reconcileSprite` and doing nothing: asserted only indirectly, by the
  older "does not create a second sprite while the trigger's machine is not terminated". Scenario 2
  measures it on a real sprite.
- `machine.status !== "alive"` (a `spawning` row) short-circuiting env and memory reconciliation.
- `rewriteSpriteService` returning early when `specs.npmPrefix` is undefined.

## Findings

1. **Disabling a trigger destroys the sprite out from under a running execution, and the execution then
   burns its whole idle timeout.** Scenario 5: execution `44df28b4` was `running` at 13:46:46.5; the
   `enabled: false` save at 13:46:46.3 was accepted with no guard, `sprite retired` fired at 13:46:48.3,
   and `GET /v1/sprites/<n>` was 404 about 2 s later. The execution stayed `running` for another
   **1 m 58.8 s** and ended at 13:48:45.07 as `step_idle_timeout` — the trigger's `idle_timeout: 2m` to
   the second, not a sprite-specific failure. `hub_action_completed_at` is NULL for it, so the
   `auto_archive` was lost, and the release logged `sprites.release failed  failureKind: notFound`.
   `retireSprite` revokes the daemon in the database (`database.revokeDaemon`) but does not call
   `registry.revoke`, so the live socket is never closed and nothing fails the execution; with a longer
   `idle_timeout` the run would hang until `max_runtime`. The bootstrap path has
   `requireIdleSpriteForBootstrapChange`; the disable path has no equivalent, and the PRD's "destroy
   after in-flight executions" is not honoured here either. Reported as an observation per the brief.
2. **`release` does not tolerate a destroyed sprite, only a missing task.** `taskRequest(name, …, true)`
   only forgives curl exit 22 with `returned error: 404` from the in-sprite `/v1/tasks`; the `exec` that
   carries it goes through `request()` with no `allowNotFound`, so a 404 on the sprite itself throws
   `SpritesError(404)` before the tolerance can apply (`src/daemons/sprites/client.ts:98-113, 146-148`).
   That is the `sprites.release failed  failureKind: notFound` in finding 1. It is caught and the terminal
   transition still completes, so the cost is a misleading warning; but `client.test.ts` names its case
   "treats a missing task or sprite as released or destroyed", which the code does not do for a
   destroyed sprite.
3. **One memory-only save took 21.5 s and nothing logs why.** Scenario 2's first `memory: 12288` save
   returned in 21.533 s. Three later memory saves on a warm sprite took 0.735 s, 0.364 s and 0.339 s, and
   a direct `POST /v1/sprites/<n>/policy/resources` took 0.32 s and 0.35 s, so it is not the policy call
   in steady state. The slow sample was 26 s after the last exec, when the sprite had probably paused.
   The memory branch of `reconcileSprite` logs nothing at all — unlike the env branch, which has
   `sprite service rewritten` — so a slow save on this path leaves no trace for an operator. Not
   reproduced; recorded with its numbers.
4. **The running-execution guard only covers one of the three ways `retireSprite` is reached.**
   `requireIdleSpriteForBootstrapChange` runs only when `environment.kind === "sprite"`, and inside it the
   only thing that can refuse is a changed `bootstrapHash` (`src/triggers/store.ts:54-56, 121-136`).
   `reconcileSprite` retires on `target === undefined` as well, and nothing checks for running executions
   on that branch (`src/daemons/sprites/activation.ts:237-245`). Concretely: switching a trigger to a
   **daemon** target never enters the guard at all, and `enabled: false` enters it but returns early
   because the bootstrap is unchanged — both then destroy a sprite with a live execution on it. Finding 1
   is the observed case. Same root cause, and the check belongs in `reconcileSprite`, where all three
   edits converge, rather than in one more caller-side guard.
5. **Re-enabling a disabled trigger activates immediately, not on the next arrival.** Scenario 5: the
   `enabled: true` save returned in 0.279 s and `sprite activation: destroy leftover` was logged 1 s
   later, with the sprite `alive` 36 s after the save and no run fired. This is correct per PRD section 6
   ("Trigger activated with sprite target -> create"), and it matches the create branch of
   `createSpriteActivation`, which the terminated row falls through to. Recorded because the brief
   expected recreation only on the next run, and because it means a disable/enable pair costs a full
   rebuild whether or not anything ever arrives.
6. **The `reset` path works, and it closes ac-52w findings 4 and 5.** Four recreations in this round
   (`c6f85312`, `d0a0443c`, `44df28b4`, `e7dc46ba`) all recorded `agent_session_action = reset`, all
   recorded the **new** daemon in `agent_executions.daemon_id`, and the whole Hub log contains zero
   occurrences of "Continuation settings differ from the existing agent" and zero of "Continuation agent
   was deleted". The old session's `continuation_key` is set to NULL and a new session id is derived,
   exactly as PRD 5.7 "Sprite recreated" describes. `hub_action_completed_at` is non-null on every
   execution except `44df28b4`, whose sprite was destroyed mid-run (finding 1).
7. **Retiring is fast and the reconcile branches are cleanly separated.** Measured save latencies:
   unchanged 0.339-0.594 s; env-only 6.130 s (the delete-then-put restarts the daemon, offline 4.30 s);
   memory-only 0.339-0.735 s warm; bootstrap-change retire 1.799-1.879 s; disable retire 1.676-1.783 s;
   activation 0.279-0.544 s (the build itself is a background job, 33-38 s to `alive`). An unchanged
   save makes no provider call at all, an env change makes exactly one `service` write and does not touch
   memory, and a memory change does not restart the daemon (pid 827 before and after). `specs.envHash` is
   written at creation and carried across recreation.
8. **The daemon slug is still `trigger-<triggerId>-<daemonId[0:8]>` after the first daemon.** The Daemons
   page listed five rows, only the first named `trigger-<triggerId>`. ac-vni finding 4 and ac-52w
   finding 13, unchanged and out of scope here (ac-79p.1).
9. **The Daemons page shows nothing sprite-specific.** No owning trigger as a `TwoLine` secondary, no
   machine-status `StatusPill`, and Rename is offered on a sprite daemon. That is ac-7vf's scope; noted
   because scenario 6 had to use that page and a revoked sprite daemon is indistinguishable from any
   other revoked daemon there.
10. **ac-vni finding 2 did not reproduce.** Hub exited 3 s after SIGTERM. No daemon was connected at the
    time, so the hang that needed a SIGKILL was not exercised, same as ac-52w.
