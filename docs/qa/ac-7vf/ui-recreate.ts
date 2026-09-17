/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/ui-recreate.ts <origin> <slug> <triggerId> <state.json> <out-dir> <label> <n>
// Scenario 4: Recreate through the UI — the confirmation copy, then what the section says after.
import { chromium } from "@playwright/test";

const [origin, slug, triggerId, state, out, label, n] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 1100 },
  });
  const page = await context.newPage();
  const bodies: string[] = [];
  page.on("response", async (response) => {
    if (!response.url().includes("_serverFn")) return;
    bodies.push(
      `${response.status()} ${response.url().split("/").pop()?.slice(0, 20)} :: ${(await response.text().catch(() => "")).slice(0, 700)}`,
    );
  });
  await page.goto(`${origin}/o/${slug}/triggers/${triggerId}`);
  await page.getByRole("button", { name: "Cancel" }).waitFor();
  const section = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Sprite", exact: true }) });

  await section.getByRole("button", { name: "Sprite actions" }).click();
  await page.getByRole("menuitem", { name: "Recreate" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  console.log(`[${label}] confirmation: ${JSON.stringify(await dialog.innerText())}`);
  console.log(
    `[${label}] buttons: ${JSON.stringify(await dialog.getByRole("button").allInnerTexts())}`,
  );
  await page.screenshot({ path: `${out}/${n}-recreate-confirmation.png` });

  await dialog.getByRole("button", { name: "Recreate sprite" }).click();
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle").catch(() => undefined);

  const alerts = await page.getByRole("alert").allInnerTexts();
  console.log(`[${label}] alerts after confirm: ${JSON.stringify(alerts)}`);
  const status = await page.getByRole("status").allInnerTexts();
  console.log(`[${label}] live regions: ${JSON.stringify(status.filter((t) => t.trim() !== ""))}`);
  const terms = await section.locator("dt").allInnerTexts();
  const values = await section.locator("dd").allInnerTexts();
  console.log(
    `[${label}] rows after: ${JSON.stringify(terms.map((t, i) => [t.trim(), values[i]?.trim()]))}`,
  );
  console.log(
    `[${label}] Sprite actions kebab after: ${await section.getByRole("button", { name: "Sprite actions" }).count()}`,
  );
  await page.screenshot({
    path: `${out}/${String(Number(n) + 1).padStart(2, "0")}-recreate-after-${label}.png`,
    fullPage: true,
  });
  for (const body of bodies) console.log(`[${label}] wire: ${body}`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
