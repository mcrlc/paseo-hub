/* QA evidence scripts: they print to stdout and inspect arbitrary thrown values. */
/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-fc6/legacy-migration.ts
// Fixture: the legacy bundle from src/triggers/configuration/legacy-migration.test.ts, with a worktree added.
import { isDeepStrictEqual } from "node:util";
import {
  migrateLegacyBundle,
  parseTriggerDocument,
} from "../../../src/triggers/configuration/index.js";

const migrated = migrateLegacyBundle({
  files: [
    {
      path: ".paseo/hub.yml",
      content: `
environments:
  runner:
    kind: daemon
    daemon: devbox
    cwd: /workspace/company
    worktree:
      mode: branch-off
      newBranch: hub-work
agents:
  codex:
    provider: codex
    model: gpt-5.6-sol
`,
    },
    {
      path: ".paseo/workflows/slack.yml",
      content: `
name: slack-help
on: slack.mention
max_runtime: 2h
filters:
  connection: acme-slack
  from_users: [U123]
steps:
  - id: work
    environment: runner
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt:
      - include: partials/safety.md
      - text: "Request: \${{ paseo.prompt }}"
    allow_outputs:
      - { type: slack.reply, max: 5 }
`,
    },
    { path: ".paseo/workflows/partials/safety.md", content: "Never disclose secrets." },
  ],
});

const trigger = migrated[0];
if (migrated.length !== 1 || trigger?.format !== "single_run")
  throw new Error(`unexpected migration: ${JSON.stringify(migrated)}`);
console.log("--- migrated trigger YAML ---");
console.log(trigger.yaml);
const kindLines = trigger.yaml.split("\n").filter((line) => /^\s+kind: daemon$/u.test(line));
console.log(`contains 'kind: daemon' line: ${kindLines.length === 1}`);
const withKind = parseTriggerDocument(trigger.yaml);
const withoutKindYaml = trigger.yaml.replace(/^\s+kind: daemon\n/mu, "");
console.log(
  `kind line removed: ${withoutKindYaml !== trigger.yaml && !withoutKindYaml.includes("kind:")}`,
);
const withoutKind = parseTriggerDocument(withoutKindYaml);
console.log("parseTriggerDocument(with kind) accepted: true");
console.log(`parsed.run.target (with kind)    = ${JSON.stringify(withKind.run.target)}`);
console.log(`parsed.run.target (without kind) = ${JSON.stringify(withoutKind.run.target)}`);
const equal = isDeepStrictEqual(withKind, withoutKind);
console.log(`isDeepStrictEqual(parsed with kind, parsed without kind): ${equal}`);
console.log(kindLines.length === 1 && equal ? "RESULT: pass" : "RESULT: fail");
