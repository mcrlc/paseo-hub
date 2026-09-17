/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-vni/s2-editor-messages.ts
// Scenario 2: the two refusal messages at run.target.kind, on Postgres. The previous active revision is a
// disabled sprite trigger (disabled saves skip the activation check), so the enabled save is the one refused.
import type { SpriteProvider } from "../../../src/daemons/sprites/activation.js";
import {
  activationStore,
  openPostgres,
  seedOrganization,
  spriteMachines,
  spriteYaml,
} from "./pg-common.js";

const pg = await openPostgres();
const calls: string[] = [];
const provider: SpriteProvider = {
  create: async () => (calls.push("create"), "id"),
  exec: async () => (calls.push("exec"), { stdout: "/p", stderr: "", exitCode: 0 }),
  service: async () => void calls.push("service"),
  destroy: async () => void calls.push("destroy"),
};

async function run(label: string, configured: boolean, withActivation: boolean) {
  console.log(`\n=== ${label} ===`);
  const org = await seedOrganization(pg, { configured });
  const { store } = activationStore(pg, org, withActivation ? provider : null);
  const v1 = await store.save({ yaml: spriteYaml({ enabled: false }), userId: null });
  const before = await store.activeRevision(v1);
  console.log(
    `v1 saved disabled: activeRevisionId=${v1.activeRevisionId} version=${before.version} enabled=${v1.enabled}`,
  );
  try {
    await store.save({ triggerId: v1.id, yaml: spriteYaml({ enabled: true }), userId: null });
    console.log("UNEXPECTED: enabled save succeeded");
  } catch (error) {
    const issues = (error as { issues?: { path: unknown[]; message: string }[] }).issues ?? [];
    console.log(`enabled save REJECTED ${(error as Error).name}: ${(error as Error).message}`);
    for (const issue of issues)
      console.log(`  path=${issue.path.join(".")} message=${issue.message}`);
  }
  const [after] = await store.list();
  const revision = await store.activeRevision(after!);
  console.log(
    `after: activeRevisionId=${after!.activeRevisionId} version=${revision.version} enabled=${after!.enabled} unchanged=${after!.activeRevisionId === v1.activeRevisionId && revision.yaml === before.yaml}`,
  );
  try {
    await store.save({
      yaml: spriteYaml({ enabled: true }).replace("qa-sprite", "qa-sprite-new"),
      userId: null,
    });
    console.log("UNEXPECTED: new enabled trigger saved");
  } catch (error) {
    console.log(`new enabled trigger REJECTED: ${(error as Error).message}`);
  }
  console.log(
    `triggers in org: ${(await store.list()).length}; machines for v1: ${(await spriteMachines(pg, v1.id)).length}; provider calls: ${calls.length}`,
  );
}

await run("no Sprites configuration for the organization", false, true);
await run(
  "spriteActivation null (Hub without public base URL / API keys), org configured",
  true,
  false,
);
await pg.runtime.close();
