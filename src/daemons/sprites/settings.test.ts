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

  it("forbids a member without manage-resources from reading", async () => {
    const { settings } = setup("member");
    await assert.rejects(settings.snapshot(request, "acme"), {
      name: "ProjectCommandError",
      code: "forbidden",
    });
  });

  it("checks the token against Sprites before storing it", async () => {
    const { settings, requests } = setup("owner", 200);
    await settings.save(request, "acme", { token: "sprites-secret", memoryMb: 8192 });
    assert.deepEqual(requests, [
      { url: "https://api.sprites.dev/v1/sprites", authorization: "Bearer sprites-secret" },
    ]);
    assert.equal((await settings.snapshot(request, "acme")).configured, true);
  });

  it("refuses a token Sprites rejects and keeps the stored one", async () => {
    const { settings, database, respondWith } = setup("owner");
    await settings.save(request, "acme", { token: "good", memoryMb: 8192 });
    respondWith(401);
    await assert.rejects(settings.save(request, "acme", { token: "typo", memoryMb: 8192 }), {
      name: "SpritesTokenRejectedError",
      message: "Sprites rejected this token.",
    });
    assert.equal((await database.getOrganizationSpritesConfiguration("org-1"))?.token, "good");
  });

  it("fails the save with the status when Sprites cannot check the token", async () => {
    const { settings, database } = setup("owner", 500);
    await assert.rejects(settings.save(request, "acme", { token: "t", memoryMb: 8192 }), {
      name: "SpritesTokenCheckError",
      message: /HTTP 500/u,
    });
    assert.equal(await database.getOrganizationSpritesConfiguration("org-1"), undefined);
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

function setup(role: OrganizationRole, status = 200) {
  let answer = status;
  const requests: { url: string; authorization: string | null }[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(new Response("{}", { status: answer }));
  };
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
  return {
    database,
    requests,
    respondWith: (next: number) => {
      answer = next;
    },
    settings: new SpritesSettings(database, accountAuth(), { fetch: fetchStub }),
  };
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
