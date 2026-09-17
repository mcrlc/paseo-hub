# ac-7rt: verification of PR #15 (refresh holds on a tick and recover them on restart)

Head verified: `a35fe78` — after `git fetch origin`, `git rev-parse --short HEAD` equals
`git rev-parse --short origin/sprite-targets/hold-refresh-recovery`. No product code was changed;
the only files added are under `docs/qa/ac-7rt/`. All times are UTC on 2026-09-17. Hub logs in local
time (+0300) and every Hub log timestamp quoted in the evidence is re-stamped to UTC.

## Recipe delta from ac-52w

The round-1 recipe in `docs/qa/ac-52w/README.md` was reused, with these differences:

1. **Postgres `qa-ac7rt-pg` on port 55471** (ac-52w used `qa-ac52w-pg` on 55452), so the two QA runs
   cannot collide. `docker ps` was checked for leftovers first; the only other `qa-` container,
   `qa-ac50k-pg`, belongs to a different bead's session and was left alone.
2. **`docs/qa/ac-52w/seed-hub.ts` was reused verbatim**, with `QA_PG` pointed at 55471. It stores the
   temporary Sprites org token on the organization and mints a
   `configuration:install, projects:read, runs:dispatch` key, with no entitlement override
   (`effective.canUseSpriteTargets: true`).
3. **`hub-start.sh` replaces the ad-hoc `node dist/index.js` line.** Three of the six scenarios restart
   Hub, so the start has to be byte-identical every time. It reads every secret from `$QA_DIR`
   (chmod 600), never puts one on a command line, and appends a `=== hub start <utc> ===` marker to
   the Hub log so each process's lines can be separated.
4. **The public API is called on `http://localhost:3000`, not through the tunnel.** The cloudflared
   quick tunnel is only needed for the sprite's daemon to reach Hub (`PASEO_HUB_APP_URL`). This keeps
   the tunnel hostname out of every script and every evidence file.
5. **`POST /api/v1/triggers/install` takes `{"yaml": "..."}`**, not ac-52w's
   `{"projectSlug", "configuration"}`, which answers 400 `Unrecognized keys`.
6. **New helpers**: `task-poll.sh` takes an interval argument (5 s, 10 s, 15 s and 30 s were used for
   different scenarios) and does not stop on an empty list, because these scenarios need samples
   before, during and after a gap; `del-task.sh` deletes one in-sprite task through the same
   `DELETE /v1/tasks/:name` path `client.ts` release uses; `race-alive.sh` drives scenario 5.
   `db-poll.sh` is `ac-52w/r2-db-poll.sh` with the machines table added and `order by started_at`
   (the `machines` table has no `created_at`).

Two triggers, so two sprites: `qa-ac7rt-sprite` (`trigger.yml`, machine `7e9f4acc`, sprite
`trigger-43cde572-…`) carries scenarios 2, 3 and 3b; `qa-ac7rt-sprite-b` (`trigger-b.yml`, sprite
`trigger-3315590f-…`) carries scenarios 4 and 5, so restarting Hub mid-bootstrap never touches the
first sprite. The continuation key is rotated per scenario so every run gets a fresh agent; only the
key and the timeouts change between revisions, never the bootstrap, so no revision recreated a sprite.
As in ac-52w the environment has no Claude credential, so every run that reaches an agent ends
`step_idle_timeout`, which is the intended terminal here. No real Claude credential was read or used.

**The refresh tick is anchored to `recoverSprites()` at Hub start, not to each hold.** Hub A started
13:18:42Z, so its ticks fell at 13:23:42, 13:28:42, …; Hub B started 13:35:32Z, so its ticks fell at
13:40:32, 13:45:32, …. Scenarios 2 and 3b were fired deliberately just after a tick so exactly one
tick lands inside the execution and the measurement is unambiguous.

## Results

