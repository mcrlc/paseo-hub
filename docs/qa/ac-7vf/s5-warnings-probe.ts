/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/s5-warnings-probe.ts
// Scenario 5: triggerDocumentWarnings at the PR head, for the three warned shapes and a daemon
// target, which must stay quiet.
import assert from "node:assert/strict";
import { triggerDocumentWarnings } from "../../../src/triggers/configuration/editor.js";

const sprite = `name: pr-reviewer
enabled: true
on:
  github.issue_comment: {}
run:
  target:
    kind: sprite
    bootstrap: |
      echo bootstrapping
    cwd: /home/sprite/workspace/project
  agent: { provider: claude, mode: bypassPermissions }
  continuation: { mode: conversation }
  prompt: Review it.
`;
const daemon = sprite.replace(
  /  target:\n(?:.*\n)*?  agent:/u,
  "  target: { daemon: devbox, cwd: /workspace }\n  agent:",
);
const withGithub = (yaml: string) =>
  yaml.replace("  prompt:", "  github: { connection: acme-github }\n  prompt:");
const withTemplate = (yaml: string) =>
  yaml.replace(
    "  prompt:",
    "  env:\n    GITHUB_TOKEN: ${{ paseo.connections.acme-github.token }}\n  prompt:",
  );

const cases: Array<[string, string, number]> = [
  ["sprite + conversation + run.github", withGithub(sprite), 1],
  ["sprite + conversation + run.env template", withTemplate(sprite), 1],
  ["sprite + conversation + both", withTemplate(withGithub(sprite)), 1],
  ["sprite + conversation, neither", sprite, 0],
  [
    "sprite + mode new + run.github",
    withGithub(sprite).replace("mode: conversation", "mode: new"),
    0,
  ],
  ["daemon target + conversation + run.github", withGithub(daemon), 0],
  ["daemon target + conversation + run.env template", withTemplate(daemon), 0],
  ["document that does not parse", "name: [unterminated", 0],
];

for (const [label, yaml, expected] of cases) {
  const warnings = triggerDocumentWarnings(yaml);
  assert.equal(warnings.length, expected, `${label}: expected ${expected}, got ${warnings.length}`);
  console.log(
    `${label}: ${warnings.length} warning(s)${
      warnings.length === 0 ? "" : ` at ${warnings.map((w) => w.path.join(".")).join(", ")}`
    }`,
  );
  if (warnings[0] !== undefined) console.log(`  message: ${JSON.stringify(warnings[0].message)}`);
}
console.log("all cases as expected");
process.exit(0);
