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
import { createLogger } from "../../logger.js";
import { FailureLogStream } from "../../test-utils/failure-logs.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import { parseInvocation } from "../../triggers/invocation.js";
import type { AcceptedTriggerProviderMatch, TriggerProvider } from "../../triggers/index.js";
import { createDurableWorkflowHandler } from "../../workflows/engine.js";
import { createDaemonDispatchLifecycle, type DaemonDispatchLifecycle } from "../lifecycle.js";
import type { DaemonConnection } from "../protocol.js";
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
    const executionId = hub.dispatches[0]!.executionId;
    assert.deepEqual(hub.sequence, [`hold:${executionId}`, `dispatch:${executionId}`]);
    assert.deepEqual(hub.providerCalls, [
      { call: "hold", sprite: hub.spriteName, task: executionId, expire: "60m" },
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
    const runId = await hub.startRun();

    await hub.claim(3);

    assert.equal((await hub.database.findMachineById(hub.machineId))?.status, "spawning");
    assert.deepEqual(hub.providerCalls, []);
    assert.equal(hub.dispatches.length, 0);
    assert.equal(hub.activations, 0);
    assert.equal(await hub.runStatus(runId), "running");
  });

  it("defers an alive sprite whose daemon has not enrolled without reaching the provider", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.database.transitionMachine(hub.machineId, "alive");
    const runId = await hub.startRun();

    await hub.claim(3);

    assert.deepEqual(hub.providerCalls, []);
    assert.equal(hub.dispatches.length, 0);
    assert.equal(await hub.runStatus(runId), "running");
  });

  it("recreates a terminated sprite once and defers", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.database.transitionMachine(hub.machineId, "terminated", { reason: "gone" });
    const runId = await hub.startRun();

    await hub.claim(3);

    assert.equal(hub.activations, 1);
    assert.equal(hub.dispatches.length, 0);
    assert.deepEqual(hub.providerCalls, []);
    assert.equal(await hub.runStatus(runId), "running");
  });

  it("fails the run as sprite_unavailable when the recreated sprite terminates again", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.database.transitionMachine(hub.machineId, "terminated", { reason: "gone" });
    const runId = await hub.startRun();

    await hub.claim(1);
    assert.equal(hub.activations, 1);
    await hub.database.transitionMachine(hub.machineId, "terminated", { reason: "bootstrap" });
    await hub.claim(1);

    assert.equal(hub.activations, 1);
    assert.equal(await hub.runStatus(runId), "failed");
    assert.equal(await hub.runFailure(runId), "sprite_unavailable");
    assert.equal(hub.dispatches.length, 0);
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
    assert.equal(hub.activations, 1);
  });

  it("releases the hold only after the archive completes", async () => {
    const hub = await setup();
    const control = hub.connectDaemon();
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;
    await hub.agentFinished(executionId);

    const completion = hub.complete(executionId);
    await control.called;
    assert.equal(hub.sequence.includes(`release:${executionId}`), false);
    control.resolve();
    await completion;

    assert.deepEqual(hub.sequence.slice(-2), [
      `control:archive:${executionId}`,
      `release:${executionId}`,
    ]);
    const execution = await hub.database.findAgentExecutionById(executionId);
    assert.equal(execution?.status, "succeeded");
    assert.notEqual(execution?.hubActionCompletedAt, null);
  });

  it("releases the hold at the end of the archive attempt when the daemon is offline", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;
    await hub.agentFinished(executionId);

    await hub.complete(executionId);

    assert.equal(hub.sequence.at(-1), `release:${executionId}`);
    const execution = await hub.database.findAgentExecutionById(executionId);
    assert.equal(execution?.status, "succeeded");
    assert.equal(execution?.hubActionCompletedAt, null);
  });

  it("releases the hold after the archive attempt when an execution fails", async () => {
    const hub = await setup();
    const control = hub.connectDaemon();
    control.resolve();
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;
    await hub.agentFinished(executionId);

    await hub.lifecycle.failPendingExecutionsForDisconnectedMachine(
      hub.machineId,
      "daemon_revoked",
    );

    assert.deepEqual(hub.sequence.slice(-2), [
      `control:archive:${executionId}`,
      `release:${executionId}`,
    ]);
    assert.equal((await hub.database.findAgentExecutionById(executionId))?.status, "failed");
  });

  it("holds and releases each of two concurrent executions under its own task", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.startRun();

    await hub.claim(3);
    const [first, second] = hub.dispatches;
    assert.ok(first && second);
    assert.notEqual(first.executionId, second.executionId);
    await hub.lifecycle.failPendingExecutionsForDisconnectedMachine(
      hub.machineId,
      "daemon_revoked",
    );

    const tasks = (call: string) =>
      new Set(hub.providerCalls.filter((item) => item.call === call).map(({ task }) => task));
    const expected = new Set([first.executionId, second.executionId]);
    assert.deepEqual(tasks("hold"), expected);
    assert.deepEqual(tasks("release"), expected);
    assert.equal(hub.providerCalls.length, 4);
  });

  it("reports a failed release and still completes the terminal transition", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    hub.releaseFails = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;

    await hub.lifecycle.failPendingExecutionsForDisconnectedMachine(
      hub.machineId,
      "daemon_revoked",
    );

    assert.equal((await hub.database.findAgentExecutionById(executionId))?.status, "failed");
    const failures = hub.logs
      .records()
      .filter((record) => record["operation"] === "sprites.release");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!["level"], 50);
  });

  it("refreshes a running execution's hold on every tick and stops once it is terminal", async () => {
    const hub = await setup({ spriteHoldRefreshIntervalMs: 5 });
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;

    await hub.lifecycle.recoverSprites();
    await waitFor(() => hub.holds(executionId) >= 3);

    await hub.agentFinished(executionId);
    await hub.complete(executionId);
    const held = hub.holds(executionId);
    await delay(30);

    assert.equal(hub.holds(executionId), held);
    await hub.lifecycle.stop();
  });

  it("reports a failed refresh and refreshes again on the next tick", async () => {
    const hub = await setup({ spriteHoldRefreshIntervalMs: 5 });
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;

    hub.holdFails = true;
    await hub.lifecycle.recoverSprites();
    await waitFor(() => hub.failures("sprites.hold-refresh").length >= 1);
    hub.holdFails = false;
    const attempted = hub.holds(executionId);
    await waitFor(() => hub.heldTimes(executionId) >= 2);

    assert.ok(hub.holds(executionId) > attempted);
    assert.equal((await hub.database.findMachineById(hub.machineId))?.status, "alive");
    await hub.lifecycle.stop();
  });

  it("re-holds an active execution on restart and leaves the next dispatch alone", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;
    assert.equal(hub.holds(executionId), 1);

    await hub.restart();
    await hub.lifecycle.recoverSprites();
    assert.deepEqual(hub.providerCalls.at(-1), {
      call: "hold",
      sprite: hub.spriteName,
      task: executionId,
      expire: "60m",
    });
    assert.equal(hub.holds(executionId), 2);

    const readiness = await hub.prepareSpriteDispatch(executionId);

    assert.equal(readiness.status, "ready");
    assert.equal(hub.holds(executionId), 2);
    await hub.lifecycle.stop();
  });

  it("skips an execution with no machine and one whose sprite is not alive", async () => {
    const hub = await setup();
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const { environment, ...intent } = hub.dispatches[0]!.intent;
    const { machineId: _machineId, ...unmachined } = environment;
    await hub.database.insertAgentExecution({
      organizationId: "org",
      projectId: intent.projectId,
      machineId: null,
      triggerContext: intent.triggerContext,
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: { ...intent, environment: unmachined },
    });
    await hub.database.transitionMachine(hub.machineId, "terminated", { reason: "gone" });
    const calls = hub.providerCalls.length;

    await hub.lifecycle.recoverSprites();

    assert.equal(hub.providerCalls.length, calls);
    await hub.lifecycle.stop();
  });

  it("stops refreshing once the lifecycle stops", async () => {
    const hub = await setup({ spriteHoldRefreshIntervalMs: 5 });
    hub.socketOpen = true;
    await hub.enrollSprite();
    await hub.startRun();
    await hub.claim(1);
    const executionId = hub.dispatches[0]!.executionId;
    await hub.lifecycle.recoverSprites();
    await waitFor(() => hub.holds(executionId) >= 3);

    await hub.lifecycle.stop();
    const held = hub.holds(executionId);
    await delay(30);

    assert.equal(hub.holds(executionId), held);
  });

  it("marks a spawning sprite alive on restart when its daemon enrolled", async () => {
    const hub = await setup();
    await hub.enrollSprite();
    await hub.database.transitionMachine(hub.machineId, "spawning");

    await hub.restart();
    await hub.lifecycle.recoverSprites();

    assert.equal((await hub.database.findMachineById(hub.machineId))?.status, "alive");
    assert.deepEqual(hub.revokedApiKeys, []);
    assert.deepEqual(hub.destroyed, []);
    await hub.lifecycle.stop();
  });

  it("terminates a spawning sprite on restart when no daemon enrolled", async () => {
    const hub = await setup();

    await hub.restart();
    await hub.lifecycle.recoverSprites();

    const machine = await hub.database.findMachineById(hub.machineId);
    assert.equal(machine?.status, "terminated");
    assert.equal(machine?.shutdownReason, "hub restarted during activation");
    assert.deepEqual(hub.revokedApiKeys, [hub.apiKeyId]);
    assert.deepEqual(hub.destroyed, [hub.spriteName]);
    await hub.lifecycle.stop();
  });
});

