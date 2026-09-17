// Scenario 5: accessor round trip against Postgres (DATABASE_URL, migrated) and the in-memory database.
import { randomUUID } from "node:crypto";
import { createMemoryDatabase } from "../../../src/db/memory.js";
import { createDatabase, createPostgresQueryRuntime } from "../../../src/db/test-utils/runtime.js";
import type { Database } from "../../../src/db/types.js";

const log = (line: string) => process.stdout.write(`${line}\n`);

const url = process.env["DATABASE_URL"]!;
const sql = await createPostgresQueryRuntime(url);
const pg = await createDatabase(url);
const organizationId = `org-${randomUUID()}`;
const userId = `user-${randomUUID()}`;
await sql.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [organizationId]);
await sql.query(`insert into "user" (id, name, email) values ($1, $1, $1 || '@example.test')`, [
  userId,
]);

const show = (r: unknown) =>
  JSON.stringify(r, (k, v: unknown) => (k === "token" ? `<${String(v)}>` : v));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function roundTrip(label: string, store: Database) {
  log(`\n=== ${label} ===`);
  log(
    `read before configure: ${show(await store.getOrganizationSpritesConfiguration(organizationId))}`,
  );
  const first = await store.upsertOrganizationSpritesConfiguration({
    organizationId,
    token: "first",
    memoryMb: 8192,
    updatedByUserId: userId,
  });
  log(`upsert #1 (insert): ${show(first)}`);
  await sleep(20);
  const second = await store.upsertOrganizationSpritesConfiguration({
    organizationId,
    token: "second",
    memoryMb: 16384,
    updatedByUserId: null,
  });
  log(`upsert #2 (update): ${show(second)}`);
  const read = await store.getOrganizationSpritesConfiguration(organizationId);
  log(`read after: ${show(read)}`);
  log(
    `token updated: ${read?.token === "second"}; memory updated: ${read?.memoryMb === 16384}; updated_at later: ${read!.updatedAt.getTime() > first.updatedAt.getTime()} (+${read!.updatedAt.getTime() - first.updatedAt.getTime()}ms); read equals upsert #2 return: ${show(read) === show(second)}`,
  );
  try {
    const zero = await store.upsertOrganizationSpritesConfiguration({
      organizationId,
      token: "zero",
      memoryMb: 0,
      updatedByUserId: null,
    });
    log(`upsert memoryMb=0: ACCEPTED -> ${show(zero)}`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const detail = JSON.stringify({
      code: "code" in error ? error.code : undefined,
      constraint: "constraint" in error ? error.constraint : undefined,
    });
    log(`upsert memoryMb=0: REJECTED -> ${error.message} ${detail}`);
  }
}

await roundTrip("postgres", pg);
const rows = (
  await sql.query(
    `select organization_id, memory_mb from organization_sprites_configuration where organization_id = $1`,
    [organizationId],
  )
).rows;
log(`row after rejected 0 still: ${JSON.stringify(rows)}`);
try {
  await sql.query(
    `insert into organization_sprites_configuration (organization_id, token) values ($1, 'default')`,
    [`org-missing-${randomUUID()}`],
  );
  log("insert for unknown organization: ACCEPTED");
} catch (error) {
  if (!(error instanceof Error)) throw error;
  log(`insert for unknown organization: REJECTED -> ${error.message}`);
}
await sql.query(`delete from "user" where id = $1`, [userId]);
await pg.upsertOrganizationSpritesConfiguration({
  organizationId,
  token: "third",
  memoryMb: 4096,
  updatedByUserId: null,
});
const org2 = `org-${randomUUID()}`;
await sql.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [org2]);
await sql.query(
  `insert into organization_sprites_configuration (organization_id, token) values ($1, 'x')`,
  [org2],
);
const defaults = (
  await sql.query(
    `select memory_mb from organization_sprites_configuration where organization_id = $1`,
    [org2],
  )
).rows;
log(`insert without memory_mb defaults to: ${JSON.stringify(defaults)}`);
const u2 = `user-${randomUUID()}`;
await sql.query(`insert into "user" (id, name, email) values ($1, $1, $1 || '@example.test')`, [
  u2,
]);
await pg.upsertOrganizationSpritesConfiguration({
  organizationId: org2,
  token: "y",
  memoryMb: 1024,
  updatedByUserId: u2,
});
await sql.query(`delete from "user" where id = $1`, [u2]);
log(`after deleting updater user: ${show(await pg.getOrganizationSpritesConfiguration(org2))}`);
await sql.query(`delete from organization where id = $1`, [organizationId]);
const remaining = await sql.query(
  `select count(*)::int as n from organization_sprites_configuration where organization_id = $1`,
  [organizationId],
);
log(
  `after deleting organization: read=${show(await pg.getOrganizationSpritesConfiguration(organizationId))}; rows=${JSON.stringify(remaining.rows)}`,
);

await roundTrip("in-memory", createMemoryDatabase());
log(
  "in-memory: no organization deletion exists on the Database interface; cascade is not applicable",
);

await pg.close();
await sql.close();