| #   | Scenario                               | Command                                                                                                                | Result                                | Evidence                       |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| 1   | Harness regression                     | `npx vitest run src/daemons src/workflows`, twice, plus `src/daemons/registry.test.ts` alone                           | pass 282/282; gaps in finding 1       | `s1-harness.log`               |
| 2   | Tick refresh on a real sprite          | `run.sh qa-ac7rt-sprite qa-7rt-s2-run1` with `task-poll.sh … 30`, `db-poll.sh`, `sprite-poll.sh`                       | pass, refresh at +292 s               | `s2-tick-refresh.log`          |
| 3   | Restart mid-execution                  | `kill -9` the Hub pid mid-run, wait 10 s, `hub-start.sh`; same three pollers at 5 s                                    | pass, re-hold 1.4 s after start       | `s3-restart-mid-execution.log` |
| 3b  | Missing hold task recreated (404 AC)   | `del-task.sh <sprite> <execution>` mid-run, then wait out one tick                                                     | pass, recreated on the tick           | `s3b-missing-task.log`         |
| 4   | Restart mid-bootstrap, then recreation | `install.sh trigger-b.yml`, `kill -9` while `spawning`, `hub-start.sh`, then `run.sh qa-ac7rt-sprite-b qa-7rt-s4-run1` | pass, row + key + sprite all resolved | `s4-restart-mid-bootstrap.log` |
| 5   | Reconcile a spawning row to alive      | `race-alive.sh 1`, `2`, `3`                                                                                            | not reachable; see finding 3          | `s5-reconcile-alive.log`       |
| 6   | Cleanup and secret grep                | `DELETE /v1/sprites/<n>` x2, `DELETE /v1/tokens/<id>`, kill by pid, `docker rm -f`, `grep -rF`                         | pass, 0 secret matches                | `s6-cleanup.log`               |

### Measured timings

| What                                                    | Measured                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| Tick period (three independent observations)            | exactly 300 s: 13:35:32, 13:40:32, 13:45:32                 |
| Hold → first refresh (scenario 2)                       | **292 s** (hold 13:23:50Z, refresh 13:28:42Z), exactly one  |
| Sprite state for the whole 7 m execution                | `running` 13:23:51 → 13:30:55, never paused mid-turn        |
| Restart mid-execution: kill → Hub answering             | 13.4 s (kill 13:35:19.4, 200 at 13:35:32.9)                 |
| Restart mid-execution: **process start → re-hold**      | **about 1.4 s** (start 13:35:30.6, hold stamp 13:35:32Z)    |
| Stale-hold exposure across that restart                 | 13 s, against a 3600 s expiry                               |
| Re-hold vs daemon reconnect                             | re-hold 13:35:32, daemon reconnect 13:35:36.2 — hold first  |
| Idle deadline after restart                             | recovered, not restarted: terminal at started_at + 4 m 02 s |
| Restart mid-bootstrap: **process start → row resolved** | **1.32 s** (start 13:48:46.14, terminated_at 13:48:47.458)  |
| …key revoked / sprite 404                               | 13:48:47.461 (+3 ms) / confirmed by 13:48:58.0              |
| Recreation on the next run                              | 29.1 s `spawning` → `alive` (13:49:12.5 → 13:49:41.5)       |
| Missing task absent before the tick recreated it        | 4 m 40 s, 28 consecutive empty samples                      |
| `operation: "sprites.hold-refresh"` failures            | **0** across the whole run                                  |
| `sprites.recover` / `sprites.hold` failures             | 0 / 0                                                       |

### What scenario 1 showed

Two full runs of `npx vitest run src/daemons src/workflows` on `a35fe78`. The first (16:02:21 local)
gave 281 passed / 1 failed — `registry.test.ts > negotiates the standard session only when
offered=true`, `false !== true` at `registry.test.ts:94`, which is the known load flake **ac-shh.19**.
The second run of the same command gave **282 passed, 0 failed, 1 skipped (283)**, and the file alone
passes 16/16. So the flake did not reproduce and no new bead was filed. This matches the PR's claim.

The five new `dispatch.test.ts` cases and the one Postgres case, and what each actually asserts:

1. _refreshes a running execution's hold on every tick and stops once it is terminal_ — with a 5 ms
   tick, after `recoverSprites()` the hold count for the execution climbs past 3; after the agent
   finishes and the completion callback lands, the count stops moving. Asserts that the tick refreshes
   repeatedly and that a terminal execution stops being refreshed. It never asserts the `"60m"` expiry
   argument, although the stub records it.
2. _reports a failed refresh and refreshes again on the next tick_ — with `holdFails`, a
   `sprites.hold-refresh` record appears; clearing the flag, the hold count climbs again and the
   machine row is still `alive`. This is the test that pins the PR's deliberate asymmetry: a refresh
   failure is reported and does not terminate the machine, unlike the dispatch path.
