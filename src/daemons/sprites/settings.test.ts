import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import type { OrganizationRole } from "../../auth/organization-policy.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { SpritesSettings } from "./settings.js";

const request = new Request("https://hub.test/o/acme/settings/sprites");

describe("Sprites organization settings", () => {
  it("reports an unconfigured organization", async () => {
    const { settings } = setup("owner");
    assert.deepEqual(await settings.snapshot(request, "acme"), {
      configured: false,
      memoryMb: null,
      updatedAt: null,
      updatedByUserId: null,
    });
  });

  it("persists a save and never returns the token", async () => {
    const { settings, database } = setup("admin");
    await settings.save(request, "acme", { token: "sprites-secret", memoryMb: 16384 });

    const snapshot = await settings.snapshot(request, "acme");
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.memoryMb, 16384);
    assert.equal(snapshot.updatedByUserId, "user-1");
    assert.equal(typeof snapshot.updatedAt, "string");
    assert.equal("token" in snapshot, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /sprites-secret/u);
    assert.equal(
      (await database.getOrganizationSpritesConfiguration("org-1"))?.token,
      "sprites-secret",
    );
  });

  it("forbids a member without manage-resources from saving", async () => {
    const { settings, database } = setup("member");
    await assert.rejects(
      settings.save(request, "acme", { token: "sprites-secret", memoryMb: 8192 }),
      { name: "ProjectCommandError", code: "forbidden" },
    );
    assert.equal(await database.getOrganizationSpritesConfiguration("org-1"), undefined);
  });
});

function setup(role: OrganizationRole) {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role,
      },
    ],
  });
  return { database, settings: new SpritesSettings(database, accountAuth()) };
}

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
