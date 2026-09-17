/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-64s/editor.ts
// Scenario 7: sprite targets are YAML-only in the editor bridge, the form patch refuses to rewrite them,
// and a YAML save with an unrelated prompt edit keeps the target block byte-identical in storage.
import { writeFileSync } from "node:fs";
import { createMemoryDatabase } from "../../../src/db/memory.js";
import { UNLIMITED_TEMPLATE } from "../../../src/entitlements/catalog.js";
import { EntitlementsService } from "../../../src/entitlements/service.js";
import {
  mergeTriggerForm,
  patchTriggerYaml,
  projectTriggerForm,
} from "../../../src/triggers/configuration/editor.js";
import { OrganizationTriggerStore } from "../../../src/triggers/store.js";
import { SPRITE_TARGET, daemonYaml, spriteYaml } from "./fixtures.js";

const sprite = spriteYaml();
console.log("== projectTriggerForm(sprite yaml) ==");
console.log(JSON.stringify(projectTriggerForm(sprite), null, 2));

const daemonProjection = projectTriggerForm(daemonYaml());
if (daemonProjection.status !== "editable") throw new Error("daemon fixture should be editable");
console.log("\n== patchTriggerYaml(sprite yaml, a daemon form value with an edited prompt) ==");
try {
  const out = patchTriggerYaml(sprite, { ...daemonProjection.value, prompt: "Edited via form." });
  console.log("RETURNED (unexpected):\n" + out);
} catch (error) {
  console.log(`threw ${(error as Error).name}: ${(error as Error).message}`);
}
console.log("\n== mergeTriggerForm(sprite yaml, form value) ==");
try {
  console.log(JSON.stringify(mergeTriggerForm(sprite, daemonProjection.value), null, 2));
} catch (error) {
  console.log(`threw ${(error as Error).name}: ${(error as Error).message}`);
}

console.log("\n== YAML save with a prompt edit through OrganizationTriggerStore ==");
const database = createMemoryDatabase({ organizationIds: ["org"] });
const entitlements = new EntitlementsService(database, { seats: async () => 0 });
await entitlements.stamp("org", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
await entitlements.override("org", { canUseSpriteTargets: true }, "qa", "ac-64s editor check");
const store = new OrganizationTriggerStore(database, "org", entitlements);
const first = await store.save({ yaml: sprite, userId: null });
const edited = sprite.replace("prompt: Review it.", "prompt: Review it carefully and summarize.");
const second = await store.save({ triggerId: first.id, yaml: edited, userId: null });
const before = (await database.findOrganizationTriggerRevision(first.id, first.activeRevisionId))!
  .yaml;
const after = (await store.activeRevision(second)).yaml;
writeFileSync("/tmp/ac64s-before.yml", before);
writeFileSync("/tmp/ac64s-after.yml", after);
const targetBlock = (yaml: string) =>
  yaml.slice(yaml.indexOf("  target:\n"), yaml.indexOf("  agent:"));
console.log(
  `revision versions: ${(await database.findOrganizationTriggerRevision(first.id, first.activeRevisionId))!.version} -> ${(await store.activeRevision(second)).version}`,
);
console.log(
  `target block before === authored SPRITE_TARGET: ${targetBlock(before) === SPRITE_TARGET}`,
);
console.log(
  `target block byte-identical after prompt edit: ${targetBlock(before) === targetBlock(after)}`,
);
console.log(`projection after save: ${JSON.stringify(projectTriggerForm(after))}`);
