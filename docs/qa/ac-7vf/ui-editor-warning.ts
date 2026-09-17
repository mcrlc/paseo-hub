/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/ui-editor-warning.ts <origin> <slug> <triggerId> <state.json> <out-dir>
// Scenario 5: the 5.7 warning in the trigger editor, and that it never blocks the save.
import { chromium, type Page } from "@playwright/test";

const [origin, slug, triggerId, state, out] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];

const BASE = `name: pr-reviewer
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
const WITH_GITHUB = BASE.replace("  prompt:", "  github: { connection: acme-github }\n  prompt:");
const WITH_TEMPLATE = BASE.replace(
  "  prompt:",
  "  env:\n    GITHUB_TOKEN: ${{ paseo.connections.acme-github.token }}\n  prompt:",
);

async function setYaml(page: Page, yaml: string) {
  const editor = page.getByRole("textbox", { name: "Trigger YAML" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(yaml);
  await page.waitForTimeout(600);
}

async function report(page: Page, label: string) {
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Continuation ends when the leased credential does" });
  const present = (await alert.count()) > 0;
  console.log(`[${label}] warning present: ${present}`);
  if (present) console.log(`[${label}] text: ${JSON.stringify(await alert.innerText())}`);
  // The header action and the form's own button are the same submit; both must stay live.
  for (const save of await page.getByRole("button", { name: /^Save/u }).all()) {
    console.log(
      `[${label}] save "${(await save.innerText()).trim()}" disabled: ${await save.isDisabled()}`,
    );
  }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 1100 },
  });
  const page = await context.newPage();
  // A sprite target cannot be represented as a form, so this trigger opens in YAML mode.
  await page.goto(`${origin}/o/${slug}/triggers/${triggerId}`);
  await page.getByRole("textbox", { name: "Trigger YAML" }).waitFor();

  await setYaml(page, WITH_GITHUB);
  await report(page, "run.github");
  await page.screenshot({ path: `${out}/18-editor-warning-run-github.png`, fullPage: true });

  await setYaml(page, WITH_TEMPLATE);
  await report(page, "run.env connection template");
  await page.screenshot({ path: `${out}/19-editor-warning-run-env-template.png`, fullPage: true });

  await setYaml(page, BASE);
  await report(page, "neither (run.github removed)");
  await page.screenshot({ path: `${out}/20-editor-warning-gone.png`, fullPage: true });

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
