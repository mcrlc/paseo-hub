/* oxlint-disable */
// Usage: QA_PG=postgres://qa:qa@127.0.0.1:55438/hub API_KEY_FILE=<private dir>/api-key npx tsx docs/qa/ac-wri/seed.ts
// Grants canUseSpriteTargets to the bootstrap organization and mints a configuration:install key (chmod 600 file).
// The Sprites token is saved through saveSpritesSettings over HTTP, not here.
import { writeFileSync } from "node:fs";
import { OrganizationApiKeys } from "../../../src/auth/api-keys.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { openPostgres } from "../ac-vni/pg-common.js";

const pg = await openPostgres();
const orgs = await pg.runtime.query<{ id: string; slug: string }>(
  "select id, slug from organization",
);
const organizationId = orgs.rows[0]!.id;
const entitlements = new EntitlementsService(pg.database, {
  seats: async () => 0,
});
await entitlements.override(
  organizationId,
  { canUseSpriteTargets: true },
  "qa",
  "ac-wri verification",
);
console.log(
  "canUseSpriteTargets:",
  (await entitlements.read(organizationId)).effective.canUseSpriteTargets,
);
const owner = await pg.runtime.query<{ id: string }>('select id from "user" limit 1');
const key = await new OrganizationApiKeys(pg.runtime, pg.locks).create(
  organizationId,
  owner.rows[0]?.id ?? null,
  "qa ac-wri",
  ["configuration:install", "projects:read"],
);
writeFileSync(process.env.API_KEY_FILE!, key.secret, { mode: 0o600 });
console.log("public API key id:", key.summary.id);
await pg.runtime.close();
