/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/s3-seed-execution.ts <slug> <projectId> <machineId|none> <status> [startedAt]
// One agent execution on the sprite's machine, which is what "Last run" and the busy check read.
import { open, organizationId, revisionFor, seedExecution } from "./seed.js";

const [slug, projectId, machineId, status, startedAt] = process.argv.slice(2) as [
  string,
  string,
  string,
  "spawning" | "running" | "succeeded" | "failed",
  string | undefined,
];
const pg = await open();
const orgId = await organizationId(pg, slug);
const revisionId = await revisionFor(pg, orgId, projectId);
const id = await seedExecution(pg, {
  orgId,
  projectId,
  revisionId,
  machineId: machineId === "none" ? null : machineId,
  status,
  ...(startedAt === undefined ? {} : { startedAt }),
});
console.log(JSON.stringify({ executionId: id, revisionId }));
process.exit(0);
