import assert from "node:assert/strict";
import { parseProjectConfiguration } from "../../configuration/store.js";
import type { ProjectConfigurationRevisionRecord } from "../../db/types.js";
import { describe, it } from "vitest";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  serializeTriggerDocument,
  TriggerDocumentError,
} from "./index.js";

function reportsMissingEvent(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) => path.join(".") === "on" && /at least one event/u.test(message),
    )
  );
}

function reportsUnknownTargetKind(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) =>
        path.join(".") === "run.target.kind" && /expected 'daemon'/iu.test(message),
    )
  );
}

const trigger = `
name: engineering-requests
enabled: true
on:
  slack.mention:
    connection: acme-slack
    filters:
      channels: [engineering]
      from_users: [U0BNGPZEXT2]
  github.issue_comment:
    connection: getpaseo-github
    filters:
      contains: "@paseo-bot"
      from_users: [boudra]
inputs:
  model:
    type: string
    default: codex
    choices: [codex, claude]
run:
  target:
    daemon: devbox
    cwd: /workspace/company
  agent:
    select: \${{ paseo.inputs.model }}
    choices:
      codex:
        provider: codex
        model: gpt-5.6-sol
      claude:
        provider: claude
        model: claude-opus-5
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: getpaseo-github
    repositories: [getpaseo/paseo, getpaseo/hub]
    permissions:
      contents: write
      pull_requests: write
  prompt: |
    Use Paseo when delegation is useful.
    \${{ paseo.prompt }}
  outputs:
    slack.reply:
      max: 5
`;

describe("self-contained trigger documents", () => {
  it("compiles and preserves a configurable startup timeout", () => {
    const yaml = trigger.replace("  max_runtime: 90m", "  max_runtime: 90m\n  startup_timeout: 3m");
    const compiled = compileTriggerDocument(yaml);
    assert.equal(compiled.events[0]?.steps[0]?.startupTimeoutMs, 180_000);
    assert.equal(
      parseTriggerDocument(serializeTriggerDocument(compiled.authored)).run.startup_timeout,
      "3m",
    );
  });

  it.each(["0s", "25h", "invalid"])("rejects invalid startup timeout %s", (duration) => {
    assert.throws(
      () =>
        compileTriggerDocument(
          trigger.replace(
            "  max_runtime: 90m",
            `  max_runtime: 90m\n  startup_timeout: ${duration}`,
          ),
        ),
      /startup_timeout/,
    );
  });

  it("compiles every input event to one launch against the inline target and agent choices", () => {
    const compiled = compileTriggerDocument(trigger);

    assert.equal(compiled.authored.name, "engineering-requests");
    assert.equal(compiled.environment.kind, "daemon");
    assert.equal(compiled.events.length, 2);
    assert.deepEqual(
      compiled.events.map(({ on }) => on),
      ["slack.mention", "github.issue_comment"],
    );
    assert.deepEqual(compiled.events[0]?.steps[0]?.agent, {
      selector: "${{ paseo.inputs.model }}",
      choices: {
        codex: { provider: "codex", model: "gpt-5.6-sol" },
        claude: { provider: "claude", model: "claude-opus-5" },
      },
    });
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
    ]);
    assert.deepEqual(compiled.events[1]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
      { type: "github.reply", required: false },
    ]);
  });

  it("compiles a target without kind to the daemon target", () => {
    const compiled = compileTriggerDocument(trigger);
    assert.deepEqual(compiled.environment, {
      name: "target",
      kind: "daemon",
      daemon: "devbox",
      cwd: "/workspace/company",
    });
  });

  it("compiles an explicit daemon kind identically to an omitted kind", () => {
    const target = `
  target:
    daemon: devbox
    cwd: /workspace/company
    worktree:
      mode: branch-off
      newBranch: hub-work`;
    const implicit = trigger.replace(
      "\n  target:\n    daemon: devbox\n    cwd: /workspace/company",
      target,
    );
    const explicit = implicit.replace("  target:\n", "  target:\n    kind: daemon\n");
    assert.notEqual(explicit, implicit);
    assert.deepEqual(compileTriggerDocument(explicit).environment, {
      name: "target",
      kind: "daemon",
      daemon: "devbox",
      cwd: "/workspace/company",
      worktree: { mode: "branch-off", newBranch: "hub-work" },
    });
    assert.deepEqual(
      compileTriggerDocument(explicit).events,
      compileTriggerDocument(implicit).events,
    );
  });

  it("rejects an unknown target kind", () => {
    assert.throws(
      () => parseTriggerDocument(trigger.replace("  target:\n", "  target:\n    kind: fly\n")),
      reportsUnknownTargetKind,
    );
  });

  it("compiles a sprite target with every field into the environment", () => {
    assert.deepEqual(compileTriggerDocument(spriteTrigger()).environment, {
      name: "target",
      kind: "sprite",
      bootstrap: "npm install -g @getpaseo/cli\n",
      cwd: "/home/sprite/workspace/project",
      memory: 16384,
      env: { ANTHROPIC_API_KEY: "key" },
      worktree: { mode: "branch-off", newBranch: "hub-work", base: "origin/main" },
    });
  });

  it.each([
    [
      "auto_archive false",
      (yaml: string) => `${yaml}  auto_archive: false\n`,
      /run\.auto_archive: Sprite targets always archive/u,
    ],
    [
      "a missing bootstrap",
      (yaml: string) => yaml.replace(/    bootstrap: \|\n.*\n/u, ""),
      /run\.target\.bootstrap: .*expected string/iu,
    ],
    [
      "a relative cwd",
      (yaml: string) => yaml.replace("cwd: /home/sprite/workspace/project", "cwd: workspace"),
      /run\.target\.cwd: must be an absolute path/u,
    ],
    [
      "a non-positive memory",
      (yaml: string) => yaml.replace("memory: 16384", "memory: 0"),
      /run\.target\.memory: .*expected number to be >0/iu,
    ],
  ])("rejects a sprite target with %s", (_name, mutate, expected) => {
    assert.throws(() => parseTriggerDocument(mutate(spriteTrigger())), expected);
  });

  it("round-trips the semantic document through canonical YAML", () => {
    const parsed = parseTriggerDocument(trigger);
    assert.deepEqual(parseTriggerDocument(serializeTriggerDocument(parsed)), parsed);
  });

  it("allows authenticated manual dispatches when no actor filter is authored", () => {
    const compiled = compileTriggerDocument(`
name: deploy
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.filters?.from_users, ["*"]);
    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, []);
  });

  it("automatically grants an unlimited event-native reply for a new conversational trigger", () => {
    const compiled = compileTriggerDocument(`
name: answer
on:
  slack.mention:
    connection: acme-slack
    filters: { from_users: ["*"] }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.steps[0]?.allowOutputs, [
      { type: "slack.reply", required: false },
    ]);
  });

  it("rejects a trigger without events at the document boundary", () => {
    assert.throws(
      () =>
        parseTriggerDocument(`
name: empty
on: {}
run:
  target: { daemon: local, cwd: /workspace }
  agent: { provider: codex }
  prompt: run
`),
      reportsMissingEvent,
    );
  });
});

