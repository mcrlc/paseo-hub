/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/ui-sprite-section.ts <origin> <slug> <triggerId> <state.json> <out-dir> <label> <n>
// Scenario 3: the Sprite section on trigger detail, its rows, and the gap to its neighbours.
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
  await page.goto(`${origin}/o/${slug}/triggers/${triggerId}`);
  await page.getByRole("button", { name: "Cancel" }).waitFor();
  await page.waitForLoadState("networkidle");

  const heading = page.getByRole("heading", { name: "Sprite", exact: true });
  const present = (await heading.count()) > 0;
  console.log(`[${label}] Sprite section present: ${present}`);
  if (!present) {
    await page.screenshot({ path: `${out}/${n}-sprite-section-${label}-1280.png`, fullPage: true });
    await browser.close();
    return;
  }

  const section = page.locator("section").filter({ has: heading });
  console.log(
    `[${label}] description: ${JSON.stringify(await section.locator("p").first().innerText())}`,
  );
  const terms = await section.locator("dt").allInnerTexts();
  const values = await section.locator("dd").allInnerTexts();
  console.log(
    `[${label}] rows: ${JSON.stringify(terms.map((t, i) => [t.trim(), values[i]?.trim()]))}`,
  );
  const pills = await section.locator("span.rounded-sm.inline-flex").all();
  for (const pill of pills) {
    console.log(
      `[${label}] pill ${JSON.stringify({
        text: (await pill.innerText()).trim(),
        className: (await pill.getAttribute("class"))?.split(" ").slice(-2).join(" "),
      })}`,
    );
  }
  console.log(
    `[${label}] Sprite actions kebab: ${await section.getByRole("button", { name: "Sprite actions" }).count()}`,
  );
  console.log(
    `[${label}] badge elements in section: ${await section.locator('[data-slot="badge"]').count()}`,
  );

  // Gap to the neighbour above, and the section's own bottom margin.
  const geometry = await section.evaluate((node) => {
    const previous = node.previousElementSibling;
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return {
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      parentGap: previous === null ? null : getComputedStyle(node.parentElement!).rowGap,
      parentDisplay:
        node.parentElement === null ? null : getComputedStyle(node.parentElement).display,
      previousTag: previous === null ? null : `${previous.tagName.toLowerCase()}`,
      gapAbove:
        previous === null ? null : Math.round(box.top - previous.getBoundingClientRect().bottom),
      isLastChild: node.nextElementSibling === null,
    };
  });
  console.log(`[${label}] geometry: ${JSON.stringify(geometry)}`);

  await page.screenshot({ path: `${out}/${n}-sprite-section-${label}-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const narrow = await section.evaluate((node) => {
    const previous = node.previousElementSibling;
    const box = node.getBoundingClientRect();
    return previous === null ? null : Math.round(box.top - previous.getBoundingClientRect().bottom);
  });
  console.log(`[${label}] gap above at 390: ${String(narrow)}`);
  await page.screenshot({ path: `${out}/${n}-sprite-section-${label}-390.png`, fullPage: true });
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
