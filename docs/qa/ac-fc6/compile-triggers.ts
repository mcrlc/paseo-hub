/* QA evidence scripts: they print to stdout and inspect arbitrary thrown values. */
/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-fc6/compile-triggers.ts [--explicit-kind] [--part=full|environment-events]
import { compileTriggerDocument } from "../../../src/triggers/configuration/index.js";
import { FIXTURES, withExplicitKind } from "./fixtures.js";

const explicit = process.argv.includes("--explicit-kind");
const part = process.argv.find((arg) => arg.startsWith("--part="))?.slice(7) ?? "full";
for (const [label, source] of Object.entries(FIXTURES)) {
  const compiled = compileTriggerDocument(explicit ? withExplicitKind(source) : source);
  const view =
    part === "full" ? compiled : { environment: compiled.environment, events: compiled.events };
  console.log(`### ${label}`);
  console.log(JSON.stringify(view, null, 2));
}
