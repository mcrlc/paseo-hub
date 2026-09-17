/* QA evidence scripts: they print to stdout and inspect arbitrary thrown values. */
/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-fc6/editor-explicit-kind.ts
// Scratch check: a document with an explicit `kind: daemon` line survives a form save (patchTriggerYaml).
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import {
  patchTriggerYaml,
  projectTriggerForm,
} from "../../../src/triggers/configuration/editor.js";
import { TriggerDocumentSchema } from "../../../src/triggers/configuration/schema.js";
import { FIXTURES, withExplicitKind } from "./fixtures.js";

const source = withExplicitKind(FIXTURES["advanced with worktree (editor.test.ts)"]!);
const projection = projectTriggerForm(source);
assert.equal(
  projection.status,
  "editable",
  projection.status === "editable" ? "" : projection.reason,
);
if (projection.status !== "editable") throw new Error("unreachable");
console.log(`projected form: daemon=${projection.value.daemon} cwd=${projection.value.cwd}`);
assert.equal(patchTriggerYaml(source, projection.value), source);
console.log("unchanged form save returns the YAML byte-for-byte: ok");

const saved = patchTriggerYaml(source, {
  ...projection.value,
  daemon: "workshop",
  cwd: "/new-workspace",
  prompt: "Handle it differently.",
});
console.log("--- run.target block after form save ---");
const lines = saved.split("\n");
const start = lines.indexOf("  target:");
console.log(lines.slice(start, start + 7).join("\n"));
assert.ok(saved.startsWith("# keep this heading\n"));
console.log("comment '# keep this heading' preserved: ok");
assert.match(
  saved,
  /^  target:\n    kind: daemon\n    daemon: workshop\n    cwd: \/new-workspace\n    worktree:\n      mode: branch-off\n      newBranch: hub-work\n/mu,
);
console.log("explicit 'kind: daemon' line survives form save in place: ok");
const parsed = TriggerDocumentSchema.parse(parseDocument(saved).toJS());
assert.deepEqual(parsed.run.target, {
  kind: "daemon",
  daemon: "workshop",
  cwd: "/new-workspace",
  worktree: { mode: "branch-off", newBranch: "hub-work" },
});
console.log(`parsed run.target: ${JSON.stringify(parsed.run.target)}`);
console.log("RESULT: pass");
