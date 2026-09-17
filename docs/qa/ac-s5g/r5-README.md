# ac-s5g round 5: verification of PR #6 at `88dec43`

Head verified: `git fetch origin`, then `git rev-parse --short HEAD` = `88dec43` =
`git rev-parse --short origin/sprite-targets/docs-security`, which contains the merge of `main` at
`49786ef`. Working tree clean at the start. No product code was changed in this round; the only
writes are the `r5-` files in this directory. Rounds 1 to 4 files are untouched. All times UTC on
2026-09-17.

Every lifecycle slice is merged, so this round drops round 1's "planned" status entirely: each
sentence is traced to a code path at `88dec43` or to a measurement in a named QA log.

## Results

| #   | Scenario                                              | Command                                                                               | Result               | Evidence                                    |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------- |
| 1   | Claim audit of the guide and `SECURITY.md`            | manual trace of every factual sentence against `src/` and the QA evidence rounds      | fail: findings F1-F7 | `r5-claims.md`                              |
| 2   | Every YAML example compiles, the control is refused   | `npx tsx docs/qa/ac-s5g/compile-guide-yaml.ts`                                        | pass                 | `r5-yaml-compile.log`                       |
| 3   | Links and anchors; vocabulary                         | `node docs/qa/ac-s5g/check-links.mjs`; round 1's greps re-applied at `88dec43`        | pass                 | `r5-links.log`, `r5-vocabulary.log`         |
| 4   | Every quoted refusal message, from the code           | `LOG_LEVEL=silent npx tsx docs/qa/ac-s5g/r5-messages.ts`                              | pass, 17 of 17 exact | `r5-messages.log`, `r5-messages.ts`         |
| 4b  | What an `env` or `memory` edit does to a conversation | `LOG_LEVEL=silent npx tsx docs/qa/ac-s5g/r5-continuation.ts`                          | finding F2           | `r5-continuation.log`, `r5-continuation.ts` |
| 5   | Gates                                                 | `npm run format:check`, `npm run typecheck`, `npm run lint`, `gh pr checks 6 --watch` | pass, all four green | `r5-gates.log`                              |

Scenario 2 detail: `compile-guide-yaml.ts` ran unchanged from this worktree (it resolves the guide and
the compiler relative to itself, so no path adaptation was needed). Both blocks parse and compile.
`compileTriggerDocument` always passes `spriteTargets: true`
(`src/triggers/configuration/index.ts:79-87`), so no flag had to be set by hand. The control,
block 1 with `auto_archive: false`, is rejected with
`run.auto_archive: Sprite targets always archive; auto_archive must be true.`

Scenario 4 detail: every message the two documents quote was produced from the real code over an
in-memory database and compared character for character: both entitlement and token refusals, the
`auto_archive` refusal, all four reserved keys in the target `env` and all four in the organization's
daemon environment, the bootstrap-change refusal in both its singular and its plural form, the
disable and the target-switch refusals, and the connection-template activation failure. The
eight-character redaction rule was exercised with a 7-character and an 8-character organization value
in the same failure reason, together with a target `env` value, which is not redacted. All 17
comparisons match.

Scenario 5 detail: `format:check`, `typecheck` and `lint` all exit 0 locally, and all nine PR checks
(`browser-e2e`, `build`, `docker-smoke`, `format`, `hub-e2e`, `lint`, `migrations`, `test`,
`typecheck`) pass on `88dec43c1764d23be50f90a23047302d764621e6`, which `gh pr view` confirms is the
PR head.

## Findings

Ordered by how much a reader is misled. None of them is a wrong quoted message: every refusal string
in the guide matches the code exactly.

1. **F1: "The first boot takes about a minute" (L69) is about twice the measured figure.** Every
   measurement of a sprite activation, from the save to the machine row going `alive`, is about half
   a minute: 27 s (`ac-vni` scenario 4), 29 s (`ac-wri` scenario 2), 29.1 s (`ac-7rt`, recreation),
   and 33-38 s (`ac-50k` finding 7). Nothing in any round measured a minute. The correct statement is
   "The first boot takes about half a minute." If the sentence means the daemon's speech-model
   download rather than the activation, no round measures that, and the sprite is enrolled and usable
   before it finishes, so the sentence should say which it means.

2. **F2: an `env` or a `memory` edit keeps the sprite and ends the conversation, and the guide says
   only the first half.** The guide says "`env` changed. Hub rewrites the daemon service, which
   restarts the daemon. The sprite, its filesystem, and its daemon identity are kept." (L82-83),
   "`memory` changed. Hub updates the resources policy in place." (L84) and "Edits that keep the
   sprite, `env` and `memory`, are not [refused]." (L91). All three are true. What none of them says
   is that the compiled environment is part of the continuation compatibility fingerprint
   (`src/workflows/engine.ts:1044-1056` puts `target: environment` in `continuation.compatibility`),
   so the next event on an existing conversation throws in
   `src/agent-sessions/index.ts:97-101` and the execution fails with
   `Continuation settings differ from the existing agent; use a different key or choose a new agent`
   (`src/daemons/lifecycle.ts:1163-1167`, `:2064-2066`). `r5-continuation.log` reproduces it: a
   conversation continues across an unchanged save, fails after the memory goes 16384 → 4096,
   continues again when the memory is put back, and fails again when a literal `env` key is added.
   For a multi-event reviewer, the Lifecycle section reads as "these two edits are the safe ones",
   and they are the two that break the agent the Multi-event reviewer section is about. No round
   caught this because every real-sprite round drives `manual.run`, which carries no conversation and
   therefore no continuation key. Suggested sentence after L84: "A trigger whose `continuation` is
   `conversation` starts a fresh agent after an `env` or `memory` edit: the target is part of the
   continuation compatibility, so the running conversation cannot continue on the edited one."

