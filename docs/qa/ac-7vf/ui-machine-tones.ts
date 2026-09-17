/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/ui-machine-tones.ts <origin> <slug> <state.json> <out-dir> <status> <n>
// Scenario 2: the machine pill's tone for one machine status, on the Daemons page.
import { chromium } from "@playwright/test";

const [origin, slug, state, out, status, n] = process.argv.slice(2) as [
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
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(`${origin}/o/${slug}/daemons`);
  const row = page.getByRole("row").filter({ hasText: "nightly-deploy" });
  await row.waitFor();
  const pills = await row.locator("span.rounded-sm.inline-flex").all();
  for (const pill of pills) {
    console.log(
      `[${status}] ${JSON.stringify({
        text: (await pill.innerText()).trim(),
        className: (await pill.getAttribute("class"))?.split(" ").slice(-2).join(" "),
        colour: await pill.evaluate((node) => getComputedStyle(node).color),
      })}`,
    );
  }
  await page.screenshot({ path: `${out}/${n}-daemons-machine-${status}.png`, fullPage: true });
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
