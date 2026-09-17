# Cross-provider continuation

PRD for letting one agent hold a conversation across GitHub and Slack: a PR's events, a Slack thread that names the PR, and a thread the agent opened itself all reach the same session. Status: proposal, not implemented. Split out of `docs/sprite-targets.md`; neither PRD depends on the other.

Validated against `getpaseo/hub` at `1512f10 fix(executions): survive Hub restarts with active credentials (#133)`. Unprefixed `file:line` references are to this tree.

## Premise probes

| Probe            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session identity | Keyed by the trigger's hidden project plus a continuation key (`src/agent-sessions/index.ts:47-58`). A session holds exactly one key (`findAgentSessionByKey`, `src/db/pg.ts:2760`). GitHub's conversation key is `["github", repositoryId, number]` for any event carrying a pull request or issue (`src/triggers/github/provider.ts:346-359`); Slack's is `["slack", team, channel, thread]` (`src/triggers/slack/provider.ts:183-191`). Keys are namespaced per provider, so a Slack thread and a PR never share a session in `conversation` mode.               |
| Custom key scope | `mode: key` renders from `prompt`, `inputs`, `steps`, and `values` (`src/workflows/expression.ts:22-29`). `context` is null when the key renders (`src/workflows/engine.ts:1010-1013`). The parser admits only `prompt`, `context`, `inputs.<name>`, and `execution.id` under `paseo` (`src/workflows/expression.ts:178-187`), so a new field needs a parser change as well as a context change. Null interpolates as the string `null` (`:423-425`). An empty or over-long rendered key throws in `continuationKey` (`src/triggers/continuation.ts:31-36`).        |
| Declared inputs  | Arrive as leading `name=value` tokens after the bot mention (`src/triggers/invocation.ts:142-172`, `:268`).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Outputs          | The only agent-facing output tool is `reply`. Each provider registers its own type, available only when the output context's provider matches the arrival's origin (`src/providers/slack/index.ts:176-181`, `src/providers/github/index.ts:238-241`). The Slack executor needs `channelId` and `threadTs` from the arrival and always posts into that thread (`src/triggers/slack/reply.ts`, `src/triggers/slack/client.ts:284-288`). Nothing posts a new message to a channel. Slack triggers fire only on `slack.mention` (`src/triggers/slack/provider.ts:108`). |
| Channel filter   | `channels` is a declared filter (`src/triggers/configuration/schema.ts:48`) and Slack matching enforces it (`src/triggers/slack/match.ts:46-47`).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Slack app        | Self-hosted Hub uses an operator-created Slack app from the shipped manifests (`slack-app-manifest.yml`, `slack-webhook-app-manifest.yml`). Bot scopes already include `chat:write`, `channels:history`, and `groups:history`; `bot_events` subscribes to `app_mention` only. Socket Mode holds one connection per Hub process (Paseo `public-docs/hub/self-hosting/slack-app.md`).                                                                                                                                                                                 |

## 1. Problem

A PR reviewer cannot ask a question in Slack and hear the answer. Conversation keys are namespaced per provider, the custom key scope has no provider event fields, a session holds one key, and the only Slack output replies into the arrival's own thread. An agent spawned from a GitHub event has no way to open a Slack thread, and a Slack mention has no way to reach the agent that reviewed the PR.

## 2. Goals

- A trigger that listens to GitHub and Slack events can route both to one agent by PR number.
- An agent can open a Slack thread from any arrival, and replies in that thread reach the same agent.
- Replies still go to each arrival's origin: a Slack mention is answered in the thread, a PR comment on the PR.
- No new bot scope. Existing installs receive no new traffic by upgrading.

## 3. Non-goals

- Cross-trigger sessions. Two triggers still never share an agent.
- Any change to Slack replies without a mention unless the operator edits their own Slack app (5.4).
- A generic outbound messaging surface. `slack.post` is the one addition.

## 4. Requirements

### 4.1 Event fields in the key scope

**Decision: `paseo.event.<provider>.*` joins the expression grammar and is populated from the trigger context when the continuation key renders.**

- Parser: `parsePaseoPath` accepts `["event", provider, ...path]` (`src/workflows/expression.ts:178-187`).
- Context: `workflowContext` sets `event` from `run.triggerContext`, which the run record already carries (`src/workflows/engine.ts:316`). First field: `paseo.event.github.number`.
- Null rule: a key template whose interpolation evaluates to null renders `null` today. In `mode: key`, a rendered key containing a null interpolation is treated as absent rather than as the literal, so the lookup falls to the alias table (4.2). With no alias, the run fails with the existing non-empty-key error.

### 4.2 Conversation aliases

**Decision: a new `agent_session_conversations` table maps `(projectId, conversationKey)` to a session.**

