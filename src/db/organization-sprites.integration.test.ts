import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { Database } from "./types.js";

/** The memory store answers these from its own maps; only the SQL needs a real server. */
describe("organization sprites read model", () => {
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

  it("joins every sprite machine to its trigger and the daemon it enrolled", async () => {
    const organizationId = `org-${randomUUID()}`;
    const triggerId = randomUUID();
    const daemonId = randomUUID();
    await seed(`insert into organization (id, name, slug) values ($1, $1, $1)`, [organizationId]);
    await seed(
      `insert into organization_triggers (id, organization_id, name, format)
       values ($1, $2, 'reviewer', 'single_run')`,
      [triggerId, organizationId],
    );
    const machine = await database.insertSpriteMachine({
      orgId: organizationId,
      source: {
        kind: "sprite",
        triggerId,
        spriteName: `trigger-${triggerId}`,
        apiKeyId: randomUUID(),
      },
      specs: { memoryMb: 16384 },
    });
    assert.ok(machine);

    assert.deepEqual(await database.listOrganizationSprites(organizationId), [
      { machine, triggerName: "reviewer", daemonId: null, lastRunAt: null },
    ]);

    await seed(
      `insert into daemons (id, idempotency_key, enrollment_verifier, slug, machine_id,
                            organization_id, server_id, daemon_public_key, credential_verifier,
                            scopes, status)
       values ($1, $4, $4, 'reviewer', $2, $3, 'sprite-server', 'public-key', 'verifier',
               '["hub.execute"]'::jsonb, 'active')`,
      [daemonId, machine.id, organizationId, daemonId],
    );

    const [sprite] = await database.listOrganizationSprites(organizationId);
    assert.equal(sprite?.daemonId, daemonId);
    assert.equal(sprite?.triggerName, "reviewer");
    assert.equal(sprite?.lastRunAt, null);
    assert.deepEqual(await database.listOrganizationSprites(`org-${randomUUID()}`), []);
  });

  it("reads no machine status for runs that never went to a sprite", async () => {
    const organizationId = `org-${randomUUID()}`;

    assert.deepEqual(await database.listSpriteRunStatuses(organizationId, []), []);
    assert.deepEqual(await database.listSpriteRunStatuses(organizationId, [randomUUID()]), []);
  });

  async function seed(sql: string, parameters: unknown[]) {
    const client = await createPostgresQueryRuntime(postgres.getConnectionUri());
    try {
      await client.query(sql, parameters);
    } finally {
      await client.close();
    }
  }
});
