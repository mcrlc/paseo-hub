# ac-1qy: verification of PR #2 (Sprites provider client and organization configuration)

Head verified: `033388a` on `sprite-targets/sprites-provider-client`. Run on 2026-09-17, macOS, Docker
Postgres 17 (`postgres:17-alpine`), `sprite` CLI logged in. No product code or existing test was changed.

| #   | Scenario                            | Command                                                                                                                                                                                                                   | Result                                                                               | Evidence                                               |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | Decoder against captured bodies     | `npx tsx docs/qa/ac-1qy/s1-decoder.ts`; `docs/qa/ac-1qy/s1-s3-live-capture.sh hub-verify-9f31ee`                                                                                                                          | pass (13/13 Spike 6 fixtures; 10/10 live bodies)                                     | [s1-decoder.txt](s1-decoder.txt)                       |
| 2   | HTTP request shapes                 | `npx tsx docs/qa/ac-1qy/s2-http-requests.ts`                                                                                                                                                                              | pass (see finding 2)                                                                 | [s2-http-requests.txt](s2-http-requests.txt)           |
| 3a  | Real API through the client         | `SPRITES_TOKEN=… npx vitest run src/daemons/sprites/client.real.test.ts`                                                                                                                                                  | blocked (`SPRITES_TOKEN` not set; test skipped)                                      | [s3-real-api.txt](s3-real-api.txt)                     |
| 3b  | Fallback: Spike 6 contract today    | `bash /Users/mic/repos/hub/docs/qa/sprites/spike6-http-api.sh hub-verify-35ad74`; `sprite list` before and after                                                                                                          | pass (sprite destroyed, list empty)                                                  | [s3-real-api.txt](s3-real-api.txt)                     |
| 4   | Migration                           | `npm run db:migrate` on fresh Postgres; `psql -c '\d organization_sprites_configuration'`; `npm run db:check`                                                                                                             | pass                                                                                 | [s4-migration.txt](s4-migration.txt)                   |
| 5   | Accessor round trip and constraints | `DATABASE_URL=… npx tsx docs/qa/ac-1qy/s5-accessor-roundtrip.ts`                                                                                                                                                          | pass for Postgres; in-memory passes round trip but accepts `memoryMb: 0` (finding 3) | [s5-accessor-roundtrip.txt](s5-accessor-roundtrip.txt) |
| 6   | No token leakage                    | `git grep -n -E "organization_sprites_configuration\|…SpritesConfiguration…"` and related greps                                                                                                                           | pass (only schema, migration, accessors, types, tests)                               | [s6-token-leakage.txt](s6-token-leakage.txt)           |
| 7   | Gates                               | `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm run db:check`, `npx vitest run src/daemons/sprites src/db/organization-sprites-configuration.integration.test.ts src/db/migrations.integration.test.ts` | pass (38 passed, 1 skipped)                                                          | [s7-gates.txt](s7-gates.txt)                           |

## Findings

1. **Blocked: the real client test did not run.** `SPRITES_TOKEN` is not set, so
   `client.real.test.ts` reports `Tests  1 skipped (1)`. As a fallback, the Spike 6 script and a
   capture script ran against the live API through `sprite api`. Together they covered everything
   the client depends on: create returns `http=201` with `"id":"sprite-…"`, the memory policy returns
   204, repeated `cmd`, `env` and `dir` work, stdin gives exit 7, a same-command service `PUT` is
   ignored (`Service already running with that command`), and DELETE then PUT applies the new env.
   Task calls also matched: `PUT /v1/tasks/<missing>` creates the task with exit 0 and
   `expires_at`, a second `DELETE` exits 22 with `curl: (22) The requested URL returned error: 404`,
   and destroy returns 204. The client code itself was only exercised through stubs.
2. **In-sprite task failures do not carry an HTTP status.** When `hold` or `release` fails inside
   the sprite, `SpritesError.status` is curl's exit code rather than the HTTP status:
   `threw SpritesError: status=22 body="curl: (22) The requested URL returned error: 500\n" message="Sprites API 22: curl: (22) The requested URL returned error: 500\n"`.
   Direct HTTP calls do carry the status (`status=500 body="internal boom"`, `status=400`,
   `status=401`). A caller that branches on `status` cannot tell a 500 from a 409 on a task call
   without parsing the body.
3. **The in-memory database does not enforce `memory_mb > 0`.** Postgres rejects the write with
   `new row for relation "organization_sprites_configuration" violates check constraint "organization_sprites_configuration_memory_mb_check"` (`"code":"23514"`).
   The in-memory store accepts it and returns `"memoryMb":0`. Its PR test only checks positive
   values, so it doesn't catch this gap. Cascade has no in-memory equivalent: `Database` has no
   method to delete an organization.
4. **Live exec framing differs from the Spike 6 notes in three ways.** The decoder handled all of them:
   - Today's HTTP/2 body has no trailing newline after the exit frame (`026572720a016f75740a0303`,
     the same bytes as `--http1.1`).
   - A 5000-byte stdout came back with its final `\n` in a separate frame (`…7878 01 0a 03 00`,
     5004 bytes).
   - A stderr line was split across two frames mid-word (`…5468 02 65 2072…`, "Th" then "e requested").

   The Spike 6 fixture with a trailing `0a` still decodes, so both forms are covered.

5. **A 404 release also writes to stdout.** With `curl -s` and no `-f`, stdout is
   `task "hub-verify" not found\n` alongside the curl error on stderr, with exit 22. `release`
   checks only stderr and the exit code, so it still succeeds. A repeated task `PUT` resets
   `started_at` as well as `expires_at` (`05:55:36Z` becomes `05:55:37Z`), which is harmless for a hold.
6. **Postgres truncates both FK constraint names to 63 bytes.** The generated names are 69 and 64
   bytes (`…_organization_id_organization_id_fk` becomes `…_organization_id_organization`). The repo
   already has 11 constraints truncated this way, and `db:check` still reports
   `No schema changes, nothing to migrate`.
7. **Not verified: errors streamed inside a successful service `PUT`.** `service()` reads and
   discards the streamed `PUT` body, so an error event inside a 200 stream would go unnoticed. No
   live error stream was produced to confirm this.
8. **Two gate failures came from this QA folder, not from the PR.** `format:check` first flagged
   only `docs/qa/ac-1qy/s1-decoder.ts`, `s2-http-requests.ts` and `s5-accessor-roundtrip.ts`; after
   `oxfmt` it returned `All matched files use the correct format.` The pre-commit lint then
   rejected the first commit attempt with `Found 0 warnings and 38 errors.`, all in those scripts
   (mostly `no-console`). The scripts were fixed and rerun, and the hook was not skipped.
