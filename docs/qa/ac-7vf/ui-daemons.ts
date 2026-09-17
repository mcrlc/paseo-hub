/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/ui-daemons.ts <origin> <slug> <state.json> <out-dir>
// Scenario 2: the Daemons page for a sprite daemon and a hand-enrolled one.
import { chromium } from "@playwright/test";

const [origin, slug, state, out] = process.argv.slice(2) as [string, string, string, string];
const url = `${origin}/o/${slug}/daemons`;

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("table", { name: "Daemons" }).waitFor();
  await page.getByRole("row").filter({ hasText: "nightly-deploy" }).waitFor();

  const sprite = page.getByRole("row").filter({ hasText: "nightly-deploy" });
  const plain = page.getByRole("row").filter({ hasText: "devbox" });

  // What each row says, and what the pills really are in the DOM.
  const describe = async (row: typeof sprite, label: string) => {
    const pills = await row.locator("span.rounded-sm.inline-flex").all();
    const shape = await Promise.all(
      pills.map(async (pill) => ({
        text: (await pill.innerText()).trim(),
        className: await pill.getAttribute("class"),
        colour: await pill.evaluate((node) => getComputedStyle(node).color),
        background: await pill.evaluate((node) => getComputedStyle(node).backgroundColor),
      })),
    );
    console.log(`[${label}] cells: ${JSON.stringify(await row.locator("td").allInnerTexts())}`);
    console.log(`[${label}] pills: ${JSON.stringify(shape, null, 1)}`);
  };
  await describe(sprite, "sprite row");
  await describe(plain, "plain row");
  console.log(
    `[dom] badge elements on the page: ${await page.locator('[data-slot="badge"]').count()}`,
  );

  await page.screenshot({ path: `${out}/01-daemons-1280.png`, fullPage: true });

  // The sprite row's actions: Rename disabled, Revoke present.
  await sprite.getByRole("button", { name: "Actions for nightly-deploy" }).click();
  const spriteMenu = page.getByRole("menu");
  await spriteMenu.waitFor();
  console.log(
    `[sprite actions] ${JSON.stringify(
      await Promise.all(
        (await spriteMenu.getByRole("menuitem").all()).map(async (item) => ({
          label: (await item.innerText()).trim(),
          disabled: await item.getAttribute("aria-disabled"),
        })),
      ),
    )}`,
  );
  await page.screenshot({ path: `${out}/02-sprite-actions-rename-disabled.png` });
  await page.keyboard.press("Escape");
  await spriteMenu.waitFor({ state: "hidden" });

  await plain.getByRole("button", { name: "Actions for devbox" }).click();
  const plainMenu = page.getByRole("menu");
  await plainMenu.waitFor();
  console.log(
    `[daemon actions] ${JSON.stringify(
      await Promise.all(
        (await plainMenu.getByRole("menuitem").all()).map(async (item) => ({
          label: (await item.innerText()).trim(),
          disabled: await item.getAttribute("aria-disabled"),
        })),
      ),
    )}`,
  );
  await page.screenshot({ path: `${out}/03-daemon-actions-rename-enabled.png` });
  await page.keyboard.press("Escape");
  await plainMenu.waitFor({ state: "hidden" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("row").filter({ hasText: "nightly-deploy" }).waitFor();
  await page.screenshot({ path: `${out}/04-daemons-390.png`, fullPage: true });

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
