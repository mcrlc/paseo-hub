# ac-wri: verification of PR #12 (merge the organization env into every sprite's daemon and bootstrap)

PR: https://github.com/mcrlc/paseo-hub/pull/12. Head verified: `024c0a0`, equal to
`origin/sprite-targets/org-env-activation` at the start. No product code was changed.

## Hub recipe

- Postgres: `docker run -d --rm --name qa-acwri-pg -e POSTGRES_PASSWORD=qa -e POSTGRES_USER=qa -e POSTGRES_DB=hub -p 55438:5432 postgres:17-alpine`
- `npm run build`, then `cloudflared tunnel --url http://localhost:3001`
- `DATABASE_URL=postgres://qa:qa@127.0.0.1:55438/hub PORT=3001 PASEO_HUB_APP_URL=<tunnel> PASEO_HUB_AUTH_SECRET=<random> PASEO_BOOTSTRAP_ORGANIZATION=QA-acwri PASEO_BOOTSTRAP_OWNER_EMAIL=owner@acwri.test PASEO_BOOTSTRAP_OWNER_PASSWORD=<random> node dist/index.js`
- Owner session: `POST <tunnel>/api/auth/sign-in/email` with `origin: <tunnel>` (a `localhost:3001` origin is refused
  with `INVALID_ORIGIN`). The cookie jar was saved as a `{cookies:[…]}` state file, and `must_change_password` was
  cleared in the database.
- Settings server functions: `docs/qa/ac-av6/wire.sh` unchanged (`save`, `setenv`, `rmenv`). This build has the same
  function ids.
- The token was saved with `saveSpritesSettings`. It was a temporary org token from `sprite api /v1/tokens -X POST`,
  stored in a chmod 600 file under a private `mktemp -d` directory. `seed.ts` sets the `canUseSpriteTargets` override
  and mints a `configuration:install` key. Triggers were installed with `install.sh` (`POST /api/v1/triggers/install`).
  `watch.sh` samples the machine and daemon rows, and `sprite-state.sh` reads the `paseo` service and
  `/proc/<pid>/environ`. `PASEO_PASSWORD` is printed only as its length and an 8-character sha256 prefix, and the
  marker is printed as `<org-marker>`.
- Org env: `QA_ORG_MARKER=org-marker-<12 hex>` and `QA_CLASH=from-org`. Trigger env (`s2-trigger.yml`):
  `QA_CLASH: from-target` and `QA_TARGET_ONLY: t`.

## Results

| #   | Scenario                    | Command                                                                                                                   | Result                                                                         | Evidence                   |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------- |
| 1   | Harness regression          | `npx vitest run src/daemons/sprites src/triggers`; read the new tests                                                     | pass (47 files, 413 tests, 2 skipped); gaps listed                             | `s1-harness.log`           |
| 2   | Precedence on a real sprite | `wire.sh setenv` ×2, `install.sh s2-trigger.yml`, `watch.sh`, `sprite exec cat`, `sprite-state.sh`, `psql`/`pg_dump`      | pass                                                                           | `s2-precedence.log`        |
| 3   | Rewrite on env change       | `wire.sh setenv QA_ADDED 1`, `wire.sh rmenv QA_ADDED`, `wire.sh save` (same token), with `sprite-state.sh` and `watch.sh` | pass; Hub logs nothing (F2)                                                    | `s3-rewrite.log`           |
| 4   | Scrub                       | `install.sh s4-trigger.yml`, `watch.sh`, Hub log, `GET /v1/sprites/<n>`, `grep -cF`                                       | pass                                                                           | `s4-scrub.log`             |
| 5   | Rewrite failure isolation   | (A) let the sprite pause, `wire.sh setenv QA_PAUSED 1`; (B) `DELETE /v1/sprites/<n>`, `wire.sh setenv QA_GONE 1`          | pass: (A) the put woke the sprite; (B) failure reported and the save succeeded | `s5-failure-isolation.log` |
| 6   | Cleanup and secret grep     | `sprite api … -X DELETE`/GET, `DELETE /v1/tokens/<id>`, kill by PID, `docker stop`, `grep -rF`                            | pass                                                                           | `s6-cleanup.log`           |

What each scenario showed:

1. Everything passes and no run was flaky. Each of the PR body's five items is asserted, with these gaps: the
   `reportFailure` scrub path; short values; an alive row without `npmPrefix`; the `sprites.rewrite-service` report; a
   rewrite that throws before its per-trigger `try`; and a target env key that shadows a daemon variable.
2. Both org variables saved with `ok` before any trigger existed. Save to `alive` took 29 s (11:34:27 to 11:34:57Z),
   and the daemon connected at 11:34:56.5. (a) `bootstrap-env.txt` holds `<org-marker>`, `from-target`, `t`, and
   `<npmPrefix>/bin:/usr/local/sbin:…`. (b) The service env and `/proc/725/environ` both hold `HOME`, `PASEO_HOME`,
   `PATH`, and a 43-character `PASEO_PASSWORD` with the same hash, plus `QA_ORG_MARKER=<org-marker>`,
   `QA_CLASH=from-target`, and `QA_TARGET_ONLY=t`. (c) `machines.specs` is `{memoryMb, npmPrefix, bootstrapHash}`. A
   data-only `pg_dump` has the marker in one row only, `organization_sprites_configuration`.
