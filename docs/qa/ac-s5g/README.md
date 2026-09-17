# ac-s5g: verification of PR #6 (sprite target docs and security notes)

Verified at PR head `db67936` (`sprite-targets/docs-security`) against the PRD
(`/Users/mic/repos/hub/docs/sprite-targets.md` at `8ff4459`, with its measurement log
`docs/qa/sprites/README.md`) and `origin/main` at `318238c`. Commands run from the repository root.

The PR branch is based on `ffbcf81` and does not contain PR #3 (`318238c`), which added the sprite
target schema. The branch's own `src/triggers/configuration` rejects `kind: sprite`, so scenario 1
compiles against a detached worktree of `origin/main`
(`git worktree add --detach /tmp/ac-s5g-main origin/main`, `node_modules` symlinked from this
checkout). Both runs are in the log. After merge the docs sit on top of main, so main's result is the
one that counts.

| #   | Scenario                                                                                                                   | Command                                                                                                    | Result | Evidence                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------- |
| 1   | Every YAML block in the guide parses and compiles; `paseo.context` and `paseo.execution.id` accepted                       | `npx tsx docs/qa/ac-s5g/compile-guide-yaml.ts /tmp/ac-s5g-main` (and without argument, against the branch) | pass   | `01-yaml-compile.log`, `compile-guide-yaml.ts` |
| 2   | Every factual claim in both files traces to the PRD or main                                                                | manual trace, `git show origin/main:<file>`, `grep -n` on the PRD                                          | fail   | `02-claims.md` (findings F1-F6)                |
| 3   | Relative links and anchors resolve, including `scheduled-triggers.md#timing-and-recovery` and `SECURITY.md#sprite-targets` | `node docs/qa/ac-s5g/check-links.mjs`                                                                      | pass   | `03-links.log`, `check-links.mjs`              |
| 4   | Field, event, filter, continuation and `auto_archive` vocabulary matches main's schema exactly                             | `git show origin/main:src/triggers/configuration/schema.ts \| grep -n …` and related files                 | pass   | `04-vocabulary.log`                            |
| 5   | Gates: `npm run format:check`; PR CI                                                                                       | `npm run format:check`; `gh pr checks 6 --repo mcrlc/paseo-hub --watch`                                    | pass   | `05-gates.log`                                 |

Scenario 1 detail: both blocks compile on main. Block 1 compiles to a `sprite` environment with
`memory: 16384`, `env.ANTHROPIC_API_KEY`, and `worktree.newBranch: trigger-${{ paseo.execution.id }}`;
block 2 compiles to two events (`github.pull_request_label_added` with `label` and `from_users`,
`github.pull_request_comment_created` with `from_users`), `continuation: {mode: conversation}`, and the
prompt carrying `${{ paseo.context }}`. The control case, block 1 with `auto_archive: false`, is
rejected with `run.auto_archive: Sprite targets always archive; auto_archive must be true.` On the
branch's own code both blocks fail with `run.target.kind: Invalid discriminator value. Expected 'daemon' | 'undefined'`.

Scenario 2 is marked fail because six claims are unsupported, imprecise, or disagree with main.
Everything else traces. Rows in `02-claims.md` marked "planned": they trace to the PRD only,
because main has no sprite lifecycle yet.

## Findings

- **F1: the guide describes an unimplemented lifecycle as current behaviour.** The guide has no status
  note. It says, for example, "A run that reaches a sprite whose daemon is not connected yet waits
  rather than fails, exactly as for an offline daemon target" (guide L79), "If the sprite cannot be
  created or recreated, the run fails as `sprite_unavailable` instead of waiting out `max_runtime`"
  (L81-82), and "The trigger editor warns on save." (L71). The sources say otherwise. The PRD header
  says "Status: proposal, validated by spikes, not implemented." On main, dispatch to a sprite
  environment throws `workflow environment … is a sprite target, which cannot be dispatched yet`
  (`src/workflows/engine.ts:923-930`, `:949`), and the run fails as `validation` (`:541-548`).
  `sprite_unavailable` does not exist in `src/`. The editor marks sprite targets "Sprite targets can
  only be edited in YAML." (`src/triggers/configuration/editor.ts:67-68`) and has no warnings. The
  claims match the PRD. Merge the docs with the lifecycle implementation, or mark them as pending.
- **F2: the entitlement gate is missing from the prerequisites.** The guide says "Sprite targets need a
  Sprites org token in the organization's Sprites configuration." (L8). Main also requires the
  `canUseSpriteTargets` entitlement, which defaults to `false`. Without it, saving an enabled sprite
  trigger fails with "Sprite targets are not enabled for this organization."
  (`src/triggers/store.ts:71-80`, `:97-100`; `src/entitlements/catalog.ts:52`). The PRD's rollout step
  says "Gated by an entitlement." (PRD §8 L268).
- **F3: the memory default is imprecise.** The guide says "Memory limit in MB. Defaults to 8192." (L21).
  PRD 5.2 L136 says "Organization settings hold the Sprites org token and the default memory", and
  main stores that default per organization as `memory_mb` with a column default of 8192
  (`src/db/schema.ts:1322`). An organization that changed `memory_mb` gets its own value, not 8192.
  The PRD's 5.1 table ("Default 8192, the provider default") disagrees with its own 5.2, and the guide
  follows 5.1.
- **F4 (plausible; a risk for the implementation, not a text error): target `env` versus main's
  credentialed-session check.** The guide says the target's `env` is "Not a per-execution lease." (L22)
  and "Credentials in the target's `env` are not leases. … so an agent keeps its memory across idle
  days." (L138-139). This matches PRD 5.1 L102 ("do not make sessions credentialed"). On main,
  `hasTemporaryCredentials` counts any connection template in `intent.environment.env` as well as
  `intent.env` (`src/agent-sessions/index.ts:274-281`). If the lifecycle carries the target's
  `env` into the launch intent unresolved, a `${{ paseo.connections.… }}` value in the target's `env`
  will end continuation at terminal, which contradicts L132-139. That holds unless the implementation
  changes this check.
- **F5: "There is no idle setting." (L55) is ambiguous.** Main has `run.idle_timeout`, default `10m`
  (`src/triggers/configuration/schema.ts:117`), and it still applies per execution. The PRD's wording
  is narrower: "There is no `idle` field." (PRD 5.1 L105). The guide means there is no sprite pause
  setting.
- **F6: SECURITY.md says "the operator's Sprites organization".** The line is "…runs its agent on a
  Fly Sprite that Hub creates in the operator's Sprites organization." (SECURITY.md L7). The token is
  configured per Hub organization (`organization_sprites_configuration` keyed by `organization_id`,
  `src/db/schema.ts:1315-1321`; PRD 5.2 L136). On a Hub serving several organizations, the Sprites
  organization belongs to whichever Hub organization configured the token, not to the Hub operator.

Observations, not findings:

- The multi-event reviewer example (guide L89-116) grants no GitHub authority: no `run.github`, no
  `run.outputs`, and no credential in `bootstrap`. As written, the agent cannot post a review or a
  reply. The PRD's example has the same gap, and the Credentials section explains where the credential
  should come from.
- PRD 5.10 L226 says the org token "is stored in plain jsonb". Main stores it in a plain `text` column
  (`src/db/schema.ts:1321`). SECURITY.md's "unencrypted" is correct either way.
