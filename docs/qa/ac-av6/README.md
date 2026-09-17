# ac-av6: verification of PR #10 (organization daemon environment in Sprites settings)

PR: https://github.com/mcrlc/paseo-hub/pull/10, head `e3ef498`. Verified tree: a local, unpushed merge of
`origin/main` `07d15dd` (PR #8 and #9) into the PR head, `13a64ea`. **The merge was clean**: no conflicts,
and the journal grew from 50 to 51 entries with `0050_organization_sprites_env` last. This commit holds only
this folder, on top of the PR head.

Setup for scenarios 1, 2, 3, and 5: `npm run build`, then `node dist/index.js` with `DATABASE_URL` pointing at a
`postgres:17-alpine` container (`acav6-pg`), `PORT=4117`, `PASEO_HUB_APP_URL`, `PASEO_HUB_AUTH_SECRET`, and
`PASEO_BOOTSTRAP_ORGANIZATION=Acme` / `_OWNER_EMAIL` / `_OWNER_PASSWORD`. Owner, admin, and member accounts came from
`docs/qa/ac-0yj/setup-accounts.ts`. Saving a token now checks it against `api.sprites.dev`, so a temporary org token
(`hub-verify-ac-av6`) was minted with `sprite api /v1/tokens -X POST` and deleted afterwards. Its value appears nowhere
in this folder. Server-function ids come from `.output/server/assets/functions-*.js` of this build. Hub was stopped by
PID, and the containers and temp files were removed.

| #   | Scenario                               | Command                                                                                                                                                                                                                                                                                         | Result                                                     | Evidence                                                                                            |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Values never reach the browser or logs | `ui-journey.ts` (captures every browser response); `wire-scenarios.sh s1` (raw snapshot as admin/owner/member/none, SSR page as admin/owner); `grep -cF` on those responses and on `hub.log`; `git grep` for readers of `env`                                                                   | pass                                                       | [1-values-never-reach-client.txt](1-values-never-reach-client.txt), `browser-bodies.txt`, `hub.log` |
| 2   | Capability on the wire                 | `wire-scenarios.sh s2`: member and no-session `setSpritesEnv` / `removeSpritesEnv` / snapshot, then admin set + remove                                                                                                                                                                          | pass                                                       | [2-capability-on-the-wire.txt](2-capability-on-the-wire.txt)                                        |
| 3   | Round trip and rules on Postgres       | `wire-scenarios.sh s3`                                                                                                                                                                                                                                                                          | pass                                                       | [3-round-trip-and-rules.txt](3-round-trip-and-rules.txt)                                            |
| 4   | Migration                              | `s4-migration.sh` (fresh DB; DB migrated to 0049 by an `origin/main` worktree, then 0050; `npm run db:check`)                                                                                                                                                                                   | pass                                                       | [4-migration.txt](4-migration.txt)                                                                  |
| 5   | UI per docs/design.md                  | `npx tsx docs/qa/ac-av6/ui-journey.ts …`; `cross-form-probe.ts`                                                                                                                                                                                                                                 | pass, with a design deviation (F1) and a state defect (F2) | [5-ui-states.txt](5-ui-states.txt), `01`–`12` PNGs                                                  |
| 6   | Gates                                  | `npm run format:check`; `typecheck:node`/`:start`/`:e2e`; `npm run lint`; `npm run db:check`; `npx vitest run src/daemons/sprites src/db/organization-sprites-configuration.integration.test.ts src/db/migrations.integration.test.ts src/typography-policy.test.ts`; `gh pr checks 10 --watch` | pass                                                       | [6-gates.txt](6-gates.txt), db:check in [4-migration.txt](4-migration.txt)                          |

What each scenario showed:

1. The admin's browser received 165 responses, including 6 server-function POSTs: 1 token save, 3 sets, 2 removes. Neither
   sentinel value appeared in any of them, and neither did the token. After a reload with both keys stored, the rendered
   DOM contained neither value. The raw snapshots as admin and owner return
   `envKeys: ["CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY"]` and 0 value hits. Member and no-session snapshots return errors.
   Both SSR pages had 0 hits. `hub.log` (777 lines covering scenarios 1, 2, 3, and 5) had 0 hits for both sentinels, org2's
   value, the token, and the wire-scenario values. The only client-facing reader of `env` is `SpritesSettings.snapshot`,
   which returns only `Object.keys(env).sort()`. `setEnv` and `removeEnv` discard the returned record.
2. Member: set, overwrite, remove, and snapshot each return `status:error` "You don't have permission to configure Sprites."
   (log `failureKind: "forbidden"`), and the row digest is unchanged. With no session, all four are refused (generic
   fallback text, `failureKind: "authentication"`), and the digest is unchanged. Admin set gives `ok`, the key appears in
   the snapshot, and admin remove gives `ok`.
3. Before any token: set is refused with "Connect Sprites with an organization token first.", and no row is created. After
   saving the token, `env` is `{}`. Set `ROUND_TRIP=first` gives snapshot `["ROUND_TRIP"]`. Setting it again to
   `"  second  "` leaves 1 key with stored value `second` (trimmed) and advances `updated_at`. `lower`, `1ABC`, and `A-B`
   each get "Use capital letters, digits, and underscores, not starting with a digit.". HOME, PATH, PASEO_HOME, and
   PASEO_PASSWORD each get "Hub sets <KEY> on every sprite; choose another name.". Empty and whitespace-only values get
   "Enter a value.". An 8193-character value gets "Keep the value to 8192 characters or fewer."; 8192 is stored. `env` is
   unchanged by every refused write. Saving the token again keeps `{"KEEP_ME","ROUND_TRIP"}` exactly. Remove leaves `{}`
   and snapshot `[]`. The second organization's row is byte-identical at the end. The admin's write against its slug is
   refused (`failureKind: "notFound"`).
4. Fresh DB: `env | jsonb | not null | '{}'::jsonb`, 51 applied migrations. DB at 0049 by `origin/main` `07d15dd`: 50
   applied, no `env` column, then a configuration row is inserted. The merged tree migrates to 51, and the existing row
   reads `env = {}`. `update … set env = null` is rejected by NOT NULL. A re-run stays at 51. `npm run db:check` exits 0
   with "No schema changes", and `drizzle/` is unchanged.
5. See the screenshots and findings below. The value field is `type="password"`. The only button in the environment form is
   "Save variable", so there is no reveal control. The list is a `RecordList` of names only, with each row's actions behind
   one kebab (`RowActions` → `ConfirmMenuItem` "Remove" → alert dialog "Remove OPENAI_API_KEY?"). Client validation sends
   no request (0 POSTs for each invalid submit) and marks the offending field `aria-invalid`.
6. All commands exit 0. Vitest: 7 files passed, 1 skipped (the real-API client test), and 75 tests passed. CI on the PR
   head: 9/9 pass. The first `format:check` flagged only this folder's own `ui-journey.ts`, which was formatted and re-run.

## Screenshots

| File                                     | State                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `01-no-token-no-env-card.png`            | Not configured: no "Daemon environment" card                                     |
| `02-empty-state-after-token.png`         | Token saved: EmptyState "No variables" inside the card (and F1: cards touching)  |
| `03-form-filled.png`                     | Name filled, value masked                                                        |
| `04-validation-bad-name.png`             | `lower`: name error                                                              |
| `05-validation-reserved-name.png`        | `PASEO_PASSWORD`: reserved-name error                                            |
| `06-validation-empty-value.png`          | Whitespace-only value: "Enter a value."                                          |
| `07-list-two-keys.png`                   | CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY; "Variable saved." (F1, F4)              |
| `08-remove-confirmation.png`             | Remove confirmation dialog                                                       |
| `09-list-after-removal.png`              | Only CLAUDE_CODE_OAUTH_TOKEN left                                                |
| `10-after-save-then-empty-submit.png`    | Save, then empty submit: success notice cleared, both field errors shown         |
| `11-phone-width.png`                     | 390 px wide (F1)                                                                 |
| `12-token-field-cleared-by-env-save.png` | After a variable save: typed replacement token gone, "Updated just now" (F2, F3) |

Full-page captures of a scrolled page repeat the sticky header and sidebar partway down. That is a Playwright stitching
artifact, not the layout.

## Findings

- **F1 (docs/design.md deviation): the token card and the "Daemon environment" card touch.** The two `Card`s render as
  adjacent siblings in `SpritesSettingsPanel` (`src/daemons/sprites/panel.tsx`, the `<SpritesEnvironment …/>` after
  `<SpritesSettingsContent …/>`). `Card` owns no outer margin and nothing wraps them, so their borders meet with 0 px
  between them at both widths (`02-empty-state-after-token.png`, `07-list-two-keys.png`, `09-list-after-removal.png`,
  `11-phone-width.png`). docs/design.md: "A component owns its spacing to its neighbours… if the rhythm is wrong, fix it in
  the component", and sections sit `mb-8` apart via `Section`. The SummaryPanel above is spaced by its `Section`; the new
  card is not.
- **F2 (state defect): saving or removing a variable wipes a half-typed replacement token.** Type a token into "New token
  (replaces the stored token)" without saving, then save a variable. The token field becomes empty
  (`cross-form-probe.log`: `token field before env save: "half-typed-replacement-token"` →
  `token field after env save: ""`; `12-token-field-cleared-by-env-save.png`). Both forms are keyed on
  `snapshot.updatedAt` (the token `<form key={snapshot.updatedAt ?? "unconfigured"}>` and the env form's
  `formKey={snapshot.updatedAt ?? "unconfigured"}`). `setOrganizationSpritesEnv` and `removeOrganizationSpritesEnv` set
  `updated_at = clock_timestamp()`, so every variable write remounts the token form.
- **F3 (observation): variable writes move the token summary's "Updated".** The SummaryPanel sits above the token card.
  After a variable save it changes from "2 minutes ago" to "just now" (`cross-form-probe.log`, `12-…png`), and
  `updated_by_user_id` changes too (`3-round-trip-and-rules.txt`, `updated_at` advancing on each set). A reader takes it
  as the token's last change.
- **F4 (observation): the token card's "Sprites configuration saved." notice stays up while variables are added and
  removed.** Visible in `07-list-two-keys.png` beside "Variable saved."; `ui-journey.log` [07] text. It clears only on
  reload.
- **F5 (observation): remove with nothing to remove reports success.** `removeSpritesEnv` before any token exists, or for
  a key that is not stored, returns `status: ok` (`3-round-trip-and-rules.txt`). Harmless, but unlike set, which refuses
  without a token.
- **F6 (observation): a write against an organization the caller does not belong to gets the generic failure.** "Hub
  couldn't save the variable. The stored environment is unchanged." (log `failureKind: "notFound"`). The refusal itself is
  correct.
- **Resolved from ac-0yj F2:** the snapshot now requires manage-resources; a member gets "You don't have permission to
  configure Sprites." (`2-capability-on-the-wire.txt`).
- **Method notes, not defects.** The second organization and its configuration row were inserted with SQL, because a
  bootstrap instance has no second-organization flow. The pre-token state for scenario 3 was recreated by deleting
  Acme's configuration row after the UI journey. "Saving a new token" re-submitted the one temporary token that was
  minted; the upsert path is the same for any token value.

## Scripts

- `wire.sh`: raw curl of `spritesSettingsSnapshot`, `saveSpritesSettings`, `setSpritesEnv`, `removeSpritesEnv`, the SSR page, and the stored rows.
- `wire-scenarios.sh`: scenarios 1 (wire part), 2, and 3.
- `s4-migration.sh`: scenario 4 and `db:check`.
- `ui-journey.ts`: the UI states, screenshots, and browser response capture.
- `cross-form-probe.ts`: the F2/F3 reproduction.
