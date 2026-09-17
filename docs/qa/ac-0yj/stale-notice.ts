/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-0yj/stale-notice.ts <origin> <slug> <state-dir> <out-dir> <token>
// Saves successfully, then submits the same form with an empty token, to see which messages show together.
import { chromium, expect } from "@playwright/test";
const [origin, slug, stateDir, outDir, token] = process.argv.slice(2);
const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: `${stateDir}/admin.json`,
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
await page.goto(`${origin}/o/${slug}/settings/sprites`);
const form = page.getByRole("form", { name: "Sprites configuration" });
await form.locator('input[name="token"]').fill(token!);
await form.locator('input[name="memoryMb"]').fill("16384");
await form.getByRole("button", { name: "Save" }).click();
await expect(page.getByText("Sprites configuration saved.")).toBeVisible();
await page.waitForLoadState("networkidle");
await form.getByRole("button", { name: "Save" }).click();
await expect(form.getByText("Enter the Sprites organization token.")).toBeVisible();
console.log(
  `success notice still visible alongside the token error: ${await page.getByText("Sprites configuration saved.").isVisible()}`,
);
await page.screenshot({
  path: `${outDir}/10-success-notice-beside-validation-error.png`,
  fullPage: true,
});
await browser.close();
