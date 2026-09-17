/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/s3-seed-uncreated.ts <slug>
// A sprite-target trigger with no machine row at all: the "Not created" case.
import { open, organizationId, recorder, spriteMachineOf, spriteYaml, storeFor } from "./seed.js";

const slug = process.argv[2]!;
const pg = await open();
const orgId = await organizationId(pg, slug);
const { provider } = recorder();
const { store, settled } = await storeFor(pg, orgId, provider);
const trigger = await store.save({ yaml: spriteYaml("never-activated"), userId: null });
await settled();
const machine = await spriteMachineOf(pg, trigger.id);
await pg.runtime.query("delete from machines where id = $1", [machine.id]);
console.log(JSON.stringify({ triggerId: trigger.id, projectId: trigger.runtimeProjectId }));
process.exit(0);
