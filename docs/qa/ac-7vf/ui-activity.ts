/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/ui-activity.ts <origin> <slug> <state.json> <out-dir>
// Scenario 6: the org Activity table, where a run dispatched to a sprite carries the machine pill.
import { chromium } from "@playwright/test";

const [origin, slug, state, out] = process.argv.slice(2) as [string, string, string, string];

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${origin}/o/${slug}/activity`);
  const table = page.getByRole("table", { name: "Trigger activity" });
  await table.waitFor();
  await page.getByRole("row").filter({ hasText: "nightly-deploy" }).first().waitFor();

  for (const name of ["nightly-deploy", "nightly-lint"]) {
    const row = page.getByRole("row").filter({ hasText: name }).first();
    console.log(`[${name}] cells: ${JSON.stringify(await row.locator("td").allInnerTexts())}`);
    for (const pill of await row.locator("span.rounded-sm.inline-flex").all()) {
      console.log(
        `[${name}] pill ${JSON.stringify({
          text: (await pill.innerText()).trim(),
          className: (await pill.getAttribute("class"))?.split(" ").slice(-2).join(" "),
        })}`,
      );
    }
  }
  console.log(`[dom] badge elements: ${await page.locator('[data-slot="badge"]').count()}`);
  await page.screenshot({ path: `${out}/21-activity-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("row").filter({ hasText: "nightly-deploy" }).first().waitFor();
  await page.screenshot({ path: `${out}/22-activity-390.png`, fullPage: true });
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
