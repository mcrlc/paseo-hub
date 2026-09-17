import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { UNLIMITED_TEMPLATE } from "../entitlements/catalog.js";
import { EntitlementsService } from "../entitlements/service.js";
import { OrganizationTriggerStore } from "./store.js";
import { parseCompiledHubConfig } from "../config/compiler.js";

describe("organization trigger store", () => {
  it("creates and updates one hidden runtime without exposing a project", async () => {
    const database = await databaseWithDaemon();
    const store = new OrganizationTriggerStore(database, "org");
    const first = await store.save({ yaml: triggerYaml(true), userId: null });
    const second = await store.save({
      triggerId: first.id,
      yaml: triggerYaml(false),
      userId: null,
    });

    assert.equal(second.id, first.id);
    assert.equal(second.runtimeProjectId, first.runtimeProjectId);
    assert.equal(second.enabled, false);
    assert.equal((await database.listProjectsForOrganization("org")).length, 0);
    assert.equal((await store.activeRevision(second)).version, 2);
  });

  it("activates a sprite target only while the organization is entitled to sprite targets", async () => {
    const database = await databaseWithDaemon();
    const entitlements = new EntitlementsService(database, { seats: async () => 0 });
    await entitlements.stamp(
      "org",
      { ...UNLIMITED_TEMPLATE, canUseSpriteTargets: false },
      { source: "provisioning", planId: null },
    );
    await database.upsertOrganizationSpritesConfiguration({
      organizationId: "org",
      token: "sprites-token",
      memoryMb: 8192,
      updatedByUserId: null,
    });
    const store = new OrganizationTriggerStore(
      database,
      "org",
      entitlements,
      async () => undefined,
    );
    const daemon = await store.save({ yaml: triggerYaml(true), userId: null });
    const sprite = triggerYaml(true).replace(
      "target: { daemon: devbox, cwd: /workspace }",
      "target: { kind: sprite, bootstrap: install, cwd: /workspace }",
    );

    await assert.rejects(
      store.save({ triggerId: daemon.id, yaml: sprite, userId: null }),
      /run\.target\.kind: Sprite targets are not enabled for this organization\./u,
    );
    const [unchanged] = await store.list();
    assert.equal((await store.activeRevision(unchanged!)).yaml, triggerYaml(true));

    await entitlements.override("org", { canUseSpriteTargets: true }, "admin", "Sprite beta");
    const saved = await store.save({ triggerId: daemon.id, yaml: sprite, userId: null });
    const revision = await store.activeRevision(saved);
    assert.equal(revision.version, 2);
    assert.deepEqual(parseCompiledHubConfig(revision.normalizedConfiguration).environments, [
      { name: "target", kind: "sprite", bootstrap: "install", cwd: "/workspace" },
    ]);

    await entitlements.clearOverride("org", "canUseSpriteTargets", "admin", "Sprite beta ended");
    const disabled = await store.save({
      triggerId: daemon.id,
      yaml: sprite.replace("enabled: true", "enabled: false"),
      userId: null,
    });
    assert.equal(disabled.enabled, false);
    assert.equal((await store.activeRevision(disabled)).version, 3);
    await assert.rejects(
      store.save({ triggerId: daemon.id, yaml: sprite, userId: null }),
      /run\.target\.kind: Sprite targets are not enabled for this organization\./u,
    );
  });

  it("fails validation before creating storage when the daemon is unknown", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    const store = new OrganizationTriggerStore(database, "org");

    await assert.rejects(store.save({ yaml: triggerYaml(true), userId: null }), /daemon/u);
    assert.equal((await store.list()).length, 0);
    assert.equal((await database.listProjectsForOrganization("org")).length, 0);
  });

  it.each([
    ["a relative working directory", "cwd: workspace", /absolute path/iu],
    ["an omitted execution mode", "provider: test, mode: full-access", /mode.*required/iu],
  ])("rejects %s at the authoring boundary", async (_name, authored, expected) => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    const store = new OrganizationTriggerStore(database, "org");
    const yaml = triggerYaml(true).replace(
      authored === "cwd: workspace" ? "cwd: /workspace" : authored,
      authored === "cwd: workspace" ? authored : "provider: test",
    );

    await assert.rejects(store.save({ yaml, userId: null }), expected);
  });
});

function triggerYaml(enabled: boolean): string {
  return `name: manual-task
enabled: ${String(enabled)}
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

async function databaseWithDaemon() {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  await database.issueEnrollmentToken({
    id: "token",
    verifier: "token-verifier",
    organizationId: "org",
    expiresAt: new Date("2026-08-29T22:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId: "daemon-00000000",
    idempotencyKey: "daemon-key",
    suggestedSlug: "devbox",
    tokenVerifier: "token-verifier",
    serverId: "server",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: ["hub.execute"],
    now: new Date("2026-08-29T21:00:00.000Z"),
  });
  return database;
}
