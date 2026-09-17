/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/s2-seed.ts <organization-slug>
// Scenario 2 and 3 state: one hand-enrolled daemon, one sprite daemon on an `alive` machine whose
// trigger is `nightly-deploy`, and a daemon-target trigger for the "no Sprite section" case.
import { UNLIMITED_TEMPLATE } from "../../../src/entitlements/catalog.js";
import {
  bindSpriteDaemon,
  daemonYaml,
  open,
  organizationId,
  recorder,
  seedPlainDaemon,
  setMachineStatus,
  spriteMachineOf,
  spriteYaml,
  storeFor,
} from "./seed.js";

const slug = process.argv[2]!;
const pg = await open();
const orgId = await organizationId(pg, slug);

const { provider } = recorder();
const { store, entitlements, settled } = await storeFor(pg, orgId, provider);
await entitlements.stamp(orgId, UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
await entitlements.override(orgId, { canUseSpriteTargets: true }, "qa", "ac-7vf");
await pg.database.upsertOrganizationSpritesConfiguration({
  organizationId: orgId,
  token: "ac7vf-fake-sprites-token",
  memoryMb: 8192,
  updatedByUserId: null,
});

const plain = await seedPlainDaemon(pg, orgId, "devbox");
const daemonTrigger = await store.save({
  yaml: daemonYaml("nightly-lint", "devbox"),
  userId: null,
});
const spriteTrigger = await store.save({ yaml: spriteYaml("nightly-deploy"), userId: null });
await settled();
const machine = await spriteMachineOf(pg, spriteTrigger.id);
await setMachineStatus(pg, machine.id, "alive");
const spriteDaemonId = await bindSpriteDaemon(pg, orgId, machine.id, spriteTrigger.name);

console.log(
  JSON.stringify(
    {
      organizationId: orgId,
      plainDaemonId: plain.daemonId,
      daemonTriggerId: daemonTrigger.id,
      daemonTriggerProjectId: daemonTrigger.runtimeProjectId,
      spriteTriggerId: spriteTrigger.id,
      spriteTriggerProjectId: spriteTrigger.runtimeProjectId,
      spriteMachineId: machine.id,
      spriteDaemonId,
    },
    null,
    2,
  ),
);
process.exit(0);
