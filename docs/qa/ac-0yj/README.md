# ac-0yj: verification of PR #7 (Sprites tab in organization settings)

PR: https://github.com/mcrlc/paseo-hub/pull/7, head `fc0d96f`, base `origin/main` `318238c`.

Setup for scenarios 1–5: `npm run build`, then the production entry point `node dist/index.js` with
`DATABASE_URL` pointing at a `postgres:17-alpine` container (`ac0yj-pg`), `PORT=4107`,
`PASEO_HUB_APP_URL=http://127.0.0.1:4107`, `PASEO_HUB_AUTH_SECRET=<32+ chars>`, and
`PASEO_BOOTSTRAP_ORGANIZATION=Acme` / `PASEO_BOOTSTRAP_OWNER_EMAIL` / `PASEO_BOOTSTRAP_OWNER_PASSWORD`.
The bootstrap instance is invite-only, so `setup-accounts.ts` drives the real flows the e2e harness
uses (`e2e/helpers/hub.ts`): owner sign-in and forced password change, then an admin and a member
invited from the Team page and accepted. Screenshots come from a standalone Playwright chromium
script (`ui-journey.ts`) against that same production build rather than the harness fixture, so the
UI, the raw wire probes (`wire.sh`), and the database rows all describe one running instance. Server
function ids in `wire.sh` are the ones the admin's browser called on this build. The Hub was stopped
by PID and the container removed afterwards.

| #   | Scenario                        | Command                                                                                                                                                                                                                                | Result                                                                                                                                                                                                                                              | Evidence                                                     |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Token never reaches the browser | `wire.sh snapshot` and `wire.sh page` (admin, owner); all admin browser responses captured by `ui-journey.ts`; `git grep` for readers                                                                                                  | Pass: 0 hits in both raw snapshot responses, both SSR pages, 145 + 48 browser responses, and the Hub log. Only reader of the table is `SpritesSettings.snapshot`, which maps to `{configured, memoryMb, updatedAt, updatedByUserId}`                | [1-token-never-in-browser.txt](1-token-never-in-browser.txt) |
| 2   | Capability on the wire          | `wire.sh save <base> <slug> member.json …`, `… none …`, `… owner.json <token> omit`; `wire.sh row ac0yj-pg`                                                                                                                            | Pass: member → `status:error` "You don't have permission to configure Sprites." (`failureKind: forbidden`), row byte-identical; no session → refused, row identical; owner save → ok, snapshot `configured` true, 8192, new `updatedAt`. See F2, F3 | [2-capability-on-the-wire.txt](2-capability-on-the-wire.txt) |
| 3   | UI states vs docs/design.md     | `npx tsx docs/qa/ac-0yj/ui-journey.ts access\|first\|replace …`, `stale-notice.ts`                                                                                                                                                     | Pass for every requested state; no docs/design.md deviation found. One state defect: F1                                                                                                                                                             | [3-ui-states.txt](3-ui-states.txt), `01`–`10` PNGs           |
| 4   | Memory default                  | UI save with the field untouched; wire save with `memoryMb` omitted; UI save of 16384; `wire.sh snapshot`                                                                                                                              | Pass: 8192 stored both ways, 16384 stored; snapshot and SummaryPanel show the stored value (`8192 MB`, `16384 MB`)                                                                                                                                  | [4-memory-default.txt](4-memory-default.txt)                 |
| 5   | Replace flow                    | UI save of token B at 16384; `wire.sh row` before/after                                                                                                                                                                                | Pass via row: one row, token A → B, `updated_at` 08:39:01.000003 → 08:39:14.664254. Blocked: live-token proof through `sprite api` (no way to mint real org tokens)                                                                                 | [5-replace-flow.txt](5-replace-flow.txt)                     |
| 6   | Gates                           | `npm run format:check`; `npm run typecheck:node`/`:start`/`:e2e`; `npm run lint`; `npx vitest run src/daemons/sprites src/typography-policy.test.ts`; `npx playwright test e2e/dashboard-navigation.spec.ts`; `gh pr checks 7 --watch` | Pass: all exit 0; 19 passed + 1 skipped (real-API client test); typography 5/5; e2e 3/3; CI 9/9 green                                                                                                                                               | [6-gates.txt](6-gates.txt)                                   |

