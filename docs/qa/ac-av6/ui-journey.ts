/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-av6/ui-journey.ts <origin> <slug> <state-dir> <out-dir> <token-file> <value-a> <value-b>
// The admin's Settings → Sprites journey on a production build: no card before a token, token saved in
// the UI, empty state, form, validation, two variables added, Remove confirmation, list after removal.
// Every response the admin's browser receives goes to <state-dir>/browser-bodies.txt (grepped by the caller).
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, expect, type Locator, type Page } from "@playwright/test";

const [origin, slug, stateDir, outDir, tokenFile, valueA, valueB] = process.argv.slice(
  2,
) as string[];
const token: string = JSON.parse(readFileSync(tokenFile!, "utf8")).token;
const log: string[] = [];
const note = (line: string) => {
  log.push(line);
  console.log(line);
};

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: `${stateDir}/admin.json`,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const bodies: string[] = [];
  let responses = 0;
  page.on("response", async (response) => {
    responses += 1;
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "<no body>";
    }
    bodies.push(
      `### ${response.request().method()} ${response.url()} -> ${response.status()}\n${body}\n`,
    );
  });
  const envCard = () => page.getByRole("heading", { name: "Daemon environment" });
  const envForm = () => page.getByRole("form", { name: "Set daemon environment variable" });
  try {
    await page.goto(`${origin}/o/${slug}/settings/sprites`);
    const config = page.getByRole("form", { name: "Sprites configuration" });
    await expect(config).toBeVisible();
    await page.waitForLoadState("networkidle");
    note(`[01] before token: "Daemon environment" headings = ${await envCard().count()}`);
    note(`[01] main text: ${JSON.stringify(await page.locator("main").innerText())}`);
    await shot(page, "01-no-token-no-env-card.png");

    await config.locator('input[name="token"]').fill(token);
    await config.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Sprites configuration saved.")).toBeVisible({ timeout: 20000 });
    await expect(envCard()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const card = page.locator('[data-slot="card"]').filter({ has: envCard() });
    const cardOrMain = (await card.count()) === 1 ? card : page.locator("main");
    note(`[02] env card text: ${JSON.stringify(await cardOrMain.innerText())}`);
    await shot(page, "02-empty-state-after-token.png");

    const form = envForm();
    const value = form.locator('input[name="value"]');
    note(`[03] value input outerHTML: ${await value.evaluate((el) => el.outerHTML)}`);
    note(`[03] value input type: ${await value.getAttribute("type")}`);
    note(
      `[03] name input outerHTML: ${await form.locator('input[name="key"]').evaluate((el) => el.outerHTML)}`,
    );
    note(
      `[03] buttons inside the env form: ${JSON.stringify(await form.getByRole("button").allInnerTexts())}`,
    );
    note(
      `[03] value field wrapper HTML: ${await value.evaluate((el) => el.parentElement?.parentElement?.outerHTML ?? "")}`,
    );
    await form.locator('input[name="key"]').fill("CLAUDE_CODE_OAUTH_TOKEN");
    await value.fill("typed-but-not-submitted");
    await shot(page, "03-form-filled.png", cardOrMain);
    note(`[03] value input still type=${await value.getAttribute("type")} after typing`);

    const posts = () => bodies.filter((b) => b.startsWith("### POST")).length;
    for (const [shotName, key, val, expected] of [
      [
        "04-validation-bad-name.png",
        "lower",
        "some-value",
        "Use capital letters, digits, and underscores, not starting with a digit.",
      ],
      [
        "05-validation-reserved-name.png",
        "PASEO_PASSWORD",
        "some-value",
        "Hub sets PASEO_PASSWORD on every sprite; choose another name.",
      ],
      ["06-validation-empty-value.png", "CLAUDE_CODE_OAUTH_TOKEN", "   ", "Enter a value."],
    ] as const) {
      const before = posts();
      await form.locator('input[name="key"]').fill(key);
      await value.fill(val);
      await form.getByRole("button", { name: "Save variable" }).click();
      await expect(form.getByText(expected)).toBeVisible();
      note(
        `[${shotName.slice(0, 2)}] ${key}/${JSON.stringify(val)} → ${JSON.stringify(await form.innerText())}; POSTs sent: ${posts() - before}`,
      );
      note(
        `[${shotName.slice(0, 2)}] aria-invalid name/value: ${await form.locator('input[name="key"]').getAttribute("aria-invalid")} / ${await value.getAttribute("aria-invalid")}`,
      );
      await shot(page, shotName, cardOrMain);
    }

    for (const [key, val] of [
      ["CLAUDE_CODE_OAUTH_TOKEN", valueA],
      ["OPENAI_API_KEY", valueB],
    ] as const) {
      await envForm().locator('input[name="key"]').fill(key);
      await envForm().locator('input[name="value"]').fill(val!);
      await envForm().getByRole("button", { name: "Save variable" }).click();
      await expect(
        page
          .getByRole("list", { name: "Daemon environment variables" })
          .getByText(key, { exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await page.waitForLoadState("networkidle");
    }
    note(`[07] after two adds, card text: ${JSON.stringify(await cardOrMain.innerText())}`);
    note(`[07] notice visible: ${await page.getByText("Variable saved.").isVisible()}`);
    note(
      `[07] value field after save: ${JSON.stringify(await envForm().locator('input[name="value"]').inputValue())}`,
    );
    await shot(page, "07-list-two-keys.png");

    await page.reload();
    await page.waitForLoadState("networkidle");
    const list = page.getByRole("list", { name: "Daemon environment variables" });
    await expect(list).toBeVisible();
    note(`[07b] reloaded list text: ${JSON.stringify(await list.innerText())}`);
    note(`[07b] list HTML: ${await list.evaluate((el) => el.outerHTML)}`);
    note(
      `[07b] rendered page contains value A: ${(await page.content()).includes(valueA!)}, value B: ${(await page.content()).includes(valueB!)}`,
    );

    await page.getByRole("button", { name: "Actions for OPENAI_API_KEY" }).click();
    note(`[08] menu items: ${JSON.stringify(await page.getByRole("menuitem").allInnerTexts())}`);
    await page.getByRole("menuitem", { name: "Remove" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    note(`[08] dialog text: ${JSON.stringify(await dialog.innerText())}`);
    await shot(page, "08-remove-confirmation.png");
    await dialog.getByRole("button", { name: "Remove variable" }).click();
    await expect(list.getByText("OPENAI_API_KEY", { exact: true })).toBeHidden({ timeout: 15000 });
    await page.waitForLoadState("networkidle");
    note(`[09] after removal card text: ${JSON.stringify(await cardOrMain.innerText())}`);
    await shot(page, "09-list-after-removal.png");

    // Stale notice probe (same shape as ac-0yj F1): save succeeds, then an invalid submit.
    await envForm().locator('input[name="key"]').fill("QA_PROBE");
    await envForm().locator('input[name="value"]').fill("probe");
    await envForm().getByRole("button", { name: "Save variable" }).click();
    await expect(list.getByText("QA_PROBE", { exact: true })).toBeVisible({ timeout: 15000 });
    await page.waitForLoadState("networkidle");
    note(
      `[10] after QA_PROBE save, "Variable saved." visible: ${await page.getByText("Variable saved.").isVisible()}`,
    );
    await envForm().getByRole("button", { name: "Save variable" }).click();
    await page.waitForTimeout(500);
    note(`[10] after empty submit: ${JSON.stringify(await envForm().innerText())}`);
    await shot(page, "10-after-save-then-empty-submit.png", cardOrMain);
    await page.getByRole("button", { name: "Actions for QA_PROBE" }).click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove variable" }).click();
    await expect(list.getByText("QA_PROBE", { exact: true })).toBeHidden({ timeout: 15000 });
    await page.waitForLoadState("networkidle");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await shot(page, "11-phone-width.png");
  } finally {
    note(`browser responses captured: ${responses}`);
    writeFileSync(`${stateDir}/browser-bodies.txt`, bodies.join("\n"));
    writeFileSync(`${outDir}/ui-journey.log`, log.join("\n") + "\n");
    await browser.close();
  }
}

async function shot(page: Page, name: string, locator?: Locator) {
  if (locator) await locator.screenshot({ path: `${outDir}/${name}` });
  else await page.screenshot({ path: `${outDir}/${name}`, fullPage: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
