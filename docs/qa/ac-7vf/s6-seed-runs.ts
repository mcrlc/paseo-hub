/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/s6-seed-runs.ts <slug> <spriteProjectId> <spriteMachineId> <daemonProjectId> <daemonMachineId>
// Scenario 6: one run dispatched to a sprite and one to an ordinary daemon machine, each with the
// step run and agent execution that link a run to a machine.
import { open, organizationId, revisionFor, seedExecution, seedRun } from "./seed.js";

const [slug, spriteProject, spriteMachine, daemonProject, daemonMachine] = process.argv.slice(
  2,
) as [string, string, string, string, string];
const pg = await open();
const orgId = await organizationId(pg, slug);

for (const [label, projectId, machineId, name, source, repo] of [
  [
    "sprite run",
    spriteProject,
    spriteMachine,
    "nightly-deploy",
    "github.issue_comment",
    "acme/hub",
  ],
  ["daemon run", daemonProject, daemonMachine, "nightly-lint", "github.push", "acme/site"],
] as const) {
  const revisionId = await revisionFor(pg, orgId, projectId);
  const { runId, stepRunId } = await seedRun(pg, {
    orgId,
    projectId,
    revisionId,
    triggerName: name,
    provider: "github",
    source,
    repo,
    status: "running",
  });
  const executionId = await seedExecution(pg, {
    orgId,
    projectId,
    revisionId,
    machineId,
    status: "running",
    stepRunId,
  });
  console.log(JSON.stringify({ label, runId, stepRunId, executionId }));
}
process.exit(0);
