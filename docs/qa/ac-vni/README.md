# ac-vni: verification of PR #8 (activate a sprite when its trigger is saved)

Heads verified: `d02dd05` for scenarios 1 to 5 and 8's harness tests; `de489e1` (destroy-on-failure) for
scenarios 1, 2, 7, and 8, with 1 and 2 re-run. The PR head is now `00c0046`, a merge of `main` into
`de489e1` that touches only docs; CI is green on it.

Postgres for the scripts:
`docker run -d --rm --name qa-acvni-pg -e POSTGRES_PASSWORD=qa -e POSTGRES_USER=qa -e POSTGRES_DB=qa -p 55437:5432 postgres:17-alpine`
(override with `QA_PG`). Real sprite runs: `npm run build`, `cloudflared tunnel --url http://localhost:3000`, then
`node dist/index.js` with `DATABASE_URL`, `PASEO_HUB_APP_URL=<tunnel>`, `PASEO_HUB_AUTH_SECRET`, and the three
`PASEO_BOOTSTRAP_*` variables. The org was seeded with `s4-seed-hub.ts`, which sets the `canUseSpriteTargets`
override (Unlimited does not include it), stores a temporary Sprites token, and mints a `configuration:install` key.
Triggers were saved through `POST /api/v1/triggers/install` over the tunnel.

| #   | Scenario                                                                                                  | Command                                                                                                                                 | Result                  | Evidence                                                                              |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| 1   | Call sequence with a recording provider: happy path, bootstrap exit 3, leased template, second activation | `npx tsx docs/qa/ac-vni/s1-call-sequence.ts`                                                                                            | pass                    | `s1-call-sequence.log` (de489e1), `s1-call-sequence.head-d02dd05.log`, `pg-common.ts` |
| 2   | Editor messages at `run.target.kind`, previous revision untouched                                         | `npx tsx docs/qa/ac-vni/s2-editor-messages.ts`                                                                                          | pass                    | `s2-editor-messages.log`                                                              |
| 3   | Enrollment binding: sprite key binds and revokes; unrelated key gets a fresh machine                      | `npx vitest run src/daemons/daemons.test.ts -t "sprite's key\|unrelated key"`; `npx tsx docs/qa/ac-vni/s3-enrollment-binding.ts`        | pass                    | `s3-enrollment-binding.log`                                                           |
| 4   | Real activation on a real sprite, then an unchanged re-save                                               | `s4-seed-hub.ts`, install `s4-trigger.yml`, `s4-watch.sh`                                                                               | pass                    | `s4-real-activation.log`                                                              |
| 5   | Idle after activation                                                                                     | `GET /v1/sprites/<n>` and `daemons.presence` every 10 s                                                                                 | observed, see finding 1 | `s5-idle.log`                                                                         |
| 6   | Cleanup and secret grep                                                                                   | `sprite api … -X DELETE`, `DELETE /v1/tokens/<id>`, `grep -rF`                                                                          | pass                    | `s6-cleanup.log`                                                                      |
| 7   | Failure path on a real sprite (at de489e1), then a fixed bootstrap                                        | install `s7-trigger-bad.yml`, then `s7-trigger-fixed.yml`                                                                               | pass                    | `s7-failure-path.log`                                                                 |
| 8   | Gates                                                                                                     | `npm run format:check`, `npm run typecheck`, `npm run lint`, `npx vitest run src/daemons src/triggers src/db`, `gh pr checks 8 --watch` | pass                    | `s8-gates.log`                                                                        |

What each scenario showed:

1. Uses real `OrganizationApiKeys` on Postgres. At `de489e1` the calls run in this order: `destroy(trigger-<id>)`, then
   `create {name, memoryMb: 16384}`, then exec `sh -c "npm prefix -g"` with no options. Next come exec
   `npm install -g @getpaseo/cli` and exec `sh -s` with the bootstrap on stdin; both get `PATH=<prefix>/bin:/usr/local/sbin:…`.
   Then the service `paseo`: `cmd <prefix>/bin/paseo`, args `start --foreground --listen 127.0.0.1:6767 --no-relay --no-web-ui`,
   `dir /home/sprite`, and env `HOME, PASEO_HOME, PATH`, a 43-character `PASEO_PASSWORD`, `LITERAL: plain`, and the resolved template.
   Last is the exec of the connect script with `https://hub.qa.test` and a `paseo_pk_` key. The machine is
   `spawning`, its specs are `{bootstrapHash, memoryMb, npmPrefix}`, and the key is scoped `daemons:enroll`.
   With bootstrap exit 3 the calls are `destroy, create, exec, exec, exec, destroy`, the row is `terminated`
   with `bootstrap exited with 3: partial\nbad`, and the key is revoked. A `${{ paseo.connections.github.token }}`
   template, using a resolver that calls `registerToken` the way the GitHub resolver does, ends the row `terminated`
   with `env.GITHUB_TOKEN cannot be resolved without an execution lease` and revokes the key. Two more saves (one
   unchanged, one with an edited prompt) make 0 provider calls and leave 1 row and 1 key.
2. With no Sprites configuration: `run.target.kind: Sprites are not configured for this organization.` With
   `spriteActivation` null: `run.target.kind: Sprite targets are unavailable on this Hub: no public base URL or API keys configured.`
   In both cases the disabled v1 keeps its `activeRevisionId` and YAML, a new enabled trigger is refused too, and nothing
   reaches the provider or the machines table.