## Screenshots

| File                                            | State                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `01-member-settings-nav-no-sprites.png`         | Member: settings strip is Team, Usage                                       |
| `02-member-sprites-route-no-access.png`         | Member opens the route directly: EmptyState "No access to Sprites"          |
| `03-admin-settings-nav-with-sprites.png`        | Admin: Team, API keys, Sprites, Usage                                       |
| `04-admin-not-configured.png`                   | StatusPill "Not configured", Card "Connect Sprites", memory 8192            |
| `05-token-field-password.png`                   | `type="password"`, `autocomplete="off"`, the form's only button is Save     |
| `06-validation-empty-token-memory-0.png`        | Both field errors, `aria-invalid` on both, no request sent                  |
| `07-saved-notice.png`                           | Success notice, StatusPill "Configured", SummaryPanel, Card "Replace token" |
| `08-configured-summary-replace-form.png`        | Reloaded configured state                                                   |
| `09-replaced-16384.png`                         | After the replace: "16384 MB"                                               |
| `10-success-notice-beside-validation-error.png` | F1                                                                          |

## Findings

- **F1: the success notice stays up next to a new validation error.** Save successfully, leave the
  token field empty, and press Save again: the card shows "Sprites configuration saved." directly
  above "Enter the Sprites organization token." (`10-success-notice-beside-validation-error.png`,
  `ui-stale-notice.log`: `success notice still visible alongside the token error: true`). The panel
  passes `saved={save.data?.status === "ok"}` (`src/daemons/sprites/panel.tsx:101`); a submit that
  fails client validation never calls the mutation, so the previous success result stays. The
  reader is told two contradictory things at once.
- **F2 (observation): the snapshot server function has no capability check.** A member calling it
  directly gets `200` with `configured`, `memoryMb`, `updatedAt`, and `updatedByUserId`
  (`2-capability-on-the-wire.txt`, "Member calls the snapshot directly"). No token is returned and
  the panel does not request the snapshot for members (`enabled: manageResources`), so this is
  metadata only. Whether members may read it is a product decision; `save` is correctly gated.
- **F3 (observation): an unauthenticated save gets the generic failure text.** With no session the
  response is `"Hub couldn't save the Sprites configuration. The stored token is unchanged."`; the
  log records `failureKind: "authentication"`, `code: "unauthenticated"`. Refused correctly, but the
  message does not say to sign in.
- **F4 (observation): any non-empty string is accepted as a token.** Both synthetic tokens saved and
  flipped the status to "Configured"; nothing checks them against the Sprites API. A mistyped token
  surfaces only when a sprite trigger first runs.
- **Blocked: live-token proof for the replace flow.** The `sprite` CLI can add an existing org token
  but cannot mint one, and minting two real Fly org tokens is outside this verification. The
  replacement is proven by the database row only (`5-replace-flow.txt`).

No deviation from docs/design.md was found: status goes through `PageHeader` → `StatusPill`, the
panel composes only roster components, alerts inside the form carry no margin or `standalone`, and
`src/typography-policy.test.ts` passes. The untitled `Section` around the SummaryPanel and the
no-access EmptyState copy match the existing API keys panel (`src/auth/api-key-panel.tsx:216-226`).

## Scripts

- `setup-accounts.ts`: bootstrap owner password change; admin and member invited and accepted.
- `ui-journey.ts`: the UI steps, screenshots, and captured browser responses.
- `stale-notice.ts`: the F1 reproduction.
- `wire.sh`: raw curl of the snapshot and save server functions and the SSR page; the stored row.
- `browser-bodies-*.txt`: the admin browser's response bodies, with static `/assets/` bodies trimmed
  after the token counts were taken.
