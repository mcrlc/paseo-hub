# ac-7vf: verification of PR #19 (dashboard surfaces for sprite targets)

PR: https://github.com/mcrlc/paseo-hub/pull/19. Spec: `docs/sprite-targets.md` 5.11 and 5.7.

**Heads.** Verification started at `e776411` (the feature commit) and finished at `1c0c2b3` (the PR head).
The implementer pushed two fix commits while this ran, and the middle one did not build, so every head is
recorded:

| Head      | What it is                                 | `npm run build` | CI on the PR                                        |
| --------- | ------------------------------------------ | --------------- | --------------------------------------------------- |
| `49786ef` | `main` before the branch, for comparison   | pass            | —                                                   |
| `e776411` | feat(sprites): dashboard surfaces          | pass            | —                                                   |
| `301a693` | fix: keep the recreate fallback fixed (v1) | **fail**        | **5/9** — build, docker-smoke, browser-e2e, hub-e2e |
| `1c0c2b3` | fix: keep the recreate fallback fixed (v2) | pass            | **9/9**                                             |

Scenarios 1–6 were run twice: once on a production build of `e776411`, then again in full on a production
build of `1c0c2b3`. Everything in the table and in the logs is from the **`1c0c2b3`** run unless it says
otherwise. `301a693` is the subject of F1 and could not be run in a browser at all.

**Recipe.** `npm run build`, then `node dist/index.js` against a `postgres:17-alpine` container
(`qa-ac7vf-pg` on 55439), with `PORT=3000`, `PASEO_HUB_APP_URL`, `PASEO_HUB_AUTH_SECRET`, and the three
`PASEO_BOOTSTRAP_*` variables. Owner, admin, and member accounts came from `setup-accounts.ts` (adapted from
`docs/qa/ac-0yj`). No real sprite was created and no real Sprites token was used: `s2-seed.ts` stamps the
`canUseSpriteTargets` override, stores a fake org token, and saves the sprite-target trigger through the real
`OrganizationTriggerStore` with a recording provider, so the `machines`, `organization_triggers`, and API-key
rows are the ones activation really writes. Machine statuses were then moved with SQL, and the daemon,
execution, and run rows were seeded by `seed.ts`. Server-function ids come from
`.output/server/assets/functions-cYp8_Obo.js` of this build. Hub was stopped by PID, the container removed,
and the evidence grepped for every secret the run used (`s7-cleanup.log`).

| #   | Scenario                        | Command                                                                                                                 | Result                   | Evidence                                                                                                                                                  |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Harness regression              | `npx vitest run src/triggers src/daemons src/db/organization-sprites.integration.test.ts src/typography-policy.test.ts` | pass; test gaps in G1–G5 | [s1-harness.log](s1-harness.log)                                                                                                                          |
| 2   | Daemons page                    | `ui-daemons.ts`, `ui-machine-tones.ts`, `measure-rows.ts`                                                               | pass, with F2 and F3     | [s2-daemons-page.log](s2-daemons-page.log), `01`–`07`                                                                                                     |
| 3   | Trigger detail Sprite section   | `ui-sprite-section.ts` (alive/no run, alive/run, terminated, no machine, daemon target), at 1280 and 390                | pass, with F4 and F5     | [s3-sprite-section.log](s3-sprite-section.log), `08`–`12`                                                                                                 |
| 4   | Recreate                        | `ui-recreate.ts` (idle, busy), `ui-recreate-error.ts`, `wire.sh recreate`, `s4-fallback-probe.ts`                       | pass, with F6, F7, F8    | [s4-recreate.log](s4-recreate.log), [s4-wire-and-errors.log](s4-wire-and-errors.log), [s4-destroy-best-effort.log](s4-destroy-best-effort.log), `13`–`16` |
| 5   | Editor warning (5.7)            | `ui-editor-warning.ts`, `s5-warnings-probe.ts`                                                                          | pass                     | [s5-editor-warning.log](s5-editor-warning.log), `18`–`20`                                                                                                 |
| 6   | Activity table                  | `s6-seed-runs.ts`, `ui-activity.ts`, `measure-rows.ts`                                                                  | pass, with F3            | [s6-activity.log](s6-activity.log), `21`–`22`                                                                                                             |
| 7   | Gates, cleanup, and secret grep | `format:check`, `lint`, `typecheck`, `db:check`, `build`; `gh pr checks 19 --watch`; `kill`, `docker rm -f`, `grep -rF` | pass, 9/9 CI             | [s7-gates.log](s7-gates.log), [s7-cleanup.log](s7-cleanup.log)                                                                                            |

## What each scenario showed

