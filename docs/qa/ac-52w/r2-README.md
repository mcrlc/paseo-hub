# ac-52w r2: re-verification of PR #11 after `3296637`

Head verified: `3296637` (`git fetch origin`, then `git rev-parse --short HEAD` = `git rev-parse --short
origin/sprite-targets/hold-before-dispatch`). No product code was changed in this round. All times are UTC on
2026-09-17.

This round checks round 1's finding 1 only: the hold used to be released in `notifyExecutionTerminal` before the
`auto_archive` hub action was sent, the sprite paused about 1 s later, and the archive timed out 30 s after terminal.
`3296637` moves the release into a `finally` around the control attempt in `sendPendingHubAction` and adds
`sprite hold` / `sprite release` info lines.

## Recipe delta from round 1

The round 1 recipe in `README.md` was reused as written, with four differences, none of them behavioural:

1. **No `/api/v1/health` route exists.** Round 1's readiness probe is not reproducible. Hub readiness was taken from
   `server started` in the Hub log and a `200` on `/`.
2. **`sprite api /v1/tokens -- -X POST -d '{"description":"qa-ac-52w-r2"}'` ignores the description** and returns no
   `id`. The response is `{"description":"API token","token":...}`. The token id
   (`f9acab7f68a1b8729af20f26e5499cd6`) was read from `GET /v1/tokens` for the revoke step.
3. **`trigger.yml` was installed unchanged**, continuation key `qa-ac52w-v5` and all. Round 1 rotated the key per
   scenario to force a fresh agent; a fresh Postgres already gives that, so no rotation was needed.
4. **New pollers** (`r2-db-poll.sh`, `r2-sprite-poll.sh`, `r2-task-poll.sh`) replace `watch.sh` / `fastwatch.sh` /
   `tasks.sh` for this round, because the ordering under test is sub-second and round 1's helpers print whole seconds.
   They poll the same things by the same paths; `r2-task-poll.sh` is `tasks.sh` on a 1 s loop with a stop condition.

Everything else is round 1: Postgres `qa-ac52w-pg` on 55452, `npm run build`, a cloudflared quick tunnel,
`node dist/index.js` with the bootstrap organization, `seed-hub.ts` with no entitlement override
(`effective.canUseSpriteTargets: true`), trigger install over the public API, and `run.sh` to fire manual runs.
As in round 1 the environment has no Claude credential, so every run ends `step_idle_timeout` after 2 minutes, which
is a valid terminal state. No real Claude credential was read or used.

Sprite `trigger-4912952f-bf10-4de8-bffb-0a186bcee3c4`, machine `e05184ae`, daemon connected 12:07:14.399.

## Results

| #   | Scenario                                                                     | Command                                                                                                 | Result | Evidence                                 |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| 1   | Archive completes at terminal, then release, then pause (daemon socket open) | `run.sh qa-r2-run-1`, `run.sh qa-r2-run-2` with `r2-db-poll.sh`, `r2-sprite-poll.sh`, `r2-task-poll.sh` | pass   | `r2-s1-awake-archive-release-pause.log`  |
| 2   | Same from a paused sprite, daemon already offline                            | wait for `daemons.presence = offline`, `run.sh qa-r2-run-3`, same three pollers                         | pass   | `r2-s2-paused-archive-release-pause.log` |
| 3   | Cleanup and secret grep                                                      | `DELETE /v1/sprites/<n>`, `DELETE /v1/tokens/<id>`, kill by PID, `docker rm -f`, `grep -rF`             | pass   | `r2-s3-cleanup.log`                      |

### Measured intervals

| Run              | Execution  | Terminal     | Archive done | Δ       | `sprite release` | Δ       | Pause     | Δ      |
| ---------------- | ---------- | ------------ | ------------ | ------- | ---------------- | ------- | --------- | ------ |
| qa-r2-run-1      | `b4fb15da` | 12:10:13.515 | 12:10:13.988 | +473 ms | 12:10:14.244     | +256 ms | 12:10:14Z | <1.4 s |
| qa-r2-run-2 (s1) | `a999f849` | 12:13:05.462 | 12:13:05.901 | +439 ms | 12:13:06.202     | +301 ms | 12:13:06Z | ~0.6 s |
| qa-r2-run-3 (s2) | `80f85980` | 12:17:28.023 | 12:17:28.557 | +534 ms | 12:17:28.801     | +244 ms | 12:17:28Z | ~0.9 s |

