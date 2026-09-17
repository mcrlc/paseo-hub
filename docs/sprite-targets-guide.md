# Sprite targets

A sprite target runs a trigger's agent on a Fly Sprite that Hub creates, bootstraps, and enrolls as a
daemon. The sprite pauses on its own when nothing runs on it and keeps its filesystem; Fly bills a
paused sprite for its storage. One trigger owns one sprite; two triggers on the same repository get two
sprites and two checkouts. The first daemon of a trigger appears on the Daemons page under the trigger's
name. A recreated sprite enrols as `<trigger-name>-<first 8 characters of the daemon id>`, because the
revoked daemon keeps the plain name.

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

`HOME`, `PATH`, `PASEO_HOME`, and `PASEO_PASSWORD` are refused in the target's `env`, because Hub sets
them on every sprite.

There is no sprite idle setting: the provider pauses a sprite about a second after Hub releases the last
hold on it, so a sprite never rests awake for long. `run.idle_timeout` still applies per execution, as on
any target.

## Lifecycle

- **Activation.** Saving the trigger creates the sprite, installs the Paseo CLI, runs `bootstrap`, writes
  the daemon service, and enrolls the daemon, so a bad `bootstrap` fails at activation rather than on the
  first event. The sprite then pauses. Activation takes about half a minute from the save to a usable
  daemon; the daemon's first start also downloads about 1 GB of speech models, which the sprite does not
  wait for.
- **Event while the sprite is paused.** Hub holds the sprite, which wakes it, and defers the run until the
  daemon's socket is live. From a warm pause the daemon reconnects in about a second. A cold sprite, about
  ten minutes after the pause, takes about a minute. The wait is bounded by `max_runtime`.
- **Event while the sprite is awake.** Hub holds it and hands off.
- **Terminal.** Hub waits for the terminal hub action, the archive, to complete and releases the hold only
  then; the provider pauses the sprite about a second later. Releasing earlier would let the pause cut the
  archive short. Each execution holds the sprite under its own name, so a sibling execution keeps it awake.
- **`bootstrap` changed.** Hub destroys the sprite, revokes its daemon, and terminates its machine row. The
  next event creates a new sprite and, because the daemon identity is new, a fresh conversation; the run
  records the session reset. The filesystem, including the checkout and the agent's history, does not carry
  over.
- **`env` changed.** Hub rewrites the daemon service, which restarts the daemon. The sprite, its filesystem,
  and its daemon identity are kept.
- **`memory` changed.** Hub updates the resources policy in place.

Neither an `env` nor a `memory` edit recreates the sprite, but both change the compiled target, which is
part of the continuation compatibility. The next event on a conversation that already has an agent
therefore fails with "Continuation settings differ from the existing agent; use a different key or choose
a new agent"; change the continuation key or wait for the conversation to end. This is Hub's general
continuation rule and is not specific to sprites.

- **Trigger disabled, or switched to a daemon target.** Hub destroys the sprite. Re-enabling the trigger
  activates a new one immediately, without waiting for an event.
- **Daemon revoked.** Hub destroys the sprite and terminates the row; the next event creates a new one.

A save that would end running executions is refused, naming the field that caused it: "Changing bootstrap
recreates the sprite and ends its 1 running execution. Save again once it is idle." Disabling the trigger
and switching its target are refused the same way. Edits that keep the sprite, `env` and `memory`, are not.

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
triggers they would be two agents, and the comment would reach one that never saw the review.

When the comment arrives while the review is still running, it is sent to the running agent as a new
message. When it arrives after the review ended, Hub holds the sprite, restores the archived workspace,
and sends the message to the same agent. An agent that closed or errored fails the run as
`agent_interrupted`.

## Credentials and continuation

A trigger with a leased credential, either `run.github` or a connection template in `run.env`, continues
an agent only while one of its executions is active. After every execution finishes, the next event starts
a new agent. This is Hub's rule for every target.

Provider credentials for sprites go in **Settings → Sprites → daemon environment**, for example
`CLAUDE_CODE_OAUTH_TOKEN` with the Claude subscription token from `claude setup-token`. The page keeps
values write-only: it lists the names it holds and never shows a value again. Hub writes this environment
into the daemon service of every sprite in the organization, and into the `bootstrap` environment, beneath
the target's `env`; on a clash the target's value wins. Values of eight characters or more are redacted
from Hub's logs and failure reasons. `HOME`, `PATH`, `PASEO_HOME`, and `PASEO_PASSWORD` are refused here
too. Nothing secret enters trigger YAML.

Saving the daemon environment rewrites the service of every alive sprite in the organization, one at a
time and about six seconds each, waking a paused sprite to do it, and the save waits for all of them.
Each rewrite restarts that sprite's daemon, which reconnects on its own. Rotating a credential is
therefore a settings save, not a recreation.

The target's `env` holds only per-trigger, non-secret values. A `${{ paseo.connections.<slug>.<value> }}`
template there cannot be used today: activation fails either way. A GitHub connection fails with
"env.<KEY> cannot be resolved without an execution lease", because its token is a per-execution lease;
every other connection kind fails earlier, with "connection capability is unavailable: <slug>", because it
has no resolver outside an execution.

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