**1. Harness.** On `1c0c2b3`: 63 files passed, 2 skipped (the real Discord and real Sprites client tests),
**628 tests passed, 0 failed**. On the earlier `301a693` run the same command gave 1 failure, 627 passed —
`src/daemons/registry.test.ts > negotiates the standard session only when offered=true`, the known ac-shh
flake, which passes on its own (`s1-harness.log` records both). It did not reproduce on the final head.
Nothing in this PR touches daemon sockets.

**2. Daemons page.** The sprite row reads `nightly-deploy` over `nightly-deploy` (F2), its id, and two pills;
the hand-enrolled `devbox` row reads one line and one pill. Both pills are `StatusPill`: the classes are
`bg-success-surface text-success` and friends, and `[data-slot="badge"]` count on the page is **0**. Machine
tones are the three the spec asks for — alive `bg-success-surface text-success` `rgb(74, 222, 128)`, spawning
`bg-warning-surface text-warning` `rgb(251, 191, 36)`, terminated `bg-neutral-surface text-neutral`
`rgb(212, 212, 216)`. The sprite row's kebab gives `Rename` with `aria-disabled="true"` and `Revoke` enabled;
the daemon row's gives both enabled.

**3. Trigger detail.** The Sprite section renders for both sprite-target triggers and not at all for the
daemon-target one. Rows: `Alive` / `trigger-<id>` / `16384 MB` / `Never` before any execution, and `2 hours
ago` after one is seeded; `Terminated` for a terminated row, with no kebab; `Not created` / `—` / `—` /
`Never` for a trigger whose machine row does not exist, also with no kebab. 0 badges in the section at every
state. The kebab appears only while the machine is `spawning` or `alive`, which matches the PR.

**4. Recreate.** The confirmation reads "Recreate this sprite? / Hub destroys the sprite and revokes its
daemon. The next run provisions a new one from the trigger's bootstrap, and continuation starts over." with
`Cancel` and `Recreate sprite`. Confirming on an idle sprite leaves the machine `terminated` with
`shutdown_reason` **"recreated from the dashboard"** and `terminated_at` set, the daemon `revoked` / `offline`
with `disconnected_at` set, the section reading `Terminated`, and the kebab gone. With one running execution
it is refused with exactly "Recreating this sprite destroys it and ends its 1 running execution. Try again
once it is idle." in a `FailureAlert`, and the machine and daemon rows are untouched (`alive` / no reason /
daemon `active`). On the wire: a member gets "You don't have permission to manage triggers.", an unknown
trigger id gets "This trigger no longer exists.", and no session gets the fixed fallback. Forcing a real
database error (renaming `machines` away for the one mutation) gives the browser
"Hub couldn't recreate this sprite. Reload its status before trying again." and **never the raw error** —
this is the fix, and at `e776411` the same probe put `relation "machines" does not exist` on screen.

**5. Editor warning.** A sprite target on `continuation.mode: conversation` with `run.github`, and the same
with a `${{ paseo.connections.… }}` template in `run.env`, each render the `WarningAlert`
"Continuation ends when the leased credential does" with the full message, and **both `Save YAML` buttons
stay enabled**. Removing `run.github` removes the alert. `triggerDocumentWarnings` was also asserted directly
for eight documents: the three warned shapes give exactly one warning at `run.continuation.mode`; a sprite
with neither, a sprite on `mode: new`, a daemon target with either, and a document that does not parse give
none.

**6. Activity.** The sprite-dispatched run shows `Running` beside `Alive`; the daemon-dispatched run shows
`Running` alone. 0 badges. This also exercises `listSpriteRunStatuses` against real Postgres for a _linked_
run, which the PR lists as uncovered.

**7. Gates.** `format:check`, `lint` (0 warnings, 0 errors, twice), `typecheck` (node, start, e2e),
`db:check` (no schema changes), and `build` all pass on `1c0c2b3`, and `gh pr checks 19 --watch` is 9/9.
Hub was stopped by PID and answers nothing on 3000; the container is gone; the comparison worktree is
removed. The grep found the auth secret in 0 files and the admin and member passwords in 0 files. The
bootstrap owner password appears only in `setup-accounts.ts`, which declares it, and the fake Sprites token
only in `s2-seed.ts`, which declares it; both are throwaway strings for a database that no longer exists,
the same shape as `docs/qa/ac-0yj/setup-accounts.ts`.

## Findings

1. **F1 (build regression, fixed during verification). `301a693` did not build.** Exporting
   `recreateSpriteFailure` — a plain function that called `respondWithFailure` — from
   `src/triggers/functions.ts` kept `src/failures/index.ts` in the client graph, and rollup failed on
   `"AsyncLocalStorage" is not exported by "__vite-browser-external"`. Verified locally that `49786ef` and
   `e776411` build and `301a693` does not, and CI on `301a693` was 5/9 with build, docker-smoke, browser-e2e,
   and hub-e2e red. This is the hazard the PR body names in its own "Unchanged deliberately" note about
   `configuration/index.ts` pulling `node:crypto` into the browser bundle, arriving through a different file.
   `1c0c2b3` fixes it by making `recreateSpriteMessage` a pure string function that imports nothing, and the
   build and all 9 checks pass. Recorded because it reached the branch and CI, not because it is still open.
