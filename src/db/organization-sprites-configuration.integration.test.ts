import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { Database } from "./types.js";

describe("organization Sprites configuration", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = await createDatabase(postgres.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  async function seedOrganization(): Promise<string> {
    const organizationId = `org-${randomUUID()}`;
    const client = await createPostgresQueryRuntime(postgres.getConnectionUri());
    try {
      await client.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [
        organizationId,
      ]);
    } finally {
      await client.close();
    }
    return organizationId;
  }

  async function seedUser(): Promise<string> {
    const userId = `user-${randomUUID()}`;
    const client = await createPostgresQueryRuntime(postgres.getConnectionUri());
    try {
      await client.query(`insert into "user" (id, name, email) values ($1, $1, $1)`, [userId]);
    } finally {
      await client.close();
    }
    return userId;
  }

  it("reads nothing for an unconfigured organization", async () => {
    const organizationId = await seedOrganization();

    assert.equal(await database.getOrganizationSpritesConfiguration(organizationId), undefined);
    assert.equal(
      await createMemoryDatabase().getOrganizationSpritesConfiguration(organizationId),
      undefined,
    );
  });

  it("upserts and reads back the token and memory limit", async () => {
    const organizationId = await seedOrganization();

    for (const store of [database, createMemoryDatabase()]) {
      await store.upsertOrganizationSpritesConfiguration({
        organizationId,
        token: "first",
        memoryMb: 8192,
        updatedByUserId: null,
      });
      const updated = await store.upsertOrganizationSpritesConfiguration({
        organizationId,
        token: "second",
        memoryMb: 16384,
        updatedByUserId: null,
      });
      const read = await store.getOrganizationSpritesConfiguration(organizationId);

      assert.deepEqual(read, updated);
      assert.equal(read?.token, "second");
      assert.equal(read?.memoryMb, 16384);
      assert.deepEqual(read?.env, {});

      await assert.rejects(
        store.upsertOrganizationSpritesConfiguration({
          organizationId,
          token: "zero",
          memoryMb: 0,
          updatedByUserId: null,
        }),
        /organization_sprites_configuration_memory_mb_check/u,
      );
    }
  });

  it("sets, replaces, and removes one environment key without touching the token audit", async () => {
    const organizationId = await seedOrganization();
    const otherOrganizationId = await seedOrganization();
    const userId = await seedUser();

    for (const store of [database, createMemoryDatabase()]) {
      assert.equal(
        await store.setOrganizationSpritesEnv({ organizationId, key: "TOKEN", value: "v" }),
        undefined,
      );
      assert.equal(
        await store.removeOrganizationSpritesEnv({ organizationId, key: "TOKEN" }),
        undefined,
      );
      for (const id of [organizationId, otherOrganizationId]) {
        await store.upsertOrganizationSpritesConfiguration({
          organizationId: id,
          token: "t",
          memoryMb: 8192,
          updatedByUserId: userId,
        });
      }
      const saved = await store.getOrganizationSpritesConfiguration(organizationId);
      await store.setOrganizationSpritesEnv({ organizationId, key: "TOKEN", value: "v" });
      await store.setOrganizationSpritesEnv({ organizationId, key: "OTHER", value: "o" });
      const replaced = await store.setOrganizationSpritesEnv({
        organizationId,
        key: "TOKEN",
        value: "w",
      });
      assert.deepEqual(replaced?.env, { OTHER: "o", TOKEN: "w" });

      const removed = await store.removeOrganizationSpritesEnv({ organizationId, key: "OTHER" });
      assert.deepEqual(removed?.env, { TOKEN: "w" });
      assert.deepEqual(removed?.updatedAt, saved?.updatedAt);
      assert.equal(removed?.updatedByUserId, userId);
      assert.equal(
        await store.removeOrganizationSpritesEnv({ organizationId, key: "OTHER" }),
        undefined,
      );
      assert.deepEqual(await store.getOrganizationSpritesConfiguration(organizationId), removed);

      const rotated = await store.upsertOrganizationSpritesConfiguration({
        organizationId,
        token: "rotated",
        memoryMb: 8192,
        updatedByUserId: null,
      });
      assert.deepEqual(rotated.env, { TOKEN: "w" });
      assert.deepEqual(
        (await store.getOrganizationSpritesConfiguration(otherOrganizationId))?.env,
        {},
      );
    }
  });
});
