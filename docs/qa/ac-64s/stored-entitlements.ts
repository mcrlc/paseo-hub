/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-64s/stored-entitlements.ts
// Scenario 5: a stored entitlement document written before canUseSpriteTargets existed reads false;
// Free fallback and unlimited template values; ent_can_use_sprite_targets plan metadata parsing.
import { composeBilling } from "../../../src/billing/index.js";
import { parsePlanMetadata } from "../../../src/billing/plan-template.js";
import {
  UNLIMITED_TEMPLATE,
  normalizeStoredEntitlements,
} from "../../../src/entitlements/catalog.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { openPostgres, seedOrganization } from "./pg-common.js";

const pg = await openPostgres();
const { organizationId } = await seedOrganization(pg, false);
const PRE_FLAG =
  '{"seats":{"max":null},"canInviteMembers":true,"meters":{"executions.monthly":{"limit":null}}}';
await pg.runtime.query(
  `insert into organization_entitlements
     (organization_id, granted, overrides, plan_id, plan_version, stamped_at, updated_at)
   values ($1, $2::jsonb, '{}'::jsonb, null, 'pre-flag', now(), now())`,
  [organizationId, PRE_FLAG],
);
const raw = await pg.runtime.query<{ granted: unknown }>(
  "select granted from organization_entitlements where organization_id = $1",
  [organizationId],
);
console.log("== Stored document without canUseSpriteTargets (Postgres) ==");
console.log(`raw granted column: ${JSON.stringify(raw.rows[0]!.granted)}`);
const service = new EntitlementsService(pg.database, { seats: async () => 0 });
const record = await service.read(organizationId);
console.log(
  `service.read -> granted.canUseSpriteTargets=${record.granted.canUseSpriteTargets} effective.canUseSpriteTargets=${record.effective.canUseSpriteTargets}`,
);
try {
  await service.requireFlag(organizationId, "canUseSpriteTargets");
  console.log("requireFlag(canUseSpriteTargets): allowed (unexpected)");
} catch (error) {
  console.log(
    `requireFlag(canUseSpriteTargets): ${(error as Error).name}: ${(error as Error).message}`,
  );
}
console.log(
  `normalizeStoredEntitlements(pre-flag) = ${JSON.stringify(normalizeStoredEntitlements(JSON.parse(PRE_FLAG)))}`,
);
await pg.runtime.close();

console.log("\n== Templates ==");
const unused = () => Promise.reject(new Error("unused"));
const { createMemoryDatabase } = await import("../../../src/db/memory.js");
const free = await composeBilling({
  config: { stripeSecretKey: "sk_test_fake", stripeWebhookSecret: "whsec_fake" },
  database: createMemoryDatabase(),
  catalogSource: { listProducts: unused, listPrices: unused },
  billingClient: new Proxy({}, { get: () => unused }) as never,
  seatUsage: () => Promise.resolve(0),
}).provisioningEntitlement();
console.log(`Free fallback (no Free plan mirrored): ${JSON.stringify(free)}`);
console.log(`UNLIMITED_TEMPLATE: ${JSON.stringify(UNLIMITED_TEMPLATE)}`);

console.log("\n== Plan metadata ==");
const base = {
  paseo_plan_slug: "team",
  ent_seats_max: "5",
  ent_can_invite: "true",
  ent_executions_monthly_limit: "2000",
};
for (const [label, metadata] of [
  ["ent_can_use_sprite_targets=true", { ...base, ent_can_use_sprite_targets: "true" }],
  ["ent_can_use_sprite_targets=false", { ...base, ent_can_use_sprite_targets: "false" }],
  ["key absent", base],
  ["ent_can_use_sprite_targets=yes (invalid)", { ...base, ent_can_use_sprite_targets: "yes" }],
] as const) {
  console.log(`${label}: ${JSON.stringify(parsePlanMetadata(metadata))}`);
}