3. _re-holds an active execution on restart and leaves the next dispatch alone_ — one hold from the
   claim, then `restart()` (stop plus a fresh lifecycle over the same memory database) and
   `recoverSprites()` gives exactly two, and a following `prepareSpriteDispatch` answers `ready`
   without a third. This is the bead comment's requirement that recovery re-derive holds from
   execution rows and rebuild `heldSpriteExecutions` rather than depend on the in-memory set.
4. _marks a spawning sprite alive on restart when its daemon enrolled_ — enrolls, then explicitly puts
   the row back to `spawning`, restarts, and expects `alive` with nothing revoked or destroyed. See
   finding 3: the state is constructed by hand because production cannot produce it.
5. _terminates a spawning sprite on restart when no daemon enrolled_ — row `terminated` with
   `hub restarted during activation`, the enrollment key in `revokedApiKeys`, the sprite in
   `destroyed`. Scenario 4 reproduces all three on a real sprite.
6. `daemons.test.ts > terminates a sprite machine still spawning when the hub restarts` — the only
   test of the wiring (`HubRuntime.start()` → `recoverSprites()`) and the only one on Postgres. It
   asserts the row transition and reason only; as the PR says, `spriteProvider` and `spriteApiKeys`
   are not wired into `HubHarness`, so revocation and destroy are covered over the memory database.

## Findings

1. **The bead's "a 404 on refresh results in a new hold" has no test; it is proved here on a real
   sprite instead.** The stub `hold()` in `dispatch.test.ts` counts calls and can be made to throw,
   but nothing models a task that is missing at the provider, so the criterion rests entirely on the
   PR's argument that `PUT /v1/tasks/:name` creates a missing task. Scenario 3b measures it: the hold
   task for execution `a12a214a` was deleted at 13:40:52 through the same `DELETE /v1/tasks/:name`
   path release uses, stayed absent across 28 consecutive samples over 4 m 40 s, and the 13:45:32 tick
   recreated it with a fresh 60 m expiry and reported no failure. The criterion holds. Three smaller
   test gaps sit beside it: the `"60m"` expiry is never asserted on the refresh path; the two skip
   guards in `refreshSpriteHolds` (no `machineId` on the launch intent, and a machine row that is not
   `alive`) are untested; and nothing asserts that `stop()` clears the tick — the `this.stopping`
   guard inside the callback would keep every existing test green if `clearSpriteHoldRefresh` were
   dropped.

2. **The 30-minute age test in the spec is gone from the code, and the spec still says otherwise.**
   `docs/sprite-targets.md` 5.8 says the tick "re-issues the same `PUT` for every hold whose execution
   is still `spawning` or `running` and is older than 30 minutes", and the section 6 table row reads
   "Execution older than 30 min | tick refreshes the hold". `refreshSpriteHolds` refreshes every
   pending execution on every pass. The PR argues the change deliberately and convincingly — the `PUT`
   is idempotent, the sprite is awake anyway, and an age test adds a clock comparison for nothing —
   and the measurements support it: the whole tick is one `findPendingAgentExecutions` query when
   nothing is running, and the refresh cost is one exec on an already-running sprite. The finding is
   only that the spec document was not updated to match, so 5.8 and section 6 now describe behaviour
   the branch does not implement. Out of my scope to edit.