3. Both harness tests pass. The Postgres script also shows that an unrelated key's enrollment creates a
   `daemon`-kind `alive` machine and leaves the sprite row `spawning`. The sprite key's enrollment binds
   `daemons.machine_id` to the sprite row, turns it `alive`, revokes the key, and expires the key's second,
   unconsumed token.
4. Save at 09:12:32Z. The row was `spawning` without `npmPrefix` at 09:12:33, had `npmPrefix` at 09:12:37,
   and was `alive` by 09:13:00 (the enrollment token was consumed at 09:12:59.3). **Save to alive: about 27 s**
   (create 1.3 s, npm prefix 1.8 s, paseo install 14.5 s, bootstrap 0.3 s, service 5.4 s, hub connect 3.7 s).
   `sprite list` shows `trigger-f44f3290-…`. The memory policy reads `limit_mb: 8192` (the org default, since the
   trigger omits `memory`). The `paseo` service is `running` with `HOME`, `PASEO_HOME`, `PATH`, `PASEO_PASSWORD`, and
   `QA_LITERAL`, and the same env is in `/proc/<pid>/environ`. The daemon listens on 127.0.0.1:6767, and the
   workspace has the `init` commit. The Hub Daemons page lists `trigger-f44f3290-…` as Connected with
   "Hub automations". `daemons.scopes` is `["hub.execute"]`, `machine_id` is the pre-created row, and
   `registered_by_api_key_id` is the sprite key, which was revoked at 09:12:59.299. The Hub log has every step in
   order. Re-saving the YAML unchanged returns version 2 but starts no activation: there is still 1 machine, 1 key,
   and 1 sprite.
5. See finding 1. The sprite status went `warm` with `last_warming_at` 09:13:50Z, about 50 s after it went alive. Hub
   still showed the daemon connected at 09:14:58, then marked it offline at 09:15:04.8. An exec at 09:17:15 woke the
   sprite, and the daemon reconnected at 09:17:17.
6. Both sprites were deleted (204, then 404), and `sprite list` is empty. The temporary token was deleted (204),
   and the old token now gets 401. Hub and cloudflared were stopped by PID. The secret grep found 0 files for the
   Sprites token, the tunnel hostname, `PASEO_PASSWORD`, the owner passwords, and the public API key.
7. At `de489e1` the bad save ended `terminated` with `bootstrap exited with 3: bad` and the key revoked 20 s after
   the save. `GET /v1/sprites/trigger-5742bdb0-…` returns `sprite not found`, and `sprite list` no longer has it.
   Saving the fixed bootstrap on the same trigger created a new row `d5c67cde-…` and a new sprite with the same name,
   `alive` in 28 s, with a new key that was revoked on enrollment.
8. Format, typecheck, and lint are clean. Vitest on `src/daemons src/triggers src/db`: 67 files passed, 2 skipped
   (the real Discord and real Sprites tests), 612 tests passed. `gh pr checks 8 --watch`: all 9 checks pass on
   `00c0046`. No flaky runs.

## Findings

1. **The daemon's Hub socket does not stay open while the sprite is paused.** This goes against the expected
   PRD 5.5 false positive. The sprite paused at 09:13:50Z, and Hub marked the daemon offline at 09:15:04.8Z
   (`daemons.disconnected_at`). Nothing in the Hub log records the close. Waking the sprite brought the socket back
   in 2 s. The cause is not isolated: the cloudflared quick tunnel or edge could be closing an idle WebSocket, or a
   daemon or Hub keepalive could be failing while the sprite is frozen. Spike 5 saw the socket still connected, so
   dispatch through a paused sprite may hit either an offline daemon or a false "connected", depending on timing and
   network path. The 5.5 hold-first design has to handle both.
2. **SIGTERM did not stop Hub while a sprite daemon was connected.** The first Hub (pid 77118) was still running
   65 s after SIGTERM and had to be SIGKILLed. Its listener was already closed, because a new Hub bound port 3000 in
   the meantime. The second Hub, with no daemon connected, exited within 5 s. The cause was not isolated, and the
   shutdown path is not in this PR's diff, so this is probably older than the PR. It is noted because activation now
   creates daemons that sit on long idle sockets.
3. **Nothing logs the destroy after a failure.** Only `sprite activation: destroy leftover` (before create) is logged.
   The best-effort destroy after `sprite activation failed` leaves no line when it succeeds, so the only proof it ran
   is the provider's 404.
4. **The daemon slug is the sprite hostname, `trigger-<id>`, not the trigger name.** PRD 5.3 says "Hub renames the
   slug to the trigger name after enrollment". This PR does not do that; it may be planned for later.
5. **An unchanged re-save creates a new revision** (version 2, identical YAML). Activation correctly does nothing.
   The versioning is existing store behaviour, noted only because the scenario expected no change.
6. Scope notes. Scenario 1's leased-template case uses a stub resolver that calls `registerToken` the way
   `src/providers/github/index.ts` does, because the real resolver needs a GitHub App installation. The org needed an
   entitlement override, because `UNLIMITED_TEMPLATE.canUseSpriteTargets` is false (see ac-64s finding 5). The
   dashboard forced a password change and app setup before the Daemons page would load.
