/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/measure-rows.ts <origin> <slug> <state.json>
// The row heights behind finding F3: a row carrying two pills against one carrying one.
import { chromium } from "@playwright/test";
const [origin, slug, state] = process.argv.slice(2) as [string, string, string];
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } })
).newPage();
await page.goto(`${origin}/o/${slug}/daemons`);
await page.getByRole("row").filter({ hasText: "nightly-deploy" }).waitFor();
for (const name of ["devbox", "nightly-deploy"]) {
  const row = page.getByRole("row").filter({ hasText: name }).first();
  const box = await row.boundingBox();
  console.log(`${name}: row height ${Math.round(box!.height)}px`);
}
await page.goto(`${origin}/o/${slug}/activity`);
await page.getByRole("row").filter({ hasText: "nightly-deploy" }).first().waitFor();
for (const name of ["nightly-lint", "nightly-deploy"]) {
  const row = page.getByRole("row").filter({ hasText: name }).first();
  const box = await row.boundingBox();
  console.log(`activity ${name}: row height ${Math.round(box!.height)}px`);
}
await browser.close();
process.exit(0);