3. **The reconcile-to-`alive` branch is not reachable through the real enrollment path.**
   `src/db/pg.ts:1599 enrollDaemon` runs its whole body inside one `this.pool.transaction`, and within
   that transaction it sets `update machines set status = 'alive'` (line 1635) and then
   `insert into daemons` (line 1660). A row that is `spawning` _and_ has a daemon bound is therefore
   never visible to another connection. Three attempts to race it (`race-alive.sh`, poll interval
   measured at 34.4 ms) all found the row already `alive` with its daemon. The branch at
   `lifecycle.ts:1010-1012` is a cheap and correct guard, and reconciling to `alive` is the right
   answer if the state ever appears, but it is defensive code rather than a path the system produces,
   and both tests that cover it build the state by hand with an explicit
   `transitionMachine(machineId, "spawning")` after enrolling. The bead text ("marking it alive when an
   enrolled daemon exists") reads as though this were a real restart outcome. The branch that does
   fire in production is the terminate one, and scenario 4 proves it end to end.

4. **`findSpawningSpriteMachines()` is unscoped, so a restart reconciles every organization's
   in-flight bootstraps, including another Hub instance's.** The query is
   `select * from machines where status = 'spawning' and source->>'kind' = 'sprite'` — no organization
   predicate and no instance predicate. For a single-instance Hub this is correct and is what makes
   scenario 4 work. But two Hub instances sharing one database is not prevented anywhere, and a
   restart of instance A would terminate instance B's `spawning` rows, revoke their enrollment keys and
   destroy their sprites mid-bootstrap — the recovery is unconditional, not a lease or a claim.
   `docs/sprite-targets.md` section 7 lists the ceilings and does not name this one. Code read, not
   reproduced; recording it because restart recovery is exactly where a second instance bites.

5. **The tick arms last, after two unguarded database scans.** `recoverSprites()` is
   `reconcileSpawningSprites()` then `refreshSpriteHolds()` then `scheduleSpriteHoldRefresh()`. Both
   scans wrap their per-row work in `try`/`catch`, but the `findSpawningSpriteMachines()` and
   `findPendingAgentExecutions()` calls that drive the loops sit outside those `try` blocks, so a
   database error on either rejects `recoverSprites()` and the tick is never armed. In practice this
   is benign: `recoverSprites()` runs inside the `Promise.all` at `src/app.ts:249-253`, so the same
   rejection fails `HubRuntime.start()` and there is no Hub to have a tick. Worth knowing only because
   the three statements are ordered so that the durable, self-healing part depends on the two
   best-effort scans completing.

6. **The release-after-hub-action ordering from ac-52w r2 holds, and scenario 4 stresses it far harder
   than round 2 did.** On the freshly recreated sprite the `auto_archive` hub action took **9.67 s**
   (terminal 13:52:44.580, `hub_action_completed_at` 13:52:54.250) against the 439–534 ms r2 measured,
   and `sprite release` still came after it, at 13:52:54.604. The in-sprite task list still held the
   hold at 13:52:42.450 and was empty at 13:52:57.858. Scenarios 2 and 3 show the same ordering with
   sub-second archives (+494 ms and +592 ms). Nothing in this PR changes that path; it is recorded
   because a 9.7 s hub action is the case that would have failed under the pre-`3296637` ordering.

7. **The daemon socket recycled about every 2 m 06 s throughout, which is the cloudflared quick
   tunnel, not Hub.** During scenario 2 `daemons.connected_at` moved at 13:23:50.9, 13:25:59.5,
   13:28:05.8 and 13:30:12.1, each after a roughly 1 s gap. The period is nothing like the 300 s tick
   and the sprite stayed `running` throughout, so no run was affected. Flagged so the presence churn
   in `s2-tick-refresh.log` is not misread as hold or tick behaviour. The same tunnel is why scenario 3
   quotes the post-restart reconnect (4.1 s) from the daemon row rather than treating it as a bound.

8. **Reusing a continuation key across a sprite recreation still fails the run, on this branch.**
   The scenario 5 attempt fired at 13:53:32 against a recreated sprite, with continuation key
   `qa-ac7rt-s4` unchanged, failed immediately with `Agent not found: 465ee942-…`. This is ac-52w
   finding 4 and PRD 5.7's "sprite recreated → Hub clears `continuationKey` on every session bound to
   the old daemon", which is ac-50k and explicitly out of this PR's scope. Recorded because restart
   recovery now destroys and recreates sprites on a path that did not exist before, so ac-50k is
   reachable from one more direction: a Hub restart mid-bootstrap leaves the next run on a new daemon
   with the old session still pointing at the dead one. Rotating the key made the runs pass.

9. **Successful refreshes are invisible in the Hub log, by design, so every refresh claim here rests
   on the in-sprite task timestamps.** `prepareSpriteDispatch` logs `sprite hold` and the release path
   logs `sprite release`, but `refreshSpriteHolds` logs only failures. Every refresh in this
   verification was read from `started_at`/`expires_at` in `sprite-env curl /v1/tasks`. That works and
   is precise to the second, but it needs an exec, and an exec wakes a paused sprite — which is why
   scenario 3b can prove the recreation of a deleted task but explicitly cannot prove that the sprite
   would not have paused during those 4 m 40 s. A debug-level line on a successful refresh would make
   the tick observable without perturbing the thing being observed.
