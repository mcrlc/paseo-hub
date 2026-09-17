/* oxlint-disable */
// Usage: QA_PG=postgres://qa:qa@127.0.0.1:55437/hub SPRITES_TOKEN_FILE=/tmp/acvni/token.json \
//   API_KEY_FILE=/tmp/acvni/api-key npx tsx docs/qa/ac-vni/s4-seed-hub.ts
// Scenario 4 setup against the running Hub's database: grant canUseSpriteTargets to the bootstrap organization
// (UNLIMITED does not include it), store the Sprites org token with upsertOrganizationSpritesConfiguration, and
// mint a configuration:install API key for the public API. Secrets go only to chmod-600 files.
import { readFileSync, writeFileSync } from "node:fs";
import { OrganizationApiKeys } from "../../../src/auth/api-keys.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { openPostgres } from "./pg-common.js";

const pg = await openPostgres();
const orgs = await pg.runtime.query<{ id: string; slug: string }>(
  "select id, slug from organization",
);
console.log("organizations:", JSON.stringify(orgs.rows));
const organizationId = orgs.rows[0]!.id;
const entitlements = new EntitlementsService(pg.database, { seats: async () => 0 });
await entitlements.override(
  organizationId,
  { canUseSpriteTargets: true },
  "qa",
  "ac-vni real sprite verification",
);
console.log(
  "effective.canUseSpriteTargets:",
  (await entitlements.read(organizationId)).effective.canUseSpriteTargets,
);
const { token } = JSON.parse(readFileSync(process.env.SPRITES_TOKEN_FILE!, "utf8"));
await pg.database.upsertOrganizationSpritesConfiguration({
  organizationId,
  token,
  memoryMb: 8192,
  updatedByUserId: null,
});
const stored = await pg.database.getOrganizationSpritesConfiguration(organizationId);
console.log("sprites configuration stored:", {
  memoryMb: stored?.memoryMb,
  tokenMatches: stored?.token === token,
});
const owner = await pg.runtime.query<{ id: string }>('select id from "user" limit 1');
const key = await new OrganizationApiKeys(pg.runtime, pg.locks).create(
  organizationId,
  owner.rows[0]?.id ?? null,
  "qa ac-vni",
  ["configuration:install", "projects:read"],
);
writeFileSync(process.env.API_KEY_FILE!, key.secret, { mode: 0o600 });
console.log("public API key id:", key.summary.id);
await pg.runtime.close();
