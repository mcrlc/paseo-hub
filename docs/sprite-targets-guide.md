# Sprite targets

A sprite target runs a trigger's agent on a Fly Sprite that Hub creates, bootstraps, and enrolls as a
daemon. The sprite pauses on its own when nothing runs on it and keeps its filesystem, so an idle
target costs storage only. One trigger owns one sprite; two triggers on the same repository get two
sprites and two checkouts.

Sprite targets need a Sprites org token in the organization's Sprites configuration and the
sprite-targets entitlement. A self-hosted instance running without billing has the entitlement through
the unlimited template; otherwise an operator grants it with an entitlement override (see
[Entitlements](entitlements.md)). Without it, saving the trigger fails with "Sprite targets are not
enabled for this organization." Read [`SECURITY.md`](../SECURITY.md#sprite-targets) before adding one.

## Reference

`run.target` takes a `kind`. Omitting it, or `kind: daemon`, keeps the `{ daemon, cwd, worktree }`
target described in the other trigger docs. `kind: sprite` takes these fields:

| Field       | Required | Meaning                                                                                                                                                                                                                                             |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`      | yes      | `sprite`.                                                                                                                                                                                                                                           |
| `bootstrap` | yes      | Shell script run once after the sprite is created, as the `sprite` user. It installs the agent CLIs and populates `cwd`. Hub installs the Paseo CLI before it and enrolls the daemon after it. A non-zero exit fails the sprite.                    |
| `cwd`       | yes      | Absolute directory on the sprite. `bootstrap` makes it exist and makes it a git checkout; Hub does not clone.                                                                                                                                       |
| `memory`    | no       | Memory limit in MB. Defaults to the organization's configured default memory, which is 8192 MB unless the organization changed it in its Sprites configuration. It is the only shape setting; Sprites offers no CPU or region choice.               |
| `env`       | no       | Per-trigger, non-secret values for the daemon service environment. Never secrets: provider credentials go in the organization's daemon environment (see [Credentials](#credentials-and-continuation)). A connection template here fails activation. |
| `worktree`  | no       | Same schema and behaviour as on a daemon target.                                                                                                                                                                                                    |

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

`auto_archive` must stay `true` on a trigger with a sprite target; validation rejects `false`. Hub
does not control when the provider drops a paused sprite's memory, and only an archived workspace is
guaranteed to restore.

There is no sprite idle setting: the provider pauses a sprite about 30 seconds after the last hold on it
is released. `run.idle_timeout` still applies per execution, as on any target.

## Lifecycle

- **Activation.** Hub creates the sprite, runs the Paseo CLI install and `bootstrap`, enrolls the daemon,
  and writes the daemon service straight away, so a bad `bootstrap` fails at activation rather than on
  the first event. The sprite then pauses. The first boot takes about a minute; the daemon's first start
  downloads about 1 GB of speech models.
- **Event while paused.** Hub places a hold on the sprite for the execution, which wakes it. The run waits
  until the daemon reconnects, usually a few seconds, and then dispatches. Wakes take about a second.
- **Event while awake.** Hub places a hold and dispatches.
- **Terminal.** Hub releases the execution's hold. With no hold left, the provider pauses the sprite about
  30 seconds later. Each execution holds the sprite separately, so a sibling execution keeps it awake.
- **`bootstrap` changed.** Hub destroys the sprite once its in-flight executions finish and creates a new
  one on the next event. The filesystem, including the checkout and agent history, does not carry over,
  and conversations bound to the old sprite start fresh agents. The trigger editor warns on save.
- **`env` changed.** Hub rewrites the daemon service. The daemon restarts and reconnects with its stored
  identity; the sprite is kept.
- **`memory` changed.** Hub updates the limit in place.

Deleting the trigger destroys the sprite. A revoked daemon or a sprite the provider reports lost is
recreated on the next event.

A run that reaches a sprite whose daemon is not connected yet waits rather than fails, exactly as for an
offline daemon target; see [Timing and recovery](scheduled-triggers.md#timing-and-recovery). If the sprite
cannot be created or recreated, the run fails as `sprite_unavailable` instead of waiting out
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
`CLAUDE_CODE_OAUTH_TOKEN` with the Claude subscription token from `claude setup-token`. Values there are
write-only. Hub writes this environment into the daemon service of every sprite in the organization,
beneath the target's `env`; on a clash the target's value wins. `bootstrap` runs with the same variables,
also beneath the target's `env`. Saving the settings rewrites the service on
every live sprite, which restarts its daemon. Nothing secret enters trigger YAML.

The target's `env` holds only per-trigger, non-secret values. A `${{ paseo.connections.<slug>.<value> }}`
template there fails activation with a message naming the key, because every connection kind Hub has needs
an execution lease.

Credentials in the daemon environment are not leases. They live in the daemon service for the life of the
sprite and every agent on it inherits them, so an agent keeps its memory across idle days. A reviewer that
must remember a pull request from one day to the next takes provider credentials from the daemon
environment, omits `run.github`, and relies on a GitHub credential placed on the sprite. The
trigger editor warns when a sprite target with `continuation.mode: conversation` also sets `run.github` or
a connection template in `run.env`. [`SECURITY.md`](../SECURITY.md#sprite-targets) describes what that
trade exposes.

Sprites hold no interactive provider logins. A `bootstrap` that needs one is a misconfiguration; put the
token in the daemon environment instead.

## Bootstrap notes

- **Run the Claude Code postinstall yourself.** The package's postinstall does not run on a sprite, so its
  native binary is missing until you run
  `node "$(npm prefix -g)/lib/node_modules/@anthropic-ai/claude-code/install.cjs"`.
- **Use absolute paths when testing by hand.** Hub runs `bootstrap` with `HOME=/home/sprite` and the npm
  global bin directory on `PATH`, so `npm`, `paseo`, and `~` work inside it. When you try commands yourself
  with `sprite exec`, the shell is non-login and its `PATH` lacks the npm global bin directory, so use
  absolute paths there.
- **Clone in `bootstrap`.** Hub does not clone. For a private repository, put the clone credential in
  Settings → Sprites → daemon environment, for example a fine-grained GitHub token in `GITHUB_TOKEN`, and
  read it in `bootstrap` as an ordinary variable:
  `git clone https://x-access-token:$GITHUB_TOKEN@github.com/acme/project.git /home/sprite/workspace/project`.
  Never write the credential into the trigger YAML.

## Limits

- One sprite per trigger. A burst of events on one trigger runs on one machine.
- Legacy multi-step bundles cannot target sprites.
- A hold lasts one hour and Hub refreshes it while the execution runs. If Hub is down longer than a hold's
  remaining time, the sprite can pause mid-turn; the turn resumes on the next hold.