- Whenever an arrival that carries a conversation dispatches under a custom key, Hub upserts the arrival's conversation key as an alias for that session.
- Lookup order in `key` mode: rendered custom key, then the arrival's conversation key through the alias table.
- Clearing a session's continuation key (`src/agent-sessions/index.ts:88`) also deletes its aliases.
- Aliases are per project, so two triggers never resolve to each other's agent.

### 4.3 Trigger shape and docs

The Slack side opens a thread with a declared input and never repeats it: `@hub pr=123 what about the tests?`. `pr` is a non-required number input. The first message binds the thread through the alias; later mentions in that thread carry no header and resolve through it.

```yaml
inputs:
  pr: { type: number }
on:
  github.pull_request_label_added: { filters: { label: review } }
  github.pull_request_comment_created: { filters: { from_users: [...] } }
  slack.mention: { filters: { channels: [C0123] } }
run:
  continuation:
    mode: key
    key: pr-${{ paseo.inputs.pr ?? paseo.event.github.number }}
```

A Slack mention with no `pr=` header in an unbound thread renders a null interpolation, resolves no alias, and fails the run with the key error. The docs show the header form.

### 4.4 Agent-initiated Slack outreach

**Decision: a `slack.post` output lets an agent open a Slack thread from any arrival, and the alias table binds that thread to the agent's session.**

**Worked example.** A PR reviewer finds a migration it cannot judge. It calls `slack.post` with the `#backend` channel and a question. Hub posts the message, records the new thread as an alias for the reviewer's session, and the agent finishes its execution. An engineer answers in the thread with `@hub the column is nullable on purpose`. The mention matches the trigger's `slack.mention` entry, resolves through the alias to the reviewer's agent, and the agent continues with the answer. Its `reply` lands in the Slack thread, and its next PR comment lands on the PR.

- **Output type `slack.post`.** Tool arguments `channel` and `content`. Available on any arrival when the trigger has a Slack connection, so the output context carries the connection rather than an arrival thread. Executes `chat.postMessage` without `thread_ts` and returns the message `ts` to the agent as the tool result.
- **Alias on post.** On success Hub upserts `(projectId, ["slack", team, channel, ts])` as an alias for the calling execution's session.
- **Trigger shape.** The trigger lists `slack.mention` under `on`, with a `channels` filter that includes the channel the agent may post to. With the shipped manifest a human must mention the bot to continue; the docs say so.
- **Plain thread replies, opt in.** The operator may add `message.channels` and `message.groups` to `bot_events` in their Slack app. Hub accepts those events and routes only messages whose thread resolves through the alias table to a session; every other channel message is dropped before matching. Nothing new is required from trigger authors. The shipped manifests keep `app_mention` alone. The Apps page documents the optional events and what Hub does with them.
- **Scopes.** No new bot scope. `chat:write` covers posting and the history scopes cover thread hydration. The bot must be invited to the channel.
- **Bound.** `slack.post` is authored under `allow_outputs` with `max`, so an author caps how many threads one agent may open. Hub rejects a call past the cap with the existing output limit error.
- **Authority.** The channel must be one the Slack connection's bot is in. A post to a channel outside the trigger's `channels` filter is rejected, because replies there could never reach the agent.

## 5. Security

- Message events (4.4) deliver every message in every channel the bot is in. Hub drops all but alias-resolved thread replies before matching and never stores the rest. The Apps page states this before the operator opts in.
- `slack.post` is bounded by `max` and by the trigger's `channels` filter. An agent cannot reach a channel its trigger does not listen to.
- Aliases are scoped to the trigger's hidden project. A Slack thread can only ever resolve to an agent of the trigger that created or was mentioned in it.

## 6. Ceilings

- **Slack replies need a mention by default.** The shipped manifest subscribes to app mentions only. Plain replies in an agent-opened thread work only after the operator adds message events to their own Slack app.
- **Socket Mode is single process.** One live connection per Hub, and Slack events during Hub downtime are lost. A multi-process Hub uses webhooks.
- **One header per thread.** A Slack thread binds to an agent on its first mention. A later `pr=` header in the same thread is ignored in favour of the alias.
- **GitHub only in the event scope.** `paseo.event.github.number` is the first field. Other providers add fields as a trigger needs them.

## 7. Rollout

1. **Hub.** `paseo.event.<provider>.*` in the parser and the key scope, the null rule, the alias table with alias-aware lookup, and alias deletion on key clear. Ships behind no flag.
2. **Hub, after 1.** The `slack.post` output with alias registration. Optional message-event handling for plain thread replies, gated on the operator's manifest, with the Apps page guidance updated and the shipped manifests unchanged.
3. **Docs.** The multi-event reviewer example with the Slack header form in the Hub trigger docs.
