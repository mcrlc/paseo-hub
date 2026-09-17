/* oxlint-disable */
// Usage: LOG_LEVEL=silent npx tsx docs/qa/ac-s5g/r5-continuation.ts
// ac-s5g round 5: what an `env` or `memory` edit does to a conversation that is already running on
// the sprite. The guide (L82-84, L91) says the sprite, its filesystem and its daemon identity are
// kept and that these edits are not refused. Both are true. This drives the real AgentSessions
// service across such an edit to show what happens to the agent.
import { randomUUID } from "node:crypto";
import { createMemoryDatabase } from "../../../src/db/memory.js";
import { AgentSessions } from "../../../src/agent-sessions/index.js";
import { OutputExecutorRegistry } from "../../../src/execution-capabilities/outputs.js";
import { compileTriggerDocument } from "../../../src/triggers/configuration/index.js";
import type { LaunchMachineIntent } from "../../../src/dispatcher/launch-machine-intent.js";
import type { AgentConnection } from "../../../src/daemons/agents/index.js";

const yaml = (memory: number, env = "") => `name: pr-reviewer
enabled: true
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: |
      npm install -g @anthropic-ai/claude-code
    cwd: /workspace
    memory: ${String(memory)}${env}
  agent: { provider: claude, mode: bypassPermissions }
  continuation: { mode: conversation }
  prompt: Review the pull request.
  max_runtime: 1h
  idle_timeout: 5m
`;

const database = createMemoryDatabase({ organizationIds: ["org"] });
const project = await database.createProject({
  organizationId: "org",
  name: "runtime",
  slug: "runtime",
  createdByUserId: null,
});
const revision = await database.insertProjectConfigurationRevision({
  projectId: project.id,
  normalizedConfiguration: { version: 1, environments: [], triggers: [] },
  contentHash: "hash",
  sourceKind: "manual",
  sourceEvidence: {},
  createdByUserId: null,
});

const agents = new Map<string, { id: string; workspaceId: string; status: string }>();
const connection: AgentConnection = {
  async create(key) {
    const agent = { id: `agent-${agents.size + 1}`, workspaceId: `ws-${key}`, status: "running" };
    agents.set(agent.id, agent);
    return { ...agent, archivedAt: null } as never;
  },
  async get(agentId) {
    return { ...agents.get(agentId)!, archivedAt: null } as never;
  },
  async send() {},
  async restore() {
    return true;
  },
  async control() {},
  async watch() {
    return () => {};
  },
};

// The compatibility payload is exactly what `buildStepIntent` builds
// (src/workflows/engine.ts:1046-1056): { agent, target: <the compiled environment>, env, github }.
const intentFor = async (memory: number, env = "") => {
  const compiled = compileTriggerDocument(yaml(memory, env));
  const step = compiled.events[0]!.steps[0]!;
  const execution = await database.insertAgentExecution({
    organizationId: "org",
    projectId: project.id,
    machineId: null,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: revision.id,
  });
  const intent: LaunchMachineIntent = {
    kind: "launch_machine",
    organizationId: "org",
    projectId: project.id,
    triggerRunId: randomUUID(),
    triggerName: "pr-reviewer",
    environmentName: "target",
    environment: {
      kind: "daemon",
      daemonId: "daemon-sprite",
      machineId: "machine-sprite",
      authoredSlug: "target",
      cwd: compiled.environment.cwd,
    },
    prompt: "Review the pull request.",
    agent: step.agent as never,
    allowOutputs: [],
    autoArchive: true,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: revision.id,
    hubConfig: {},
    continuation: {
      key: JSON.stringify(["github", "repo-1", 42]),
      compatibility: {
        agent: step.agent,
        target: compiled.environment,
        env: {},
        github: null,
      },
    },
  };
  return { executionId: execution.id, intent };
};

const sessions = new AgentSessions(
  database,
  "secret",
  "https://hub.test",
  new OutputExecutorRegistry(),
);
const dispatch = async (memory: number, env = "") => {
  const { executionId, intent } = await intentFor(memory, env);
  try {
    const result = await sessions.dispatch({
      executionId,
      intent,
      connection,
      createOptions: async () => ({ cwd: "/workspace", agent: { provider: "claude" } }) as never,
      onEvent: () => {},
    });
    return `ok: action=${result.action} agent=${result.agentId}`;
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
};

console.log("ac-s5g round 5: continuation across an `env` or `memory` edit");
console.log(`first event, memory 16384:                 ${await dispatch(16384)}`);
console.log(`second event, same conversation, unchanged: ${await dispatch(16384)}`);
console.log(`third event after the memory edit to 4096:  ${await dispatch(4096)}`);
console.log(`fourth event, memory back at 16384:        ${await dispatch(16384)}`);
console.log(
  `fifth event after adding env REGION: eu:        ${await dispatch(16384, "\n    env:\n      REGION: eu")}`,
);
