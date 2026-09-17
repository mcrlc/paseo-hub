# ac-fc6: verification of PR #1 (`run.target` discriminated on `kind`)

Verified at head `dd22822` against `origin/main` `1512f10`. All commands run from the repository root
unless marked `(main)`, which means the same command in a `git worktree add /tmp/hub-main origin/main`
checkout with this folder's scripts copied in and `node_modules` symlinked.

| #   | Scenario                                                  | Command                                                                                                                                                                                                                                                                                                            | Result                                                                 | Evidence                                                                                                                        |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Stored triggers are unchanged (5 documents, no `kind`)    | `npx tsx docs/qa/ac-fc6/compile-triggers.ts [--part=environment-events]` on HEAD and (main), then `diff -u`                                                                                                                                                                                                        | pass for persisted output; fail for the literal full-object byte check | `01-stored-triggers.diff` (empty), `01-stored-triggers-full.diff`, `01-{main,head}-*.log`, `compile-triggers.ts`, `fixtures.ts` |
| 2   | Explicit `kind: daemon` equals omitted kind               | `npx tsx docs/qa/ac-fc6/compile-triggers.ts --explicit-kind` vs without the flag, then `diff -u`                                                                                                                                                                                                                   | pass                                                                   | `02-explicit-kind.diff` (empty)                                                                                                 |
| 3   | Unknown kinds rejected at `run.target.kind`               | `npx tsx docs/qa/ac-fc6/unknown-kinds.ts`                                                                                                                                                                                                                                                                          | pass                                                                   | `03-unknown-kinds.log`, `unknown-kinds.ts`                                                                                      |
| 4   | Legacy bundles cannot name `fly` or `docker`              | `npx tsx docs/qa/ac-fc6/legacy-bundles.ts` (compiler, then `POST /api/v1/configurations/install` through `createPublicApi` + real public operations + `ProjectConfigurationStore` + memory DB); `npx tsx docs/qa/ac-fc6/unused-legacy-environment.ts`                                                              | pass (HTTP 422 for both)                                               | `04-legacy-bundles.log`, `legacy-bundles.ts`, `unused-legacy-environment.ts`                                                    |
| 5   | Legacy migration writes `kind: daemon`                    | `npx tsx docs/qa/ac-fc6/legacy-migration.ts`                                                                                                                                                                                                                                                                       | pass                                                                   | `05-legacy-migration.log`, `legacy-migration.ts`                                                                                |
| 6   | End-to-end daemon path                                    | `RUN_HUB_E2E=1 PASEO_E2E_WORKTREE=/tmp/paseo-e2e npx vitest run src/e2e/hub-foundation.e2e.test.ts -t "completes an isolated manual run\|delivers a long prompt"` (real source-built daemon at `PASEO_E2E_COMMIT`); `npx vitest run src/triggers/schedule/schedule.integration.test.ts src/triggers/store.test.ts` | pass                                                                   | `06-e2e-daemon.log`                                                                                                             |
| 7   | Editor bridge round-trips and keeps an explicit kind line | `npx vitest run src/triggers/configuration/editor.test.ts`; `npx tsx docs/qa/ac-fc6/editor-explicit-kind.ts`                                                                                                                                                                                                       | pass                                                                   | `07-editor-bridge.log`, `editor-explicit-kind.ts`                                                                               |
| 8   | Gates                                                     | `npm run format:check`; `npm run typecheck`; `npm run lint`; `npx vitest run src/config src/triggers src/configuration src/workflows src/public-api src/test-utils`                                                                                                                                                | pass                                                                   | `08-gates.log`                                                                                                                  |

## Findings

1. **Scenario 1, full `CompiledTriggerDocument` is not byte-identical.** `compileTriggerDocument(...).authored.run.target`
   now carries `"kind": "daemon"` (the schema default), so the full JSON gains one line per document
   (`01-stored-triggers-full.diff`, exit 1). Everything Hub persists for a trigger is unchanged: `environment` and
   `events` (the `normalizedConfiguration` input) are byte-identical (`01-stored-triggers.diff`, exit 0) and
   `authoredHash` is identical because it hashes the input YAML. `authored` is only read in memory (name, enabled,
   recurrence, authoring contract) and re-serialized only by the legacy migration, where the new line is intended.
   Low impact, but anything that serializes `authored` now emits `kind: daemon`.
2. **Scenario 3, the message leaks a schema detail.** All four kinds fail at `run.target.kind` with
   `Invalid discriminator value. Expected 'daemon' | 'undefined'`. An author can act on it (the path is exact and
   `daemon` is named), but `'undefined'` reads as a valid value to type; "Expected 'daemon' (or omit kind)" would be
   clearer. `kind: ""` gets the same message.
3. **Scenario 4, rejection moved earlier and got stricter.** On `origin/main` a referenced `fly`/`docker`
   environment failed at `steps.work.environment` with the message
   `trigger request step work environment runner must be a daemon environment`; on HEAD it fails at `.paseo/hub.yml.environments.runner.kind` with
   `Invalid discriminator value. Expected 'daemon'`. Both return HTTP 422 `invalid_configuration_bundle`. New
   behaviour: a bundle with an **unreferenced** `fly` environment was accepted on main and is now rejected, and a
   stored normalized configuration containing one no longer parses
   (`active configuration contains an invalid compiled workflow contract`). Any existing revision like that would
   fail to load, and `migrateLegacyProjectTriggers` (which runs `compileHubBundle` and `parseCompiledHubConfig` on
   pending projects before providers start) would throw for it. Consistent with the no-back-compat policy, but worth
   a conscious call before deploying over existing data.
4. **Scenario 6, harness scope.** The e2e harness installs only legacy bundles (`kind: daemon` environment plus a
   `manual.run` trigger); it has no single-run trigger-document install. The trigger-document path to a daemon was
   additionally covered by `schedule.integration.test.ts` ("Hub runtime dispatches through the peer daemon port and
   completes ordinary scheduled history", fake daemon port, Postgres). Running the e2e suite needed `npm run build`
   first; without `.output/` the Hub child fails with `ERR_MODULE_NOT_FOUND ... .output/server/start-server.js`.
5. **Gates skipped files.** `src/public-api/built-server.integration.test.ts` (guarded by `RUN_BUILT_PUBLIC_API_TESTS=1`)
   and `src/triggers/discord/e2e.real.test.ts` are skipped by their own guards in the gate run. Because the PR edits the
   former's fixture, it was run separately after `npm run build` and passed 3/3 (`08-gates.log`). The Discord real test
   was not run (needs real Discord credentials).
