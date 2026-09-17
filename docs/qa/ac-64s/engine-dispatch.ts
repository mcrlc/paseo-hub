/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-64s/engine-dispatch.ts
// Scenario 6: the real Hub runtime (createHubApplication: manual source, manual provider, DurableWorkflowEngine
// with its worker loop started, daemon lifecycle handoff) over Postgres. A sprite trigger is installed through
// POST /api/v1/triggers/install and run through POST /api/v1/manual-runs. The org also has a connected fake
// daemon port so any handoff to a daemon would be recorded in `launches`. Observes the run, executions,
// meter usage, and workflow_wakeups once per second for 30 s.
import { createHubApplication } from "../../../src/app.js";
import { UNLIMITED_TEMPLATE } from "../../../src/entitlements/catalog.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import { ScheduleTestDaemon } from "../../../src/triggers/schedule/test-daemon.js";
import { spriteYaml } from "./fixtures.js";
import { openPostgres, seedOrganization } from "./pg-common.js";

const pg = await openPostgres();
const { database, runtime } = pg;
const { organizationId, daemonId } = await seedOrganization(pg);
const entitlements = new EntitlementsService(database, { seats: async () => 0 });
await entitlements.stamp(organizationId, UNLIMITED_TEMPLATE, {
  source: "provisioning",
  planId: null,
});
await entitlements.override(
  organizationId,
  { canUseSpriteTargets: true },
  "qa",
  "ac-64s engine check",
);
const daemon = new ScheduleTestDaemon();
const application = createHubApplication({
  database,
  entitlements,
  publicBaseUrl: "http://qa.test",
  completionTokenSecret: "qa-secret",
  daemonConnectionForId: (id) => (id === daemonId ? daemon : undefined),
  publicApi: {
    status: "enabled",
    authenticator: {
      authorize: async (_request, scope) => ({
        status: "authorized",
        access: { kind: "apiKey", credentialId: "qa-key", organizationId, scopes: [scope] },
      }),
    },
  },
});
await application.hub.start();
const call = async (path: string, body: unknown) => {
  const response = await application.publicApi.handle(
    new Request(`http://qa.test${path}`, {
      method: "POST",
      headers: { authorization: "Bearer qa", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = await response.json();
  console.log(`POST ${path} -> HTTP ${response.status} ${JSON.stringify(json)}`);
  return json as Record<string, any>;
};

await call("/api/v1/triggers/install", { yaml: spriteYaml() });
const dispatched = await call("/api/v1/manual-runs", {
  projectSlug: "unused",
  trigger: "sprite-review",
  actor: "qa",
  deliveryKey: `qa-${Date.now()}`,
  input: {},
});
const triggerRunId = dispatched["triggerRunId"] as string;
const counts = async () => {
  const q = async (sql: string) =>
    (await runtime.query<{ n: string }>(sql, [triggerRunId])).rows[0]!.n;
  return {
    status: (await database.findTriggerRunById(triggerRunId))?.status,
    wakeups: await q("select count(*)::text as n from workflow_wakeups where trigger_run_id = $1"),
    executions: (
      await runtime.query<{ n: string }>(
        "select count(*)::text as n from agent_executions where organization_id = $1",
        [organizationId],
      )
    ).rows[0]!.n,
    daemonLaunches: daemon.launches.length,
    daemonPrompts: daemon.prompts.length,
  };
};
const seen: string[] = [];
for (let second = 0; second <= 30; second += 1) {
  const snapshot = JSON.stringify(await counts());
  if (seen.at(-1) !== snapshot) console.log(`t=${second}s ${snapshot}`);
  seen.push(snapshot);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(`t=30s ${seen.at(-1)} (unchanged samples collapsed)`);
const run = await database.findTriggerRunById(triggerRunId);
console.log("\ntrigger run record =", JSON.stringify(run, null, 2));
console.log(
  "step runs =",
  JSON.stringify(await database.listWorkflowStepRunsForTriggerRun(triggerRunId), null, 2),
);
const usage = await runtime.query("select * from organization_usage where organization_id = $1", [
  organizationId,
]);
console.log("organization_usage rows =", JSON.stringify(usage.rows));
await application.hub.stop();
await runtime.close();