2. **F2 (docs/design.md deviation): a sprite daemon's row prints the same name twice.** The row reads
   `nightly-deploy` over a muted `nightly-deploy` (`01-daemons-1280.png`, `s2-daemons-page.log`: cells
   `"nightly-deploy\nnightly-deploy"`). Enrollment already names a sprite daemon after its trigger
   (`ae7e043`), so `daemon.sprite.triggerName` equals `daemon.slug` whenever the trigger's name is already a
   slug — which is the common case, and is exactly the reason Rename is disabled two columns to the right.
   design.md: "A record is a primary line over a muted line at the same size. … how a record shows two
   facts." Here it shows one fact twice. 5.11 asks for the owning trigger on the secondary line; the
   information is only ever new when the trigger's name needed slugifying.
3. **F3 (docs/design.md deviation): rows carrying two pills are 47 px, not the 44 px body row.** Measured on
   both new surfaces at 1280 px, where there is room to spare: `devbox` 44 px and `nightly-deploy` 47 px on
   Daemons, `nightly-lint` 44 px and `nightly-deploy` 47 px on Activity (`s2-daemons-page.log`,
   `s6-activity.log`). design.md: "Table — … Body row h-11 `text-sm`." The `flex flex-wrap items-center
gap-1.5` wrapper added to `DaemonRow` and `ActivityRow` wraps the second pill onto its own line instead of
   widening the column, so a table of sprite and non-sprite records has a ragged row rhythm.
4. **F4 (observation): the Sprite section renders below the form's Cancel / Save row, 24 px under it.** The
   `<section>` is the last child of the editor's `div.grid gap-6`, after `</form>`
   (`src/triggers/panel.tsx:411`), so `Section`'s own `mb-8` is suppressed by `last:mb-0` and the parent's
   `gap-6` sets the distance: measured `gapAbove: 24` at both 1280 and 390, against the 32 px `Section`
   rhythm (`s3-sprite-section.log`, `09-sprite-section-alive-with-run-1280.png`). Read-only status arriving
   after the submit row also reads as detached from the page above it.
5. **F5 (spec gap): 5.11 asks the Sprite section for "status, last hold, and RowActions for Recreate"; it
   shows status, sprite name, memory, and last run.** There is no hold on the surface. "Last run" is
   `max(agent_executions.started_at)` for the machine, which is not the same fact as the hold that keeps the
   sprite awake (5.8). Either the spec line or the panel should move.
6. **F6 (observation): Recreate reports success even when the provider destroy fails.** `retireSprite` calls
   `destroyBestEffort`, which swallows the error; the row is marked `terminated` and the daemon revoked
   regardless, and `recreateSprite` returns `{ state: "complete" }`. In this run every Recreate logged
   `sprites.destroy failed` (`SpritesError`, `failureKind: "authentication"`) 3 ms before `sprite retired`
   (`s4-destroy-best-effort.log`), and the browser was told nothing. With a rotated or wrong Sprites token
   the sprite keeps existing and costing while the dashboard says it was recreated. `retireSprite` predates
   this PR; this is the first surface that lets a reader ask for it.
7. **F7 (observation): `recreateSprite` answers `ok / complete` for a trigger that has no sprite.** Both a
   sprite-target trigger that was never activated and a **daemon-target** trigger return success having done
   nothing (`s4-wire-and-errors.log`; `machines for that trigger after the call: 0`). `recreateSprite`
   returns early when `findLiveSpriteMachine` is undefined, and `spriteActivation?.()` is a no-op when the
   instance has no public base URL or API keys. The UI never offers the action in those states, so this is
   reachable only on the wire, but a caller cannot tell a no-op from a retirement.
8. **F8 (observation): a successful Recreate says nothing.** No notice, no `StatusLine`, no live region —
   `[idle] live regions: []` in `s4-recreate.log`. The only signal is the Status row flipping to `Terminated`
   and the kebab disappearing. A refusal gets a `FailureAlert`; success gets silence.
9. **F9 (observation, outside this PR): `saveTrigger`, four functions above the one that was fixed, still has
   the pattern F1's commit removed.** `fallback: error instanceof Error ? error.message : …`
   (`src/triggers/functions.ts`). A no-session POST to it returns the bare word `unauthenticated` to the
   browser (`s4-wire-and-errors.log`), where `recreateSprite` now returns its fixed sentence. Named because
   the fix round only covered one of the two.

