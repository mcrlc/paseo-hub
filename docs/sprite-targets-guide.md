# Sprite targets

A sprite target runs a trigger's agent on a Fly Sprite that Hub creates, bootstraps, and enrolls as a
daemon. The sprite pauses on its own when nothing runs on it and keeps its filesystem; Fly bills a
paused sprite for its storage. One trigger owns one sprite; two triggers on the same repository get two
sprites and two checkouts. A trigger's sprite daemon appears on the Daemons page under the trigger's name,
and a recreated sprite enrols under that name again: Hub renames the revoked daemon to
`<slug>-revoked-<first 8 characters of its id>`, which is how the retired one stays listed. Beside each
daemon's own status the page shows its machine status, so a sprite still being built or already gone is
visible there.

Sprite targets need a Sprites org token in the organization's Sprites configuration and the
sprite-targets entitlement. A self-hosted instance running without billing has the entitlement through
the unlimited template; otherwise an operator grants it with an entitlement override (see
[Entitlements](entitlements.md)). Without it, saving the trigger with `enabled: true` fails with "Sprite
targets are not enabled for this organization."; without a token it fails with "Sprites are not configured
for this organization." A disabled trigger saves without either, which is how one is authored before the
token exists. Read [`SECURITY.md`](../SECURITY.md#sprite-targets) before adding one.

## Reference

`run.target` takes a `kind`. Omitting it, or `kind: daemon`, keeps the `{ daemon, cwd, worktree }`
target described in the other trigger docs. `kind: sprite` takes these fields:

| Field       | Required | Meaning                                                                                                                                                                                                                                                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`      | yes      | `sprite`.                                                                                                                                                                                                                                                                                                    |
| `bootstrap` | yes      | Shell script run once after the sprite is created, as the `sprite` user. It installs the agent CLIs and populates `cwd`. Hub installs the Paseo CLI before it, and starts the daemon and enrolls it after it. A non-zero exit fails the sprite.                                                              |
| `cwd`       | yes      | Absolute directory on the sprite. `bootstrap` makes it exist and makes it a git checkout; Hub does not clone.                                                                                                                                                                                                |
| `memory`    | no       | Memory limit in MB. Defaults to the organization's configured default memory, which is 8192 MB unless the organization changed it in its Sprites configuration. It is the only shape setting; Sprites offers no CPU or region choice.                                                                        |
| `env`       | no       | Per-trigger, non-secret values for the daemon service and `bootstrap` environment. Never secrets: they are not redacted from logs, and provider credentials belong in the organization's daemon environment (see [Credentials](#credentials-and-continuation)). A connection template here fails activation. |
| `worktree`  | no       | Same schema and behaviour as on a daemon target.                                                                                                                                                                                                                                                             |

```yaml
name: review
on:
  github.pull_request_comment_created:
    connection: acme-github
    filters:
      from_users: [alice]
run:
  target:
    kind: sprite
    bootstrap: |
      npm install -g @anthropic-ai/claude-code
      node "$(npm prefix -g)/lib/node_modules/@anthropic-ai/claude-code/install.cjs"
      git clone https://github.com/acme/project.git /home/sprite/workspace/project
    cwd: /home/sprite/workspace/project
    memory: 16384
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
  agent: { provider: claude, mode: bypassPermissions }
  prompt: Review the pull request.
```

`auto_archive` must stay `true` on a trigger with a sprite target; saving `false` fails with "Sprite
targets always archive; auto_archive must be true." Hub does not control when the provider drops a
paused sprite's memory, and only an archived workspace is guaranteed to restore.

`HOME`, `PATH`, `PASEO_HOME`, `PASEO_PASSWORD`, `PASEO_LISTEN`, `PASEO_RELAY_ENABLED`, and
`PASEO_WEB_UI_ENABLED` are refused in the target's `env`, because Hub sets them on every sprite.

There is no sprite idle setting: the provider pauses a sprite about a second after Hub releases the last
hold on it, so a sprite never rests awake for long. After the first run following activation, the sprite
paused about 20 s after release, which matches the end of the daemon's first-start speech-model download.
`run.idle_timeout` still applies per execution, as on any target.

An execution is idle once the agent's turn ends without a call to `finish_execution`; a foreground
command, however long, counts as active. Hub cannot see background commands. One that outlives the idle
timeout keeps running after the execution fails, is frozen when the sprite pauses, and resumes when it
wakes. When the conversation continues, the next run's agent is not told about it.

## Lifecycle

- **Activation.** Saving the trigger creates the sprite, installs the Paseo CLI, runs `bootstrap`, writes
  the daemon service, and enrolls the daemon, so a bad `bootstrap` fails at activation rather than on the
  first event. The sprite then pauses. Activation takes about half a minute from the save to a usable
  daemon; the daemon's first start also downloads about 1 GB of speech models, which the sprite does not
  wait for.
- **Event while the sprite is paused.** Hub holds the sprite, which wakes it, and defers the run until the
  daemon's socket is live. A paused sprite starts warm and turns cold within minutes, on the provider's
  schedule. From either state the daemon normally reconnects in seconds: about a second from warm, and 2 s
  in a measured cold wake. The one slow wake measured took 64 s, with a 30 s `git rev-parse` timeout inside
  the daemon; its cause was not recorded. A sprite whose memory was dropped takes about 40 s to boot, and
  one such wake did not complete within `max_runtime`: every hold on it hit Hub's 20 s deadline, and the
  run timed out; the hold deadline has since been raised to 90 s. Continuation holds across a cold pause
  as across a warm one. The wait is bounded by `max_runtime`.
- **Event while the sprite is awake.** Hub holds it and hands off.
- **Terminal.** Hub waits for the terminal hub action, the archive, to complete and releases the hold only
  then; the provider pauses the sprite about a second later, or about 20 s later on the first run after
  activation. Releasing earlier would let the pause cut the
  archive short. Each execution holds the sprite under its own name, so a sibling execution keeps it awake.
- **`bootstrap` changed.** Hub destroys the sprite, revokes its daemon, and terminates its machine row. The
  next event creates a new sprite and, because the daemon identity is new, a fresh conversation; the run
  records the session reset. The filesystem, including the checkout and the agent's history, does not carry
  over.
- **`env` changed.** Hub rewrites the daemon service, which restarts the daemon with the new environment.
  While the sprite has a running execution the rewrite waits: the five-minute tick applies it once the
  sprite has none, and until then the trigger page says the sprite still runs the previous configuration.
  The sprite, its filesystem, and its daemon identity are kept.
- **`memory` changed.** Hub updates the resources policy in place.
- **Hub upgraded to a new Paseo CLI.** Hub pins the Paseo CLI version it installs. When a Hub upgrade
  changes the pin, the next five-minute tick installs it on every idle sprite and then rewrites the daemon
  service; until then the trigger page says the sprite still runs the previous configuration.
- **Trigger disabled, or switched to a daemon target.** Hub destroys the sprite. Re-enabling the trigger
  activates a new one immediately, without waiting for an event.
- **Daemon revoked.** Hub destroys the sprite and terminates the row; the next event creates a new one.

A save that would end running executions is refused, naming the field that caused it: "Changing bootstrap
recreates the sprite and ends its 1 running execution. Save again once it is idle." Disabling the trigger
and switching its target are refused the same way. Edits that keep the sprite, `env` and `memory`, are not.

Neither an `env` nor a `memory` edit recreates the sprite or ends a conversation. A sprite target's
continuation compatibility covers its `bootstrap`, `cwd`, and `worktree` only, so the next event
continues the same conversation. An `env` edit saved while an execution runs is applied by the
five-minute tick once the sprite has no running execution, and until then the trigger page shows the
sprite as stale; when it is applied the daemon restarts with the new environment and keeps the sprite,
its filesystem, and its daemon identity. A `memory` edit lands in place. Only a `bootstrap` change
recreates the sprite, and that starts a fresh conversation.

The trigger page has a Sprite section showing the machine's state, with a Recreate action that destroys
the sprite so the next run builds a new one; it is refused while the sprite has running executions.

A tick every five minutes re-holds every execution that is still spawning or running, which also recreates
a hold the provider lost. When Hub restarts it re-holds from the execution rows and resolves every sprite
still in `spawning`: if its daemon enrolled, the row becomes alive; otherwise Hub terminates the row,
revokes the enrollment key, and destroys the half-built sprite, leaving the next event to create a new one.

A run that reaches a sprite whose daemon is not connected yet waits rather than fails, exactly as for an
offline daemon target; see [Timing and recovery](scheduled-triggers.md#timing-and-recovery). If the sprite
is gone and recreating it also fails, the run fails as `sprite_unavailable` instead of waiting out
`max_runtime`.

## Multi-event reviewer

Continuation keys an agent by trigger and conversation. Two triggers never share an agent, even on the
same pull request. To have a comment reach the agent that did a review, put both events on one trigger:

```yaml
name: pr-reviewer
on:
  github.pull_request_label_added:
    connection: acme-github
    filters:
      label: review
      from_users: [alice, bob]
  github.pull_request_comment_created:
    connection: acme-github
    filters:
      # The agent comments as acme-review-bot through a GitHub connector; keep it out of this list.
      from_users: [alice, bob]
run:
  target:
    kind: sprite
    bootstrap: |
      npm install -g @anthropic-ai/claude-code
      node "$(npm prefix -g)/lib/node_modules/@anthropic-ai/claude-code/install.cjs"
      git clone https://github.com/acme/project.git /home/sprite/workspace/project
    cwd: /home/sprite/workspace/project
  agent: { provider: claude, mode: bypassPermissions }
  continuation: { mode: conversation }
  prompt: |
    Review this pull request, or answer the comment on it.
    ${{ paseo.context }}
```

Both events on one pull request derive the same conversation key, so they land on the same agent. As two
triggers they would be two agents, and the comment would reach one that never saw the review. Hub records
runs fired by the trigger's second event under the name `<trigger>-event-2`, here `pr-reviewer-event-2`,
so a filter on the trigger name alone misses them.

When the comment arrives while the review is still running, it is sent to the running agent as a new
message. When it arrives after the review ended, Hub holds the sprite, restores the archived workspace,
and sends the message to the same agent. An agent that closed or errored fails the run as
`agent_interrupted`.

The agent's own comments are events too. GitHub sends each one as `github.pull_request_comment_created`
from the login that posted it, and `from_users` matches that login. A comment posted as someone in
`from_users` passes the filter and starts another execution, which reaches the running agent as a new
message, so the trigger re-fires on its own comments and can loop. The agent must post as a login that is
not in `from_users`; `from_users: ["*"]` admits every login, the agent's included.

For a trigger that only reads and comments, use a Sprites GitHub connector. In the Sprites dashboard, add
a GitHub connector and approve GitHub's consent screen signed in as a machine account, such as
`acme-review-bot` above, not as a person in `from_users`. The native Sprites GitHub connector authorises a
GitHub user account, so the machine account is a second GitHub user; the beta used one. Posting as a
GitHub App identity instead needs a custom connector that sends an installation token, which expires
after an hour. Hub names every sprite `trigger-<trigger id>`
and creates it with the labels `paseo-hub`, `org:<organization id>`, and `trigger:<trigger name>`. The name
prefix `trigger-` or the label `paseo-hub` grants the connector to every Hub sprite in the Sprites
organization. The label `org:<organization id>` narrows it to one Hub organization's sprites, and the
labels `org:<organization id>` and `trigger:<trigger name>` together narrow it to one trigger's sprite.
Labels are set at create, so renaming a trigger keeps its old label until the sprite is recreated. Leave
`GITHUB_TOKEN` out of the daemon environment. The credential stays
in the Sprites organization and the sprite holds no token: calls go to
`https://api.sprites.dev/v1/gateway/github/<connection_id>/<path>` with no `Authorization` header, and the
gateway identifies the sprite by its Fly identity. Every sprite ships the `sprite-api-gateway` skill for
Claude Code, Cursor, Codex, and Gemini, and the agent finds the connector with
`GET https://api.sprites.dev/v1/gateway/list`, so a prompt that says to comment on the pull request is
enough. The agent's comments come from the machine account, and the trigger cannot re-fire on them while
that account is not in `from_users`.

The connector proxies the GitHub REST API only, not git. A trigger that clones a private repository or
pushes keeps a token in the daemon environment, as in [Bootstrap notes](#bootstrap-notes), and the same
rule applies: if the agent posts with that token, the token's user must not be in `from_users`, or the
trigger loops.

## Credentials and continuation

A trigger with a leased credential, either `run.github` or a connection template in `run.env`, continues
an agent only while one of its executions is active. After every execution finishes, the next event starts
a new agent. This is Hub's rule for every target.

Provider credentials for sprites go in **Settings → Sprites → daemon environment**, for example
`CLAUDE_CODE_OAUTH_TOKEN` with the Claude subscription token from `claude setup-token`. The page keeps
values write-only: it lists the names it holds and never shows a value again. Hub writes this environment
into the daemon service of every sprite in the organization, and into the `bootstrap` environment, beneath
the target's `env`; on a clash the target's value wins. Values of eight characters or more are redacted
from Hub's logs and failure reasons. The names refused in a target's `env` are refused here
too. Nothing secret enters trigger YAML.

Saving the daemon environment rewrites the service of every alive sprite in the organization, one at a
time and about six seconds each, waking a paused sprite to do it, and the save waits for all of them.
Each rewrite restarts that sprite's daemon, which reconnects on its own. Rotating a credential is
therefore a settings save, not a recreation. A daemon environment edit is applied to a busy sprite by the
five-minute tick once it has no running execution, and the trigger page shows the sprite as stale until
then.

The target's `env` holds only per-trigger, non-secret values. A `${{ paseo.connections.<slug>.<value> }}`
template there cannot be used today: activation fails either way. A GitHub connection fails with
"env.<KEY> cannot be resolved without an execution lease", because its token is a per-execution lease;
every other connection kind fails earlier, with "connection capability is unavailable: <slug>", because it
has no resolver outside an execution.

The trigger editor warns, without refusing the save, when a sprite target combines
`continuation.mode: conversation` with `run.github` or a connection template in `run.env`: both settings
are legal, they simply cancel. The alert is titled "Continuation ends when the leased credential does".

Credentials in the daemon environment are not leases. They live in the daemon service for the life of the
sprite and every agent on it inherits them, so an agent keeps its memory across idle days. A reviewer that
must remember a pull request from one day to the next takes provider credentials from the daemon
environment and omits `run.github`. [`SECURITY.md`](../SECURITY.md#sprite-targets) describes what that
trade exposes.

Sprites hold no interactive provider logins. A `bootstrap` that needs one is a misconfiguration; put the
token in the daemon environment instead.

## Bootstrap notes

- **Install Claude Code in `bootstrap`.** The daemon detects agent providers when it starts, and it starts
  after `bootstrap`. Installing Claude Code later, on a running sprite, leaves every run failing with
  `Provider 'claude' is not available` until the sprite is recreated.
- **Run the Claude Code postinstall yourself.** The package's postinstall does not run on a sprite, so its
  native binary is missing until you run
  `node "$(npm prefix -g)/lib/node_modules/@anthropic-ai/claude-code/install.cjs"`.
- **Allow the install scripts a package needs.** The sprite image's npm 12 skips a package's install
  scripts (`preinstall`, `install`, `postinstall`) unless they are allowed, and only warns, so `bootstrap`
  succeeds without them. Allow them per package on the global install with `--allow-scripts`, for example
  `npm install -g --allow-scripts=esbuild esbuild`. A package that ships a prebuilt linux-x64 binary works
  without its script, as the Paseo CLI's esbuild and node-pty do; check that before relying on it.
- **Use absolute paths when testing by hand.** Hub runs `bootstrap` with the npm global bin directory on
  `PATH`, plus the organization's daemon environment and the target's `env`, so `npm` and `paseo` work
  inside it. When you try commands yourself with `sprite exec`, the shell is non-login and its `PATH` lacks
  the npm global bin directory, so use absolute paths there.
- **Clone in `bootstrap`.** Hub does not clone. For a private repository, put the clone credential in
  Settings → Sprites → daemon environment, for example a fine-grained GitHub token in `GITHUB_TOKEN`, and
  read it in `bootstrap` as an ordinary variable:
  `git clone https://x-access-token:$GITHUB_TOKEN@github.com/acme/project.git /home/sprite/workspace/project`.
  Never write the credential into the trigger YAML.

## Limits

- One sprite per trigger. A burst of events on one trigger runs on one machine.
- One Hub instance per database. Restart recovery treats every sprite still in `spawning` as its own, so a
  second instance would retire the first one's activations.
- Legacy multi-step bundles cannot target sprites.
- A hold lasts one hour and the tick refreshes it every five minutes. If Hub is down longer than a hold's
  remaining time, the sprite can pause mid-turn; the turn resumes on the next hold.
- A daemon environment save is serial across the organization's sprites, about six seconds per alive
  sprite.
