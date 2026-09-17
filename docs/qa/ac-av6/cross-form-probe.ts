/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-av6/cross-form-probe.ts <origin> <slug> <state-dir> <out-dir>
// Does an environment write disturb the token card? Type a replacement token without saving, save a
// variable, then read the token field, the token card's notice, and the SummaryPanel's "Updated".
import { writeFileSync } from "node:fs";
import { chromium, expect } from "@playwright/test";

const [origin, slug, stateDir, outDir] = process.argv.slice(2) as string[];
const log: string[] = [];
const note = (line: string) => {
  log.push(line);
  console.log(line);
};

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    storageState: `${stateDir}/admin.json`,
    viewport: { width: 1280, height: 1400 },
  });
  const page = await context.newPage();
  await page.goto(`${origin}/o/${slug}/settings/sprites`);
  const token = page.locator('input[name="token"]');
  await expect(token).toBeVisible();
  await page.waitForLoadState("networkidle");
  note(
    `summary before: ${JSON.stringify(await page.getByRole("list", { name: "Sprites configuration" }).or(page.locator("dl")).first().innerText())}`,
  );
  await token.fill("half-typed-replacement-token");
  note(`token field before env save: ${JSON.stringify(await token.inputValue())}`);
  const form = page.getByRole("form", { name: "Set daemon environment variable" });
  await form.locator('input[name="key"]').fill("CROSS_FORM_PROBE");
  await form.locator('input[name="value"]').fill("probe");
  await form.getByRole("button", { name: "Save variable" }).click();
  await expect(
    page
      .getByRole("list", { name: "Daemon environment variables" })
      .getByText("CROSS_FORM_PROBE", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState("networkidle");
  note(
    `token field after env save: ${JSON.stringify(await page.locator('input[name="token"]').inputValue())}`,
  );
  await page.screenshot({
    path: `${outDir}/12-token-field-cleared-by-env-save.png`,
    fullPage: false,
  });
  await page.getByRole("button", { name: "Actions for CROSS_FORM_PROBE" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove variable" }).click();
  await expect(page.getByText("CROSS_FORM_PROBE", { exact: true })).toBeHidden({ timeout: 15000 });
} finally {
  writeFileSync(`${outDir}/cross-form-probe.log`, log.join("\n") + "\n");
  await browser.close();
}
