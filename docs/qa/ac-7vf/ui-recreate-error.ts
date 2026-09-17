/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/ui-recreate-error.ts <origin> <slug> <triggerId> <state.json> <out-dir> <pg-container>
// Scenario 4: what the browser is told when recreate hits an error the reader cannot act on.
// The page is loaded first, then `machines` is renamed away for the one mutation, then restored.
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const [origin, slug, triggerId, state, out, container] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const psql = (sql: string) =>
  execFileSync("docker", ["exec", container, "psql", "-U", "qa", "-d", "qa", "-tAc", sql])
    .toString()
    .trim();

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 1100 },
  });
  const page = await context.newPage();
  await page.goto(`${origin}/o/${slug}/triggers/${triggerId}`);
  await page.getByRole("button", { name: "Cancel" }).waitFor();
  const section = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Sprite", exact: true }) });
  await section.getByRole("button", { name: "Sprite actions" }).click();
  await page.getByRole("menuitem", { name: "Recreate" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();

  console.log(`hide machines: ${psql("alter table machines rename to machines_qa_hidden")}`);
  try {
    await dialog.getByRole("button", { name: "Recreate sprite" }).click();
    await page.getByText(/wasn't recreated/u).waitFor({ timeout: 20000 });
  } finally {
    console.log(`restore machines: ${psql("alter table machines_qa_hidden rename to machines")}`);
  }
  const alert = page.getByRole("alert").filter({ hasText: "wasn't recreated" });
  console.log(`alert: ${JSON.stringify(await alert.innerText())}`);
  await page.screenshot({ path: `${out}/17-recreate-unexpected-error.png`, fullPage: true });
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