Terminal → archive complete: **439–534 ms**. Archive complete → release: **244–301 ms**. Terminal → release:
**729–778 ms**. Release → pause: **about 0.6–1.4 s**, unchanged from round 1's finding 2.

Scenario 2's dispatch from the offline daemon: hold 12:15:25.015, daemon reconnect 12:15:25.782 (**767 ms**),
handoff 12:15:25.804 (**789 ms**). Pause → Hub-offline was **124.7 s** (pause 12:13:06Z, `disconnected_at`
12:15:10.908).

## Findings

1. **Round 1's finding 1 is fixed.** `hub_action_completed_at` is set before the `sprite release` line in all three
   runs, by 244–301 ms, and the whole Hub log contains zero `daemon.execution.hub-action failed` lines (round 1 had
   one per affected run, 30 s after terminal). All three executions carry a non-null `hub_action_completed_at`
   within 534 ms of terminal; in round 1 the archive completed only on the next wake, 46 ms before the next handoff
   in one case and 17 minutes later in the other. The ordering terminal → archive → release → pause holds in both
   the socket-open and the daemon-offline case.
2. **The hold demonstrably outlives the archive.** Scenario 2 has a direct sample: the in-sprite task list still
   contained task `80f85980` at 12:17:28.756, which is after `hub_action_completed_at` (12:17:28.557) and before the
   `sprite release` line (12:17:28.801); the next sample, 12:17:30.106, is empty. Scenario 1 shows the same shape but
   only brackets it — its samples are 1.35 s apart and land at 12:13:05.791 (present) and 12:13:07.124 (absent),
   which straddles both the archive and the release. The task-list poll is an exec, and an exec wakes a paused
   sprite, so the sampling rate could not be pushed higher without perturbing the pause being measured.
3. **Both `sprite hold` and `sprite release` log lines are present for all three runs**, each carrying
   `executionId`, `sprite`, and `task`, with `task` equal to `executionId`. This closes round 1's finding 6 for the
   hold and the release; a successful handoff is still not logged by Hub and was read from `agent_executions`.
4. **Round 1's finding 2 is unchanged and was not in scope.** The sprite still pauses 0.6–1.4 s after the last
   release, not the ~30 s PRD 5.8 describes. The fix works _because_ it no longer depends on that window, but the
   window itself is still short. A hub action slower than about half a second still races the pause once the hold is
   gone — the release now waits for the control attempt to finish or time out, so this is bounded, but any work Hub
   does on the sprite _after_ `sendPendingHubAction` returns has no hold protecting it.
5. **`sendPendingHubAction` has two early returns that skip the release**, both before the `try`: `action === null
|| daemonId === null`, and the `hubActionCompletedAt !== null || this.stopping` guard above it. An execution with
   a non-null `hubAction` but a null `daemonId` is therefore held until the 60 m expiry, since
   `notifyExecutionTerminal` only releases when `hubAction === null`. Not reachable in these scenarios (every
   execution that gets a hold also gets a `daemonId` at handoff) and the commit message calls the `stopping` case out
   as ac-7rt, but the `daemonId === null` case is not named anywhere. Code read, not reproduced.
6. **"Awake" is not a state a sprite rests in.** Because the pause follows the release by about a second, there is no
   steady awake-and-idle sprite to fire scenario 1 into: a `GET /v1/sprites/:name` immediately before each fire
   returned `warm` both times, and the sprite went `running` only when the hold landed (12:11:03.9 and 12:15:26.5).
   Scenario 1 is therefore "daemon socket still open" and scenario 2 is "daemon already offline"; that is the real
   distinction the two cases test, and both pass. Round 1's s3/s5 have the same property.
7. **Pause → Hub-offline was 124.7 s**, consistent with round 1's finding 3 spread (5 / 110 / 120 / 125 s).
   Scenario 2 got the socket-closed case.
8. Cleanup is clean: sprite `DELETE` 204 then `GET` 404 and absent from the list, token `DELETE` 204 then 401 on
   `https://api.sprites.dev/v1/sprites` and absent from `GET /v1/tokens`, Hub and cloudflared both gone after
   SIGTERM, no listener on 3000, container removed. `grep -rF` of the new evidence files for the Sprites token, the
   tunnel hostname, the owner password, the auth secret, the public API key, and `PASEO_PASSWORD` found 0 matches.
