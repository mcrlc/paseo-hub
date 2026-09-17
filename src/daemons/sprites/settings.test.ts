import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import type { OrganizationRole } from "../../auth/organization-policy.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createSpriteServiceRewrite } from "./activation.js";
import { SpritesSettings } from "./settings.js";

const request = new Request("https://hub.test/o/acme/settings/sprites");

describe("Sprites organization settings", () => {
  it("reports an unconfigured organization", async () => {
    const { settings } = setup("owner");
    assert.deepEqual(await settings.snapshot(request, "acme"), {
      configured: false,
      memoryMb: null,
      envKeys: [],
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
  it("lists environment keys sorted and never their values", async () => {
    const { settings } = setup("owner");
    await settings.save(request, "acme", { token: "sprites-secret", memoryMb: 8192 });
    await settings.setEnv(request, "acme", {
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: " oauth-secret ",
    });
    await settings.setEnv(request, "acme", { key: "API_KEY", value: "api-secret" });

    const snapshot = await settings.snapshot(request, "acme");
    assert.deepEqual(snapshot.envKeys, ["API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret/u);
  });

  it("replaces a key in place and removes it", async () => {
    const { settings, database } = setup("admin");
    await settings.save(request, "acme", { token: "t", memoryMb: 8192 });
    await settings.setEnv(request, "acme", { key: "TOKEN", value: "first" });
    await settings.setEnv(request, "acme", { key: "TOKEN", value: " second " });
    assert.deepEqual((await database.getOrganizationSpritesConfiguration("org-1"))?.env, {
      TOKEN: "second",
    });

    await settings.removeEnv(request, "acme", { key: "TOKEN" });
    assert.deepEqual((await settings.snapshot(request, "acme")).envKeys, []);
  });

  it("leaves the token's update time and author alone on variable writes", async () => {
    const { settings, database } = setup("owner");
    await database.upsertOrganizationSpritesConfiguration({
      organizationId: "org-1",
      token: "t",
      memoryMb: 8192,
      updatedByUserId: null,
    });
    const before = await settings.snapshot(request, "acme");
    await settings.setEnv(request, "acme", { key: "TOKEN", value: "v" });
    await settings.setEnv(request, "acme", { key: "OTHER", value: "o" });
    await settings.removeEnv(request, "acme", { key: "OTHER" });
    const after = await settings.snapshot(request, "acme");
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.updatedByUserId, null);
  });

  it("rewrites live sprite services after each successful variable write", async () => {
    const { settings, rewrites } = setup("owner");
    await assert.rejects(settings.setEnv(request, "acme", { key: "TOKEN", value: "v" }));
    await settings.save(request, "acme", { token: "t", memoryMb: 8192 });
    await settings.setEnv(request, "acme", { key: "TOKEN", value: "v" });
    await assert.rejects(settings.removeEnv(request, "acme", { key: "OTHER" }));
    await settings.removeEnv(request, "acme", { key: "TOKEN" });
    assert.deepEqual(rewrites, ["org-1", "org-1"]);
  });

  it("stores the variable even when the rewrite cannot read the database", async () => {
    const { settings, database } = setup("owner", 200, (db) => {
      db.listOrganizationTriggers = () => Promise.reject(new Error("database is down"));
      return createSpriteServiceRewrite({
        database: db,
        connectionsForProject: () => () => "",
        provider: () => {
          throw new Error("unused");
        },
      });
    });
    await settings.save(request, "acme", { token: "t", memoryMb: 8192 });

    await settings.setEnv(request, "acme", { key: "TOKEN", value: "v" });
    assert.deepEqual((await database.getOrganizationSpritesConfiguration("org-1"))?.env, {
      TOKEN: "v",
    });
  });

  it("refuses to remove a variable that does not exist", async () => {
    const { settings } = setup("owner");
    const notFound = {
      name: "SpritesEnvNotFoundError",
      code: "notFound",
      message: "No such variable.",
    };
    await assert.rejects(settings.removeEnv(request, "acme", { key: "TOKEN" }), notFound);
    await settings.save(request, "acme", { token: "t", memoryMb: 8192 });
    await assert.rejects(settings.removeEnv(request, "acme", { key: "TOKEN" }), notFound);
  });

  it("keeps the environment when the token is replaced", async () => {
    const { settings } = setup("owner");
    await settings.save(request, "acme", { token: "first", memoryMb: 8192 });
    await settings.setEnv(request, "acme", { key: "TOKEN", value: "v" });
    await settings.save(request, "acme", { token: "second", memoryMb: 8192 });
    assert.deepEqual((await settings.snapshot(request, "acme")).envKeys, ["TOKEN"]);
  });

  it("rejects invalid and Hub-owned names and empty or oversized values", async () => {
    const { settings } = setup("owner");
    await settings.save(request, "acme", { token: "t", memoryMb: 8192 });
    const invalidName = {
      name: "SpritesEnvInputError",
      code: "invalidInput",
      message: "Use capital letters, digits, and underscores, not starting with a digit.",
    };
    for (const key of ["lower", "1ST", "WITH-DASH", ""]) {
      await assert.rejects(settings.setEnv(request, "acme", { key, value: "v" }), invalidName);
    }
    for (const key of ["HOME", "PATH", "PASEO_HOME", "PASEO_PASSWORD"]) {
      await assert.rejects(settings.setEnv(request, "acme", { key, value: "v" }), {
        name: "SpritesEnvInputError",
        message: `Hub sets ${key} on every sprite; choose another name.`,
      });
    }
    await assert.rejects(settings.setEnv(request, "acme", { key: "K", value: "  " }), {
      message: "Enter a value.",
    });
    await assert.rejects(settings.setEnv(request, "acme", { key: "K", value: "x".repeat(8193) }), {
      message: "Keep the value to 8192 characters or fewer.",
    });
    await settings.setEnv(request, "acme", { key: "K", value: "x".repeat(8192) });
  });

  it("refuses environment before Sprites is connected", async () => {
    const { settings, database } = setup("owner");
    await assert.rejects(settings.setEnv(request, "acme", { key: "TOKEN", value: "v" }), {
      name: "SpritesEnvInputError",
      message: "Connect Sprites with an organization token first.",
    });
    assert.equal(await database.getOrganizationSpritesConfiguration("org-1"), undefined);
  });

  it("forbids a member without manage-resources from setting or removing", async () => {
    const { settings, database } = setup("member");
    await database.upsertOrganizationSpritesConfiguration({
      organizationId: "org-1",
      token: "t",
      memoryMb: 8192,
      env: { TOKEN: "kept" },
      updatedByUserId: null,
    });
    const forbidden = { name: "ProjectCommandError", code: "forbidden" };
    await assert.rejects(settings.setEnv(request, "acme", { key: "TOKEN", value: "v" }), forbidden);
    await assert.rejects(settings.removeEnv(request, "acme", { key: "TOKEN" }), forbidden);
    assert.deepEqual((await database.getOrganizationSpritesConfiguration("org-1"))?.env, {
      TOKEN: "kept",
    });
  });
});

function setup(
  role: OrganizationRole,
  status = 200,
  rewriteFor?: (database: ReturnType<typeof createMemoryDatabase>) => (id: string) => Promise<void>,
) {
  let answer = status;
  const requests: { url: string; authorization: string | null }[] = [];
  const rewrites: string[] = [];
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
    rewrites,
    respondWith: (next: number) => {
      answer = next;
    },
    settings: new SpritesSettings(database, accountAuth(), {
      fetch: fetchStub,
      rewriteServices:
        rewriteFor?.(database) ??
        (async (organizationId) => {
          rewrites.push(organizationId);
        }),
    }),
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