3. **F3: "because every connection kind Hub has needs an execution lease" (L163-164) holds for one
   kind.** GitHub is the only provider that registers a connection resolver
   (`src/application-runtime.ts:452-456` looks the provider up in `integrations`, and
   `src/providers/github/index.ts:166` is the only `integration:` in `src/` besides the wrapper in
   `src/provider-applications/internal/runtime-owner.ts:350-352`, which also only covers GitHub). A
   GitHub template fails exactly as documented, with `env.GH cannot be resolved without an execution
lease` (`r5-messages.log` case 9). A Slack or Discord slug fails earlier, in the resolver, with
   `connection capability is unavailable: <slug>`, which neither names the env key nor mentions a
   lease. Correct statement: "A connection template here fails activation. For a GitHub connection the
   message names the key, because the token is an execution lease; other connection kinds have no
   resolver outside an execution at all."

4. **F4: "suffixed if that name is taken" (L7) is every sprite after the first.** `revokeDaemon` sets
   `status = 'revoked'` and leaves the row (`src/db/pg.ts:1828-1835`), and
   `daemons_organization_slug_unique` has no status predicate
   (`src/db/schema.ts:634`), so the revoked daemon keeps the trigger's name. Every recreation —
   bootstrap change, disable then re-enable, daemon revocation — therefore enrols as
   `<trigger-name>-<daemonId[0:8]>`. `r5-messages.log` case 11 shows `manual-task` for the first
   daemon and `manual-task-79897685` after one bootstrap change. This matches `ac-vni` finding 4,
   `ac-52w` finding 13 and `ac-50k` finding 8, which all report the suffix as the normal case. The
   Lifecycle section should say it where it says the sprite is recreated.

5. **F5: "an idle target costs storage only" (L4) traces to a goal, not to a measurement.** The
   sentence comes from PRD §2 L43 ("Idle targets cost storage only"). No QA round measures Sprites'
   billing, and the spikes record only that a paused sprite keeps its filesystem. Either attribute it
   ("Fly bills a paused sprite for storage only") or drop the cost claim; the behaviour half of the
   sentence is proved by spike 1.

6. **F6: both prerequisite refusals are stated without their `enabled` qualifier (L12-14).** The guide
   says "Without it, saving the trigger fails with …". `src/triggers/store.ts:91-109` checks both the
   entitlement and the Sprites configuration only when `compiled.authored.enabled` is true, so saving
   a **disabled** sprite trigger succeeds on an organization with neither. That is deliberate — it is
   how a trigger is authored before the token exists — but a reader who saves a disabled draft and
   sees it accepted will conclude the gate is not there. Suggested: "Without it, saving the trigger
   with `enabled: true` fails with …".

7. **F7: "about seven seconds each" (L158, repeated L201-202) rounds the measurements up.** The four
   measured rewrites are 6.66 s, 7.05 s and 6.68 s (`ac-wri` finding 3) and 6.130 s (`ac-50k`
   finding 7); `ac-wri`'s own conclusion is "a save takes about 6 s per live sprite". "About six
   seconds" or "six to seven seconds" is the supported figure. Low severity, and the operational
   point — a serial save that grows with the number of sprites — is right either way.

## Observations, not findings

- The reserved-key refusal in the target `env` has no field path. `compileTriggerDocument` flattens
  every `compileHubConfig` error to `path: []`
  (`src/triggers/configuration/index.ts:88-91`), so the author sees
  `: Hub sets HOME on every sprite; choose another name.` while every other refusal in the guide
  names its field. The guide does not quote this message, so nothing in it is wrong; the code is.
- `prepareSpriteDispatch` has a second route to `sprite_unavailable` the guide does not describe: if
  no trigger row matches the run's project, the run fails immediately with no recreation attempt
  (`src/daemons/lifecycle.ts:243-265`). Not reachable through the normal path, where the run exists
  because the trigger does.
- A third prerequisite refusal exists and is not in the guide: "Sprite targets are unavailable on
  this Hub: no public base URL or API keys configured." (`src/triggers/store.ts:143-146`). It is an
  operator-side misconfiguration rather than an authoring one.
- `SECURITY.md` L10 says the token and the daemon environment are stored "as plain text". The token
  column is `text` and the environment is `jsonb` (`src/db/schema.ts:1329-1331`). Both are
  unencrypted, which is the sentence's point; only the literal column type differs.
- Round 1's F4 (the target `env` making a session credentialed) does not apply to the merged code.
  The compiled sprite environment never reaches the launch intent's `env`
  (`src/workflows/engine.ts:1008-1018` builds `environment` as a daemon target with no `env`), so
  `hasTemporaryCredentials` cannot see it, and a connection template there fails activation before
  any execution exists. L145-147 is exact.
- Round 1's F6 is answered: `SECURITY.md` L7 now says "the Sprites organization whose token the Hub
  organization configured".
