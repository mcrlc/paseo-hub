/* QA evidence scripts: they print to stdout and inspect arbitrary thrown values. */
/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-fc6/unknown-kinds.ts
import {
  compileTriggerDocument,
  TriggerDocumentError,
} from "../../../src/triggers/configuration/index.js";
import { FIXTURES } from "./fixtures.js";

const base = Object.values(FIXTURES)[0]!;
let failed = false;
for (const kind of ["fly", "docker", "sprite", '""']) {
  const yaml = base.replace("  target:\n", `  target:\n    kind: ${kind}\n`);
  try {
    compileTriggerDocument(yaml);
    console.log(`kind: ${kind} -> ACCEPTED (unexpected)`);
    failed = true;
  } catch (error) {
    if (!(error instanceof TriggerDocumentError)) throw error;
    for (const issue of error.issues) {
      console.log(
        `kind: ${kind} -> path=${issue.path.join(".")} message=${JSON.stringify(issue.message)}`,
      );
    }
    if (!error.issues.some(({ path }) => path.join(".") === "run.target.kind")) failed = true;
  }
}
console.log(failed ? "RESULT: fail" : "RESULT: pass (all rejected at run.target.kind)");
