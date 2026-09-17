import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../../agent-executions/completion-token.js";
import { parseCompiledHubConfig } from "../../config/compiler.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { AgentExecutionRecord } from "../../db/types.js";
import type { LaunchMachineIntent } from "../../dispatcher/launch-machine-intent.js";
import { UNLIMITED_TEMPLATE } from "../../entitlements/catalog.js";
import { EntitlementsService } from "../../entitlements/service.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import { parseInvocation } from "../../triggers/invocation.js";
import type { AcceptedTriggerProviderMatch, TriggerProvider } from "../../triggers/index.js";
import { createDurableWorkflowHandler } from "../../workflows/engine.js";
import { createDaemonDispatchLifecycle } from "../lifecycle.js";
import type { SpriteActivation } from "./activation.js";
import { SpritesError } from "./client.js";

const SECRET = "sprite-dispatch-secret";

describe("sprite dispatch", () => {
  it("holds an awake sprite before handing off", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.enrollSprite();
    const runId = await hub.startRun();

    await hub.claim(5);

    assert.equal(hub.dispatches.length, 1);
    assert.deepEqual(hub.providerCalls, [
      { call: "hold", sprite: hub.spriteName, task: hub.dispatches[0]!.executionId, expire: "60m" },
    ]);
    const environment = hub.dispatches[0]!.intent.environment;
    assert.equal(environment.machineId, hub.machineId);
    assert.equal(environment.daemonId, hub.daemonId);
    assert.equal(await hub.runStatus(runId), "running");
  });

  it("holds, defers while the socket is closed, and hands off once the daemon reconnects", async () => {
    const hub = await setup();
    await hub.enrollSprite();
    await hub.startRun();

    await hub.claim(3);
    assert.equal(hub.dispatches.length, 0);
    assert.equal(hub.providerCalls.length, 1);

    hub.socketOpen = true;
    await hub.claim(2);

    assert.equal(hub.dispatches.length, 1);
    assert.deepEqual(
      hub.providerCalls.map(({ call }) => call),
      ["hold"],
    );
  });

  it("defers a spawning sprite without reaching the provider", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.startRun();

    await hub.claim(3);

    assert.equal((await hub.database.findMachineById(hub.machineId))?.status, "spawning");
    assert.deepEqual(hub.providerCalls, []);
    assert.equal(hub.dispatches.length, 0);
    assert.equal(hub.activations, 1);
  });

  it("recreates a terminated sprite once and defers", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.database.transitionMachine(hub.machineId, "terminated", { reason: "gone" });
    const runId = await hub.startRun();

    await hub.claim(3);

    assert.equal(hub.activations, 2);
    assert.equal(hub.dispatches.length, 0);
    assert.deepEqual(hub.providerCalls, []);
    assert.equal(await hub.runStatus(runId), "running");
  });

  it("fails the run as sprite_unavailable when recreation fails", async () => {
    const hub = await setup();
    await hub.database.transitionMachine(hub.machineId, "terminated", { reason: "gone" });
    hub.activationFails = true;
    const runId = await hub.startRun();

    await hub.claim(2);

    assert.equal(await hub.runStatus(runId), "failed");
    assert.equal(await hub.runFailure(runId), "sprite_unavailable");
    assert.equal(hub.dispatches.length, 0);
  });

  it("terminates the machine and defers when hold fails, so the next claim recreates", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.enrollSprite();
    hub.holdFails = true;
    await hub.startRun();

    await hub.claim(1);
    const machine = await hub.database.findMachineById(hub.machineId);
    assert.equal(machine?.status, "terminated");
    assert.equal(machine?.shutdownReason, "Sprites API 503: unavailable");
    assert.equal(hub.dispatches.length, 0);

    await hub.claim(1);
    assert.equal(hub.activations, 2);
  });

  it("releases the hold once when an execution succeeds and once when one fails", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.startRun();

    await hub.claim(3);

    const [first, second] = hub.dispatches;
    assert.ok(first && second);
    assert.notEqual(first.executionId, second.executionId);
    assert.deepEqual(
      new Set(hub.providerCalls.map(({ call, task }) => `${call}:${task}`)),
      new Set([`hold:${first.executionId}`, `hold:${second.executionId}`]),
    );
    assert.equal(hub.providerCalls.length, 2);

    await hub.lifecycle.completeAgentExecutionFromCallback({
      executionId: first.executionId,
      token: deriveAgentExecutionCompletionToken(SECRET, first.executionId),
    });
    await hub.lifecycle.failPendingExecutionsForDisconnectedMachine(
      hub.machineId,
      "daemon_revoked",
    );

    assert.deepEqual(
      hub.providerCalls.filter(({ call }) => call === "release").map(({ task }) => task),
      [first.executionId, second.executionId],
    );
    await hub.lifecycle.stop();
  });
});