3. Adding `QA_ADDED=1` took 6.66 s end to end through the tunnel. The service restarted at 11:36:52.1 (pid 725 → 789,
   new password hash), with `QA_ADDED=1` in the service and the environ and `QA_CLASH=from-target` still there.
   `daemons.disconnected_at` was 11:36:51.590 and `connected_at` 11:36:56.326, so the daemon was offline for 4.7 s.
   Removing it took 7.05 s: pid 839, `QA_ADDED` gone from the service and the environ, offline from 11:38:17.079 to
   11:38:21.727. Re-saving the token took 0.88 s and caused no restart: pid 839 and `started_at` were unchanged, and the
   daemon row did not change.
4. The row went `terminated` 22 s after the save with `shutdown_reason = "bootstrap exited with 3: [redacted]"`, and
   the marker is not in it. The Hub log has `WARN sprite activation failed` with the same reason, then
   `INFO sprite activation: destroyed after failure` 1.1 s later. The key was revoked, and `GET` returns 404. The marker
   appears 0 times in the whole Hub log. `from-org` and `from-target` appear 0 times too.
5. (A) The sprite went `warm` at 11:39:24Z, and Hub marked the daemon offline at 11:40:26.7. Setting `QA_PAUSED=1`
   returned `ok` in 6.68 s. The service put woke the sprite (`running`, `last_running_at` 11:41:17), the service
   restarted with `QA_PAUSED=1`, and the daemon reconnected at 11:41:21.6. Nothing failed. (B) After deleting the
   sprite through the API (the machine row stays `alive`), setting `QA_GONE=1` returned `ok` in 1.67 s, and the env
   row has `QA_GONE`. The Hub log has `WARN sprites.rewrite-service failed` with `failureKind: "notFound"` and
   `operation: "sprites.rewrite-service"`.
6. Both sprites return 404, and neither is in `sprite list`. The temporary token got 200 before `DELETE` (204) and 401
   after. Hub exited 2 s after SIGTERM (no daemon was connected by then), and cloudflared exited 1 s after SIGTERM. The
   container is gone. The secret grep found 0 hits (see `s6-cleanup.log`).

## Findings

1. **The scrub replaces substrings, so a short value wrecks log lines and leaks where it occurs.** `QA_TARGET_ONLY: t`
   (a resolved target value, so it is in the secrets list) turned the `hub connect output` log line into
   `connec[redacted]ing  h[redacted][redacted]ps://…`. The parts of the tunnel hostname between the marks stay
   readable. In scenario 5B, the `reportFailure` stack for `sprites.rewrite-service` lost every `t` and `1`
   (`QA_PAUSED=1`, `QA_GONE=1`). Replacements nest (`[Redac[Redacted]ed]`), and the frames are unreadable. The same
   applies to `shutdown_reason`. The positions of the marks also reveal where the value occurs. The orchestrator's
   review flagged this as a nit; on a real sprite it makes the log unusable as soon as any env value is short (`1`,
   `true`, `t`). Scrubbing every target value is also broader than needed, since the spec says target `env` is
   non-secret.
2. **Hub logs nothing for a rewrite, a daemon disconnect, or a reconnect.** Scenario 3 expected "Hub log shows the
   daemon coming back". There were 0 log lines across both rewrites and both reconnects. The only evidence is
   `daemons.connected_at` and `disconnected_at`, and the provider's service pid. A successful rewrite leaves no trace in
   Hub.
3. **Timing.** Settings saves that rewrite one sprite took 6.66 s, 7.05 s, and 6.68 s (the last woke a paused sprite).
   These were measured at the client through the tunnel. A save whose one provider call failed fast took 1.67 s, and a
   token save took 0.88 s. The daemon was offline for 4.7 s and 4.6 s. The rewrite runs sprites one at a time inside
   the request, so a save takes about 6 s per live sprite in the organization.
4. **A variable change wakes every paused sprite.** The service `PUT` on a `warm` sprite set it `running` and restarted
   the daemon, so the rewrite succeeded instead of failing. Rotating a credential therefore wakes and restarts every
   live sprite in the organization. This matches 5.1 and 5.9, but it is a cost and wake side effect the spec does not
   state.
5. **The `sprites.rewrite-service` failure does not name the sprite or the trigger.** Its context is operation,
   component, and `organizationId` only. With several sprites, an operator cannot tell which one failed. In scenario
   5B the machine row stays `alive` for a sprite that no longer exists, so every later variable save repeats the
   `notFound` report. Reconciling the row is outside this PR.
6. **The save still fails if the rewrite throws before its per-trigger `try`.** In `createSpriteServiceRewrite`,
   `getOrganizationSpritesConfiguration`, the `providerFor` construction, and `listOrganizationTriggers` run outside
   the `try`. `SpritesSettings.setEnv` and `removeEnv` await the rewrite after the env write has committed, so a
   database error there rejects the save although the variable was stored. This was found by reading the code; it is
   not reproduced, and no test covers it. It contradicts the PR's "never fails the settings write" only in that narrow
   case.
7. **A trigger's `env` can override `HOME`, `PATH`, `PASEO_HOME`, or `PASEO_PASSWORD`.** `daemonService` spreads the
   merged env after the daemon variables. The org map refuses those names, but the trigger compiler
   (`z.record(z.string().min(1), z.string())`) does not. A target `PATH` would replace the npm-prefixed PATH of the
   daemon, and of the bootstrap too. This was found by reading the code; it was not exercised, and the behavior is
   older than this PR.
8. Recipe notes. `sprite api /v1/tokens -- -X POST -d '{"description":…}'` created a token whose `description` is
   `null`, probably because the CLI sent no JSON content type. The token was identified by `inserted_at` and deleted by
   id. The org's first scenario-2 activation (with `bootstrap` printing to a file) took 29 s from save to alive; the
   `paseo` install was 14.8 s of that. SIGTERM stopped Hub in 2 s, but no daemon was connected at the time, so this run
   says nothing about ac-rst.
