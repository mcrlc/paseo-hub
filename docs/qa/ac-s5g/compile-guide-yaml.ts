/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-s5g/compile-guide-yaml.ts [repo-root]
// Extracts every fenced ```yaml block from docs/sprite-targets-guide.md (this checkout) and runs it
// through parseTriggerDocument and compileTriggerDocument from <repo-root>/src/triggers/configuration.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const guide = resolve(import.meta.dirname, "../../sprite-targets-guide.md");
const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../../.."));
const { parseTriggerDocument, compileTriggerDocument } = await import(
  pathToFileURL(resolve(root, "src/triggers/configuration/index.ts")).href
);
console.log(`guide: ${guide}\ncode:  ${root}`);

const text = readFileSync(guide, "utf8");
const blocks = [...text.matchAll(/^```yaml\n([\s\S]*?)^```$/gmu)].map((m) => ({
  yaml: m[1]!,
  line: text.slice(0, m.index).split("\n").length,
}));
console.log(`yaml blocks found: ${blocks.length}`);

let failures = 0;
const run = (label: string, yaml: string, expectFailure = false) => {
  console.log(`\n== ${label} ==`);
  try {
    const parsed = parseTriggerDocument(yaml);
    console.log(
      "parseTriggerDocument: ok; run.auto_archive =",
      parsed.run.auto_archive,
      "; continuation =",
      JSON.stringify(parsed.run.continuation),
    );
    const compiled = compileTriggerDocument(yaml);
    console.log("compileTriggerDocument: ok");
    console.log("compiled.environment =", JSON.stringify(compiled.environment, null, 2));
    console.log(
      "events =",
      JSON.stringify(compiled.events.map((e: any) => ({ on: e.on, filters: e.filters }))),
    );
    console.log("steps[0].prompt =", JSON.stringify(compiled.events[0].steps[0].prompt));
    if (expectFailure) {
      failures++;
      console.log("UNEXPECTED: accepted");
    }
  } catch (error) {
    console.log(expectFailure ? "rejected as expected:" : "FAILED:");
    console.log(String((error as Error).stack ?? error));
    if (!expectFailure) failures++;
  }
};

for (const [i, b] of blocks.entries()) run(`block ${i + 1} (guide line ${b.line})`, b.yaml);
// Control: guide line 51 says validation rejects auto_archive: false.
run(
  "control: block 1 with run.auto_archive: false",
  blocks[0]!.yaml + "  auto_archive: false\n",
  true,
);

console.log(`\nresult: ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exitCode = failures === 0 ? 0 : 1;