async function setup() {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  const entitlements = new EntitlementsService(database, { seats: async () => 0 });
  await entitlements.stamp("org", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
  await database.upsertOrganizationSpritesConfiguration({
    organizationId: "org",
    token: "sprites-token",
    memoryMb: 8192,
    updatedByUserId: null,
  });
  const providerCalls: Array<{ call: string; sprite: string; task: string; expire?: string }> = [];
  const dispatches: Array<{ executionId: string; intent: LaunchMachineIntent }> = [];
  const state = {
    socketOpen: false,
    activationFails: false,
    holdFails: false,
    activations: 0,
    machineId: "",
    apiKeyId: "",
  };
  const activation: SpriteActivation = async ({ trigger }) => {
    state.activations += 1;
    if (state.activationFails) throw new Error("Sprites are not configured");
    state.apiKeyId = `key-${state.activations}`;
    const machine = await database.insertSpriteMachine({
      orgId: trigger.organizationId,
      source: {
        kind: "sprite",
        triggerId: trigger.id,
        spriteName: `trigger-${trigger.id}`,
        apiKeyId: state.apiKeyId,
      },
      specs: null,
    });
    if (machine !== undefined) state.machineId = machine.id;
    return { job: Promise.resolve() };
  };
  const lifecycle = createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: () => undefined,
    publicBaseUrl: "https://hub.test",
    completionTokenSecret: SECRET,
    spriteActivation: activation,
    spriteProvider: (token) => {
      assert.equal(token, "sprites-token");
      return {
        async hold(sprite, task, expire) {
          providerCalls.push({ call: "hold", sprite, task, expire });
          if (state.holdFails) throw new SpritesError(503, "unavailable");
        },
        async release(sprite, task) {
          providerCalls.push({ call: "release", sprite, task });
        },
      };
    },
  });
  const trigger = await new OrganizationTriggerStore(
    database,
    "org",
    entitlements,
    activation,
  ).save({ yaml: spriteYaml, userId: null });
  const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
  assert.ok(revision);
  const configuration = parseCompiledHubConfig(revision.normalizedConfiguration);
  const provider = {
    name: "manual",
    eventNames: ["manual.run"] as const,
    async match(): Promise<readonly AcceptedTriggerProviderMatch[]> {
      const configured = configuration.triggers[0]!;
      const invocation = parseInvocation("", configured.inputs);
      if (invocation.status !== "accepted") throw new Error("invocation rejected");
      return [
        {
          triggerName: configured.name,
          triggerContext: { provider: "manual" },
          outputContext: { provider: "manual" },
          configurationRevisionId: revision.id,
          hubConfig: configuration,
          conversation: null,
          invocation,
        },
      ];
    },
  } satisfies TriggerProvider;
  const { handler, engine } = createDurableWorkflowHandler({
    database,
    entitlements,
    providers: [provider],
    canDispatchToDaemon: () => state.socketOpen,
    prepareSpriteDispatch: (input) => lifecycle.prepareSpriteDispatch(input),
    dispatchLaunchMachineIntent: async (intent) => {
      const execution = await database.findAgentExecutionByWorkflowStepRunId(
        intent.workflowStepRunId!,
      );
      assert.ok(execution);
      dispatches.push({ executionId: execution.id, intent });
      const prepared: AgentExecutionRecord = await database.prepareAgentExecutionForDispatch(
        execution.id,
        intent.environment.daemonId,
        intent.environment.machineId!,
        hashAgentExecutionCompletionToken(
          deriveAgentExecutionCompletionToken(SECRET, execution.id),
        ),
      );
      return { execution: prepared };
    },
  });
  const hub = Object.assign(state, {
    database,
    lifecycle,
    providerCalls,
    dispatches,
    daemonId: "",
    spriteName: `trigger-${trigger.id}`,
    async enrollSprite() {
      await database.issueEnrollmentToken({
        id: randomUUID(),
        verifier: "sprite-token",
        organizationId: "org",
        issuedByApiKeyId: state.apiKeyId,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        consumedAt: null,
      });
      const enrolled = await database.enrollDaemon({
        daemonId: randomUUID(),
        idempotencyKey: randomUUID(),
        tokenVerifier: "sprite-token",
        serverId: "sprite-server",
        daemonPublicKey: "public-key",
        credentialVerifier: "credential-verifier",
        permissions: ["hub.execute"],
        now: new Date(),
      });
      const daemon = await database.findDaemonByMachineId(state.machineId);
      assert.ok(daemon, JSON.stringify(enrolled));
      hub.daemonId = daemon.id;
    },
    async startRun() {
      const receipt = await database.persistManualEvent({
        organizationId: "org",
        projectId: trigger.runtimeProjectId,
        deliveryId: randomUUID(),
        source: "manual.run",
        payload: {},
        receivedAt: new Date(),
      });
      if (receipt.status !== "accepted") throw new Error("receipt was not accepted");
      await handler({
        providerEventReceiptId: receipt.event.providerEventReceiptId,
        organizationId: "org",
        projectId: trigger.runtimeProjectId,
        configurationRevisionId: revision.id,
        source: "manual.run",
        deliveryId: receipt.event.deliveryId,
        payload: {},
        receivedAt: new Date(),
        connectionId: null,
        resourceId: null,
      });
      const [run] = await database.findTriggerRunsByProviderEventReceiptId(
        receipt.event.providerEventReceiptId,
      );
      assert.ok(run);
      return run.id;
    },
    async claim(times: number) {
      for (let index = 0; index < times; index += 1) await engine.processAvailable();
    },
    async runStatus(runId: string) {
      return (await database.findTriggerRunById(runId))?.status;
    },
    async runFailure(runId: string) {
      const run = await database.findTriggerRunById(runId);
      return run?.outcome === "accepted" ? run.failureReason : undefined;
    },
  });
  return hub;
}

const spriteYaml = `name: sprite-task
enabled: true
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: echo ready
    cwd: /workspace
  agent: { provider: test, mode: full-access }
  prompt: Handle it
  max_runtime: 1h
  idle_timeout: 5m
`;