it("applies the continuation default when reading old trigger revisions without rewriting their evidence", () => {
  const compiled = compileTriggerDocument(trigger);
  const stored = structuredClone({
    environments: [{ ...compiled.environment, daemonId: "daemon" }],
    triggers: compiled.events,
  });
  for (const event of stored.triggers) for (const step of event.steps) delete step.continuation;
  const revision: ProjectConfigurationRevisionRecord = {
    id: "revision",
    projectId: "project",
    organizationId: "org",
    version: 1,
    sourceKind: "manual",
    sourceEvidence: { kind: "organization_trigger_adapter" },
    rawYaml: trigger,
    normalizedConfiguration: stored,
    validationErrors: null,
    contentHash: "original",
    createdByUserId: "user",
    receivedAt: null,
    createdAt: new Date(),
    validatedAt: new Date(),
  };
  const loaded = parseProjectConfiguration(revision);
  assert.deepEqual(loaded.triggers[0]?.steps[0]?.continuation, { mode: "conversation" });
  assert.equal(stored.triggers[0]?.steps[0]?.continuation, undefined);
  const legacy = parseProjectConfiguration({ ...revision, sourceEvidence: { kind: "manual" } });
  assert.equal(legacy.triggers[0]?.steps[0]?.continuation, undefined);
  const migratedLegacy = parseProjectConfiguration({
    ...revision,
    rawYaml: JSON.stringify({
      name: "preserved-workflow",
      legacy_multistep: { trigger: stored.triggers[0], environments: stored.environments },
    }),
  });
  assert.deepEqual(migratedLegacy, legacy);
});

function spriteTrigger(): string {
  return `name: review
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: |
      npm install -g @getpaseo/cli
    cwd: /home/sprite/workspace/project
    memory: 16384
    env:
      ANTHROPIC_API_KEY: key
    worktree:
      mode: branch-off
      newBranch: hub-work
      base: origin/main
  agent: { provider: claude, mode: bypassPermissions }
  prompt: Review it.
`;
}
