/* oxlint-disable */
// Usage: QA_PG=postgres://qa:qa@127.0.0.1:55438/hub SPRITES_TOKEN_FILE=<dir>/token.json \
//   API_KEY_FILE=<dir>/api-key npx tsx docs/qa/ac-50k/seed-hub.ts
// Same as ac-52w/seed-hub.ts: no entitlement override, stores the temporary Sprites org token with the
// 8192 MB organization default memory and no organization env, and mints a key for trigger install and
// manual runs. Secrets go only to chmod-600 files.
import { readFileSync, writeFileSync } from "node:fs";
import { OrganizationApiKeys } from "../../../src/auth/api-keys.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { createPostgresTestRuntime } from "../../../src/db/test-utils/runtime.js";

const pg = await createPostgresTestRuntime(process.env.QA_PG!);
const organizationId = (await pg.runtime.query<{ id: string }>("select id from organization"))
  .rows[0]!.id;
const entitlements = new EntitlementsService(pg.database, { seats: async () => 0 });
const read = await entitlements.read(organizationId);
console.log("effective.canUseSpriteTargets:", read.effective.canUseSpriteTargets);
const { token } = JSON.parse(readFileSync(process.env.SPRITES_TOKEN_FILE!, "utf8"));
await pg.database.upsertOrganizationSpritesConfiguration({
  organizationId,
  token,
  memoryMb: 8192,
  updatedByUserId: null,
});
console.log(
  "sprites configuration stored, token matches:",
  (await pg.database.getOrganizationSpritesConfiguration(organizationId))?.token === token,
);
const owner = await pg.runtime.query<{ id: string }>('select id from "user" limit 1');
const key = await new OrganizationApiKeys(pg.runtime, pg.locks).create(
  organizationId,
  owner.rows[0]?.id ?? null,
  "qa ac-50k",
  ["configuration:install", "projects:read", "runs:dispatch"],
);
writeFileSync(process.env.API_KEY_FILE!, key.secret, { mode: 0o600 });
console.log("public API key id:", key.summary.id);
await pg.runtime.close();
