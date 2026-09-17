/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-64s/entitlement-gate.ts
// Scenario 3 (Free plan denies sprite saves, daemon trigger untouched) and scenario 4 (operator override
// grants, activates with no daemonId; clearing it denies fresh saves while the active trigger stays active).
// Real Postgres; real EntitlementsService; OperatorConsole with a stub account resolver that says "operator".
import { composeBilling } from "../../../src/billing/index.js";
import { parseCompiledHubConfig } from "../../../src/config/compiler.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { OperatorConsole } from "../../../src/operator/console.js";
import { OrganizationTriggerStore } from "../../../src/triggers/store.js";
import { daemonYaml, spriteYaml } from "./fixtures.js";
import { openPostgres, seedOrganization } from "./pg-common.js";

const unused = () => Promise.reject(new Error("unused"));
const pg = await openPostgres();
const { database, runtime } = pg;
const { organizationId, slug } = await seedOrganization(pg);
const entitlements = new EntitlementsService(database, { seats: async () => 0 });
const billing = composeBilling({
  config: { stripeSecretKey: "sk_test_fake", stripeWebhookSecret: "whsec_fake" },
  database,
  catalogSource: { listProducts: unused, listPrices: unused },
  billingClient: new Proxy({}, { get: () => unused }) as never,
  seatUsage: () => Promise.resolve(0),
});
const free = await billing.provisioningEntitlement();
await entitlements.stamp(organizationId, free.granted, {
  source: "provisioning",
  planId: free.planId,
});
console.log(`organization ${organizationId} (${slug}) stamped with Free provisioning entitlement:`);
console.log(JSON.stringify(free));
const store = new OrganizationTriggerStore(database, organizationId, entitlements);
const operator = new OperatorConsole(
  database,
  {
    resolveAccount: async () => ({
      session: { id: "qa-session", activeOrganizationId: null },
      account: { id: "qa-operator", name: "QA operator", email: "qa@example.com" },
      isInstanceOperator: true,
    }),
  },
  entitlements,
);
const request = new Request("https://hub.test/operator");

async function state(label: string) {
  const triggers = await store.list();
  console.log(`\n-- state: ${label} --`);
  console.log(
    `effective.canUseSpriteTargets=${(await entitlements.read(organizationId)).effective.canUseSpriteTargets}`,
  );
  for (const trigger of triggers) {
    const revision = await store.activeRevision(trigger);
    const routes = await runtime
      .query<{ n: string }>(
        "select count(*)::text as n from organization_trigger_routes where trigger_id = $1",
        [trigger.id],
      )
      .catch(() => ({ rows: [{ n: "n/a" }] }));
    console.log(
      `trigger name=${trigger.name} enabled=${trigger.enabled} activeRevisionId=${trigger.activeRevisionId} version=${revision.version} contentHash=${revision.contentHash.slice(0, 12)} routes=${routes.rows[0]?.n}`,
    );
  }
}

async function attempt(label: string, input: Parameters<OrganizationTriggerStore["save"]>[0]) {
  try {
    const saved = await store.save(input);
    console.log(`[${label}] SAVED trigger=${saved.id} activeRevisionId=${saved.activeRevisionId}`);
    return saved;
  } catch (error) {
    const issues = (error as { issues?: { path: unknown[]; message: string }[] }).issues;
    console.log(`[${label}] REJECTED ${(error as Error).name}`);
    for (const issue of issues ?? [])
      console.log(`    path=${issue.path.join(".")}  message=${issue.message}`);
    return undefined;
  }
}

console.log("\n==== Scenario 3: entitlement off (Free) ====");
const daemon = (await attempt("save daemon trigger", { yaml: daemonYaml(), userId: null }))!;
await state("before sprite attempts");
await attempt("save new sprite trigger", { yaml: spriteYaml(), userId: null });
await attempt("overwrite daemon trigger with sprite target", {
  triggerId: daemon.id,
  yaml: spriteYaml("daemon-review"),
  userId: null,
});
await state("after sprite attempts");

console.log("\n==== Scenario 4: entitlement on via operator override ====");
const granted = await operator.override(
  request,
  { organizationSlug: slug },
  {
    patch: { canUseSpriteTargets: true },
    reason: "ac-64s sprite beta",
  },
);
console.log(
  `operator.override -> overrides=${JSON.stringify(granted.entitlements.overrides)} effective.canUseSpriteTargets=${granted.entitlements.effective.canUseSpriteTargets}`,
);
const sprite = (await attempt("save new sprite trigger", { yaml: spriteYaml(), userId: null }))!;
const revision = await store.activeRevision(sprite);
const stored = await runtime.query<{ normalized_configuration: unknown }>(
  "select normalized_configuration from organization_trigger_revisions where id = $1",
  [revision.id],
);
const environments = parseCompiledHubConfig(stored.rows[0]!.normalized_configuration).environments;
console.log(
  "stored normalized_configuration.environments (from Postgres) =",
  JSON.stringify(environments, null, 2),
);
console.log(
  `any environment has daemonId: ${environments.some((environment) => "daemonId" in environment)}`,
);
await state("override on, sprite saved");

const cleared = await operator.clearOverride(
  request,
  { organizationSlug: slug },
  {
    key: "canUseSpriteTargets",
    reason: "ac-64s beta ended",
  },
);
console.log(
  `\noperator.clearOverride -> overrides=${JSON.stringify(cleared.entitlements.overrides)} effective.canUseSpriteTargets=${cleared.entitlements.effective.canUseSpriteTargets}`,
);
await attempt("fresh save: another new sprite trigger", {
  yaml: spriteYaml("sprite-two"),
  userId: null,
});
await attempt("fresh save: prompt edit on the active sprite trigger", {
  triggerId: sprite.id,
  yaml: spriteYaml().replace("prompt: Review it.", "prompt: Review it again."),
  userId: null,
});
await attempt("disable the active sprite trigger (enabled: false)", {
  triggerId: sprite.id,
  yaml: `enabled: false\n${spriteYaml()}`,
  userId: null,
});
await state("override cleared");
console.log("\nentitlement history (newest first):");
for (const entry of cleared.history.slice(0, 3))
  console.log(
    `  ${entry.source} actor=${entry.actor} reason=${entry.reason} overrides=${JSON.stringify(entry.overrides)}`,
  );
await runtime.close();
