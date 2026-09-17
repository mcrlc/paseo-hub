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
});
