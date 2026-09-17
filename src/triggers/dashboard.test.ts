import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { UNLIMITED_TEMPLATE } from "../entitlements/catalog.js";
import { EntitlementsService } from "../entitlements/service.js";
import { createSpriteActivation, type SpriteProvider } from "../daemons/sprites/activation.js";
import { projectCommandErrorCode } from "../projects/command-error.js";
import { TriggerDashboard } from "./dashboard.js";
import { OrganizationTriggerStore } from "./store.js";

describe("trigger dashboard read model", () => {
  it("describes the provider and latest run on the organization trigger list", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "owner",
        },
      ],
    });
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(database, "org-1").save({
      yaml: triggerYaml,
      userId: "user-1",
    });
    const dashboard = new TriggerDashboard(database, accountAuth(), null);
    const request = new Request("https://hub.test/o/acme/triggers");

    const before = await dashboard.snapshot(request, "acme");
    assert.equal(before.triggers[0]?.provider, "manual");
    assert.equal(before.triggers[0]?.event, "manual.run");
    assert.equal(before.triggers[0]?.lastTriggered, null);

    const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(revision);
    const receivedAt = new Date("2026-08-30T09:30:00.000Z");
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      deliveryId: "dashboard-manual-run",
      source: "manual.run",
      payload: {},
      receivedAt,
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") return;
    await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "manual-task",
      prompt: "run it",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date("2026-08-30T10:30:00.000Z"),
      stepIds: ["run"],
    });

    const after = await dashboard.snapshot(request, "acme");
    assert.deepEqual(after.triggers[0]?.lastTriggered, {
      status: "running",
      receivedAt: receivedAt.toISOString(),
    });
  });
});

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: test, mode: full-access }
  prompt: Handle it
`;

function accountAuth(userId = "user-1"): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: `session-${userId}`, activeOrganizationId: "org-1" },
        account: { id: userId, name: "User", email: `${userId}@example.test` },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}

describe("sprite triggers on the dashboard", () => {
  it("summarises the live sprite and recreates it once it is idle", async () => {
    const hub = await spriteHub();
    const trigger = await hub.store.save({ yaml: spriteYaml, userId: "user-1" });
    await hub.settled();
    const [machine] = await hub.database.listOrganizationSprites("org-1");
    assert.ok(machine);

    const before = await hub.dashboard.snapshot(hub.request, "acme");
    assert.deepEqual(before.triggers[0]?.sprite, {
      status: "alive",
      name: `trigger-${trigger.id}`,
      memoryMb: 16384,
      lastRunAt: null,
    });

    await hub.dashboard.recreateSprite(hub.request, "acme", trigger.id);

    const after = await hub.dashboard.snapshot(hub.request, "acme");
    assert.equal(after.triggers[0]?.sprite?.status, "terminated");
    assert.equal(await hub.database.findLiveSpriteMachine(trigger.id), undefined);
    assert.equal((await hub.database.findDaemonByMachineId(machine.machine.id))?.status, "revoked");
    assert.equal(
      (await hub.database.findMachineById(machine.machine.id))?.shutdownReason,
      "recreated from the dashboard",
    );
  });

  it("refuses a member, who cannot manage the organization's resources", async () => {
    const hub = await spriteHub();
    const trigger = await hub.store.save({ yaml: spriteYaml, userId: "user-1" });
    await hub.settled();

    await assert.rejects(
      hub.memberDashboard.recreateSprite(hub.request, "acme", trigger.id),
      (error: unknown) => projectCommandErrorCode(error) === "forbidden",
    );
    assert.equal((await hub.database.findLiveSpriteMachine(trigger.id))?.status, "alive");
  });

  it("refuses to recreate a sprite that is still running an execution", async () => {
    const hub = await spriteHub();
    const trigger = await hub.store.save({ yaml: spriteYaml, userId: "user-1" });
    await hub.settled();
    const [sprite] = await hub.database.listOrganizationSprites("org-1");
    assert.ok(sprite);
    const revision = await hub.database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(revision);
    await hub.database.insertAgentExecution({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      machineId: sprite.machine.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: revision.id,
    });

    await assert.rejects(
      hub.dashboard.recreateSprite(hub.request, "acme", trigger.id),
      /destroys it and ends its 1 running execution\. Try again once it is idle\./u,
    );
    assert.equal((await hub.database.findLiveSpriteMachine(trigger.id))?.status, "alive");
  });
});

const spriteYaml = `name: reviewer
enabled: true
on:
  manual.run: {}
run:
  target:
    kind: sprite
    bootstrap: |
      npm install -g @anthropic-ai/claude-code
    cwd: /workspace
    memory: 16384
  agent: { provider: test, mode: full-access }
  prompt: Handle it
`;

async function spriteHub() {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role: "owner",
      },
      {
        userId: "user-2",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-2",
        role: "member",
      },
    ],
  });
  const entitlements = new EntitlementsService(database, { seats: async () => 0 });
  await entitlements.stamp("org-1", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
  await database.upsertOrganizationSpritesConfiguration({
    organizationId: "org-1",
    token: "sprites-token",
    memoryMb: 8192,
    updatedByUserId: null,
  });
  const provider: SpriteProvider = {
    create: async () => "sprite-id",
    destroy: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: "/opt/node\n", stderr: "" }),
    service: async () => undefined,
    setMemory: async () => undefined,
  };
  const jobs: Promise<void>[] = [];
  const activate = createSpriteActivation({
    database,
    apiKeys: {
      create: async (organizationId, _userId, name, scopes) => ({
        secret: "secret",
        summary: {
          id: "key-1",
          name,
          prefix: "key-1",
          scopes,
          createdAt: new Date(),
          lastUsedAt: null,
          revokedAt: null,
        },
      }),
      revoke: async () => true,
    },
    connectionsForProject: () => (slug: string, value: string) => `resolved:${slug}.${value}`,
    hubOrigin: "https://hub.test",
    provider: () => provider,
  });
  const spriteActivation: typeof activate = async (input) => {
    const started = await activate(input);
    if (started !== undefined) jobs.push(started.job);
    return started;
  };
  return {
    database,
    store: new OrganizationTriggerStore(database, "org-1", entitlements, spriteActivation),
    dashboard: new TriggerDashboard(database, accountAuth(), entitlements, spriteActivation),
    memberDashboard: new TriggerDashboard(
      database,
      accountAuth("user-2"),
      entitlements,
      spriteActivation,
    ),
    request: new Request("https://hub.test/o/acme/triggers"),
    settled: async () => {
      await Promise.all(jobs);
      await enrollSprite(database);
    },
  };
}

async function enrollSprite(database: ReturnType<typeof createMemoryDatabase>) {
  await database.issueEnrollmentToken({
    id: "sprite-token",
    verifier: "sprite-token-verifier",
    organizationId: "org-1",
    issuedByApiKeyId: "key-1",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "sprite-daemon",
    tokenVerifier: "sprite-token-verifier",
    serverId: "sprite-server",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: ["hub.execute"],
    now: new Date("2026-09-17T00:00:00.000Z"),
  });
}