## Test gaps against 5.11

The new tests are good on the shapes they cover — `panel.test.tsx` pins all four Sprite-section states,
`account-daemons.test.tsx` pins the secondary line, the three machine tones, and `canRenameDaemon`,
`activity-panel.test.tsx` pins both Activity rows, `editor.test.ts` pins the warning's four cases, and
`dashboard.test.ts` pins recreate's happy path and its busy refusal end to end. What is not covered:

- **G1: the manage-resources check on `recreateSprite`.** `dashboard.test.ts` has no `forbidden` case;
  deleting the `capabilitiesFor(...).manageResources` guard would not turn a test red. Covered here only on
  the wire (scenario 4).
- **G2: `shutdown_reason` "recreated from the dashboard".** The string appears in `src/triggers/dashboard.ts`
  and in no test. The `reason` this PR threads through `activation.ts` is asserted nowhere; the happy-path
  test checks status and daemon revocation only.
- **G3: `DaemonRegistration.list` joining sprites.** There is no test file for `DaemonRegistration` at all,
  so the `daemonId === null` filter and the `spriteFor` map that put `sprite` on each row are untested;
  `account-daemons.test.tsx` renders a row that is handed the field.
- **G4: `recreateSprite` against a trigger with no live machine** (F7) — untested in either direction.
- **G5: a _linked_ sprite run in `listSpriteRunStatuses`.** The PR says so; its integration test covers only
  the negative case. Scenario 6 exercises it against real Postgres, which closes it by hand but not in the
  harness.

## Screenshots

| File                                       | State                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `01-daemons-1280.png`                      | Both rows; the sprite row's duplicated name and two pills (F2, F3)        |
| `02-sprite-actions-rename-disabled.png`    | Sprite row kebab: Rename disabled, Revoke enabled                         |
| `03-daemon-actions-rename-enabled.png`     | Daemon row kebab: both enabled                                            |
| `04-daemons-390.png`                       | The same page at 390 px                                                   |
| `05`–`07-daemons-machine-*.png`            | Machine pill at `spawning`, `terminated`, `alive`                         |
| `08-sprite-section-alive-no-run-*.png`     | Alive, no execution yet: "Last run — Never", 1280 and 390                 |
| `09-sprite-section-alive-with-run-*.png`   | Alive with a seeded execution (F4 visible)                                |
| `10-sprite-section-terminated-*.png`       | Terminated: no kebab                                                      |
| `11-sprite-section-not-created-*.png`      | No machine row: "Not created", "—", "—", "Never"                          |
| `12-sprite-section-daemon-target-1280.png` | A daemon-target trigger: no Sprite section                                |
| `13-recreate-confirmation.png`             | The Recreate confirmation dialog                                          |
| `14-recreate-after-idle.png`               | After a successful Recreate: Terminated, no kebab, no notice (F8)         |
| `15-recreate-after-busy.png`               | The busy refusal in a `FailureAlert`                                      |
| `16-recreate-unexpected-error.png`         | A database error: the fixed sentence and a reference, never the raw error |
| `18-editor-warning-run-github.png`         | The 5.7 warning for `run.github`, Save still enabled                      |
| `19-editor-warning-run-env-template.png`   | The same for a connection template in `run.env`                           |
| `20-editor-warning-gone.png`               | `run.github` removed: no alert                                            |
| `21-activity-1280.png`                     | Sprite run with two pills, daemon run with one                            |
| `22-activity-390.png`                      | The same at 390 px                                                        |

Full-page captures of a scrolled page repeat the sticky header and sidebar partway down. That is a Playwright
stitching artifact, not the layout.

## Scripts

- `setup-accounts.ts` — owner, admin, and member accounts and their browser storage state.
- `seed.ts` — the shared seeding helpers: the recording provider, the trigger store, daemons, machines,
  executions, and runs.
- `s2-seed.ts`, `s3-seed-uncreated.ts`, `s3-seed-execution.ts`, `s6-seed-runs.ts` — the rows each scenario
  needs.
- `ui-daemons.ts`, `ui-machine-tones.ts`, `ui-sprite-section.ts`, `ui-recreate.ts`, `ui-recreate-error.ts`,
  `ui-editor-warning.ts`, `ui-activity.ts` — the Playwright journeys.
- `measure-rows.ts` — the row heights behind F3.
- `wire.sh` — raw POSTs of the `recreateSprite` server function as owner, member, and no session.
- `s4-fallback-probe.ts` — the sentence the recreate handler hands the browser for each failure, including a
  `SpriteBusyError` decayed to a plain `Error` the way the chunk boundary leaves it.
- `s5-warnings-probe.ts` — `triggerDocumentWarnings` asserted directly for eight documents.
