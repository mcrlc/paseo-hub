import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import type { DaemonRecord } from "./types.js";

describe("machine model database contract", () => {
  it("inserts, selects, and transitions machines and agent executions", async () => {
    const database = createMemoryDatabase();
    const triggerContext = { provider: "manual", deliveryId: "delivery-1" };

    const machine = await database.insertMachine({
      orgId: "org-1",
      source: { kind: "daemon", daemonId: "mob-hetzner" },
      status: "alive",
      triggerName: null,
      triggerContext,
      specs: { os: "linux" },
    });

    assert.equal(machine.status, "alive");
    assert.deepEqual(await database.findMachineById(machine.id), machine);

    const executionId = randomUUID();
    const execution = await database.insertAgentExecution({
      id: executionId,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: machine.id,
      triggerContext,
      outputContext: triggerContext,
      configurationRevisionId: "config-version-1",
    });

    assert.equal(execution.status, "spawning");
    assert.equal(execution.id, executionId);
    assert.deepEqual(execution.triggerContext, triggerContext);
    assert.deepEqual(execution.outputContext, triggerContext);

    const running = await database.transitionAgentExecution(execution.id, "running");
    assert.equal(running.transitioned, true);
    assert.equal(running.execution.status, "running");
    assert.equal(running.execution.completedAt, null);

    const succeeded = await database.transitionAgentExecution(execution.id, "succeeded", {
      result: { summary: "done" },
    });
    assert.equal(succeeded.transitioned, true);
    assert.equal(succeeded.execution.status, "succeeded");
    assert.notEqual(succeeded.execution.completedAt, null);
    assert.deepEqual(succeeded.execution.result, { summary: "done" });

    const terminated = await database.transitionMachine(machine.id, "terminated", {
      reason: "daemon_disconnected",
    });
    assert.equal(terminated.status, "terminated");
    assert.equal(terminated.shutdownReason, "daemon_disconnected");
    assert.notEqual(terminated.terminatedAt, null);
  });

  it("does not overwrite terminal agent executions", async () => {
    const database = createMemoryDatabase();
    const machine = await database.insertMachine({
      orgId: "org-1",
      source: { kind: "daemon", daemonId: "mob-hetzner" },
      status: "alive",
    });
    const execution = await database.insertAgentExecution({
      organizationId: "org-1",
      projectId: "project-1",
      machineId: machine.id,
      triggerContext: null,
      outputContext: null,
      configurationRevisionId: "config-version-1",
    });

    const failed = await database.transitionAgentExecution(execution.id, "failed", {
      result: { status: "failed", reason: "daemon_disconnected" },
    });
    const succeeded = await database.transitionAgentExecution(execution.id, "succeeded", {
      result: { status: "succeeded" },
    });

    assert.equal(failed.transitioned, true);
    assert.equal(succeeded.transitioned, false);
    assert.equal(succeeded.execution.status, "failed");
    assert.deepEqual(succeeded.execution.result, {
      status: "failed",
      reason: "daemon_disconnected",
    });
  });

  it("names a sprite daemon after its trigger, suffixing a slug the organization already uses", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    const store = new OrganizationTriggerStore(database, "org");
    const devbox = await enrollDaemon(database, { daemonId: "daemon-devbox", slug: "devbox" });
    const underscored = await store.save({ yaml: triggerYaml("nightly_deploy"), userId: null });
    const dashed = await store.save({ yaml: triggerYaml("nightly-deploy"), userId: null });
    await insertSpriteMachine(database, underscored.id, "key-1");
    const first = await enrollDaemon(database, {
      daemonId: "daemon-sprite-one",
      slug: "trigger-host",
      apiKeyId: "key-1",
    });
    await insertSpriteMachine(database, dashed.id, "key-2");
    const second = await enrollDaemon(database, {
      daemonId: "daemon-sprite-two",
      slug: "trigger-host",
      apiKeyId: "key-2",
    });

    assert.equal(devbox.slug, "devbox");
    assert.equal(first.slug, "nightly-deploy");
    assert.equal(second.slug, `nightly-deploy-${second.id.slice(0, 8)}`);
  });
});

function triggerYaml(name: string): string {
  return `name: ${name}
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: test, mode: full-access }
  prompt: Handle it
  max_runtime: 1h
  idle_timeout: 5m
`;
}

async function insertSpriteMachine(
  database: ReturnType<typeof createMemoryDatabase>,
  triggerId: string,
  apiKeyId: string,
): Promise<void> {
  await database.insertSpriteMachine({
    orgId: "org",
    source: { kind: "sprite", triggerId, spriteName: `trigger-${triggerId}`, apiKeyId },
    specs: null,
  });
}

async function enrollDaemon(
  database: ReturnType<typeof createMemoryDatabase>,
  input: { daemonId: string; slug: string; apiKeyId?: string },
): Promise<DaemonRecord> {
  const verifier = `${input.daemonId}-verifier`;
  await database.issueEnrollmentToken({
    id: verifier,
    verifier,
    organizationId: "org",
    issuedByApiKeyId: input.apiKeyId ?? null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    consumedAt: null,
  });
  const enrolled = await database.enrollDaemon({
    daemonId: input.daemonId,
    idempotencyKey: `${input.daemonId}-key`,
    suggestedSlug: input.slug,
    tokenVerifier: verifier,
    serverId: "server",
    daemonPublicKey: "public-key",
    credentialVerifier: `${input.daemonId}-credential`,
    permissions: ["hub.execute"],
    now: new Date("2026-09-17T00:00:00.000Z"),
  });
  assert.ok(enrolled !== undefined && enrolled.status !== "slug_conflict");
  return enrolled;
}