async function waitFor(observation: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!observation()) {
    if (Date.now() > deadline) throw new Error("observation did not happen in time");
    await delay(2);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setup(test: { spriteHoldRefreshIntervalMs?: number } = {}) {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  const entitlements = new EntitlementsService(database, { seats: async () => 0 });
  await entitlements.stamp("org", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
  await database.upsertOrganizationSpritesConfiguration({
    organizationId: "org",
    token: "sprites-token",
    memoryMb: 8192,
    updatedByUserId: null,
  });
  const logs = new FailureLogStream();
  const providerCalls: Array<{ call: string; sprite: string; task: string; expire?: string }> = [];
  const dispatches: Array<{ executionId: string; intent: LaunchMachineIntent }> = [];
  const sequence: string[] = [];
  const activation: SpriteActivation = async ({ trigger }) => {
    state.activations += 1;
    if (state.activationFails) throw new Error("Sprites are not configured");
    state.apiKeyId = `key-${randomUUID()}`;
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
  function createLifecycle(): DaemonDispatchLifecycle {
    return createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => state.connection,
      publicBaseUrl: "https://hub.test",
      completionTokenSecret: SECRET,
      spriteActivation: activation,
      spriteApiKeys: {
        async revoke(_organizationId, id) {
          state.revokedApiKeys.push(id);
          return true;
        },
      },
      spriteProvider: (token) => {
        assert.equal(token, "sprites-token");
        return {
          async hold(sprite, task, expire) {
            providerCalls.push({ call: "hold", sprite, task, expire });
            if (state.holdFails) throw new SpritesError(503, "unavailable");
            sequence.push(`hold:${task}`);
          },
          async release(sprite, task) {
            providerCalls.push({ call: "release", sprite, task });
            if (state.releaseFails) throw new SpritesError(500, "release failed");
            sequence.push(`release:${task}`);
          },
          async destroy(sprite) {
            state.destroyed.push(sprite);
          },
        };
      },
      test: { logger: createLogger(logs), ...test },
    });
  }
  const state = {
    socketOpen: false,
    activationFails: false,
    holdFails: false,
    releaseFails: false,
    activations: 0,
    machineId: "",
    apiKeyId: "",
    daemonId: "",
    connection: undefined as DaemonConnection | undefined,
    lifecycle: createLifecycle(),
    revokedApiKeys: [] as string[],
    destroyed: [] as string[],
  };
  const trigger = await new OrganizationTriggerStore(
    database,
    "org",
    entitlements,
    activation,
  ).save({ yaml: spriteYaml, userId: null });
  state.activations = 0;
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
    prepareSpriteDispatch: (input) => state.lifecycle.prepareSpriteDispatch(input),
    dispatchLaunchMachineIntent: async (intent) => {
      const execution = await database.findAgentExecutionByWorkflowStepRunId(
        intent.workflowStepRunId!,
      );
      assert.ok(execution);
      sequence.push(`dispatch:${execution.id}`);
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
  return Object.assign(state, {
    database,
    logs,
    providerCalls,
    dispatches,
    sequence,
    spriteName: `trigger-${trigger.id}`,
    connectDaemon() {
      state.socketOpen = true;
      let resolve!: () => void;
      let markCalled!: () => void;
      const released = new Promise<void>((done) => {
        resolve = done;
      });
      const called = new Promise<void>((done) => {
        markCalled = done;
      });
      const unused = async (): Promise<never> => {
        throw new Error("not used");
      };
      state.connection = {
        agents: {
          create: unused,
          get: unused,
          send: unused,
          restore: unused,
          watch: unused,
          async control(agentId, _workspaceId, action) {
            markCalled();
            await released;
            sequence.push(`control:${action}:${agentId}`);
          },
        },
        getProviderSnapshot: unused,
        refreshProviderSnapshot: unused,
      };
      return { called, resolve };
    },
    async enrollSprite() {
      await database.issueEnrollmentToken({
        id: randomUUID(),
        verifier: "sprite-token",
        organizationId: "org",
        issuedByApiKeyId: state.apiKeyId,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        consumedAt: null,
      });
      await database.enrollDaemon({
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
      assert.ok(daemon);
      state.daemonId = daemon.id;
    },
    async agentFinished(executionId: string) {
      const sessionId = randomUUID();
      await database.saveAgentSession({
        id: sessionId,
        organizationId: "org",
        projectId: trigger.runtimeProjectId,
        continuationKey: null,
        daemonId: state.daemonId,
        agentId: executionId,
        workspaceId: "workspace",
        compatibility: "test",
        capabilityTokenHash: "test",
        tools: [],
        creationOptions: {
          provider: "test",
          cwd: "/workspace",
          env: {},
          toolPolicy: { preapproved: [] },
        },
      });
      await database.attachExecutionToSession(executionId, sessionId);
      const observedAt = new Date();
      await database.recordAgentExecutionHubAcknowledgement(executionId, {
        kind: "finish_execution",
        callId: "finish",
        status: "completed",
        observedAt,
      });
      await database.recordAgentExecutionHubAcknowledgement(executionId, {
        kind: "terminal",
        observedAt,
      });
      await database.recordAgentExecutionHubAcknowledgement(executionId, {
        kind: "idle",
        observedAt,
      });
    },
    heldTimes(executionId: string) {
      return sequence.filter((entry) => entry === `hold:${executionId}`).length;
    },
    holds(executionId: string) {
      return providerCalls.filter((call) => call.call === "hold" && call.task === executionId)
        .length;
    },
    failures(operation: string) {
      return logs.records().filter((record) => record["operation"] === operation);
    },
    prepareSpriteDispatch(executionId: string) {
      const target = configuration.environments.find(
        (environment) => environment.kind === "sprite",
      );
      assert.ok(target?.kind === "sprite");
      return state.lifecycle.prepareSpriteDispatch({
        organizationId: "org",
        projectId: trigger.runtimeProjectId,
        executionId,
        target,
      });
    },
    async restart() {
      await state.lifecycle.stop();
      state.lifecycle = createLifecycle();
    },
    complete(executionId: string) {
      return state.lifecycle.completeAgentExecutionFromCallback(
        { executionId, token: deriveAgentExecutionCompletionToken(SECRET, executionId) },
        { deferHubAction: true },
      );
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
  auto_archive: true
`;
