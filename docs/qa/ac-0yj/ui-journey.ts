/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-0yj/ui-journey.ts <step> <origin> <slug> <state-dir> <out-dir> [token] [memory]
//   step "access":   member and admin settings navigation, direct member visit to the Sprites route
//   step "first":    not-configured state, password field, validation, first save with default memory
//   step "replace":  save a second token with the given memory, configured summary afterwards
// Every response body the admin's browser receives is written to <out-dir>/browser-bodies-<step>.txt
// and the Sprites server-function requests to <state-dir>/serverfn-<step>.json for curl replay.
import { writeFileSync } from "node:fs";
import { chromium, expect, type Page } from "@playwright/test";

const [step, origin, slug, stateDir, outDir, token = "", memory = ""] = process.argv.slice(2);
const settings = (section: string) => `${origin}/o/${slug}/settings/${section}`;
const log: string[] = [];
const note = (line: string) => {
  log.push(line);
  console.log(line);
};

async function main() {
  const browser = await chromium.launch();
  const open = async (who: string) => {
    const context = await browser.newContext({
      storageState: `${stateDir}/${who}.json`,
      viewport: { width: 1280, height: 900 },
    });
    return { context, page: await context.newPage() };
  };
  try {
    if (step === "access") {
      const member = await open("member");
      await member.page.goto(settings("team"));
      await expect(member.page.getByRole("heading", { name: "Team", level: 1 })).toBeVisible();
      const memberLinks = await settingsLinks(member.page);
      note(`member settings nav links: ${JSON.stringify(memberLinks)}`);
      await shot(member.page, "01-member-settings-nav-no-sprites.png");
      await member.page.goto(settings("sprites"));
      await expect(member.page.getByRole("heading", { name: "Sprites", level: 1 })).toBeVisible();
      await member.page.waitForLoadState("networkidle");
      note(`member direct visit main text: ${JSON.stringify(await mainText(member.page))}`);
      await shot(member.page, "02-member-sprites-route-no-access.png");

      const admin = await open("admin");
      await admin.page.goto(settings("team"));
      await expect(admin.page.getByRole("heading", { name: "Team", level: 1 })).toBeVisible();
      note(`admin settings nav links: ${JSON.stringify(await settingsLinks(admin.page))}`);
      await shot(admin.page, "03-admin-settings-nav-with-sprites.png");
      return;
    }

    const { page } = await open("admin");
    const bodies: string[] = [];
    const serverFns: unknown[] = [];
    page.on("response", async (response) => {
      const request = response.request();
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "<no body>";
      }
      bodies.push(`### ${request.method()} ${response.url()} -> ${response.status()}\n${body}\n`);
      if (response.url().includes("/_serverFn/")) {
        serverFns.push({
          method: request.method(),
          url: response.url(),
          headers: await request.allHeaders(),
          postData: request.postData(),
          status: response.status(),
          body,
        });
      }
    });

    if (step === "first") {
      await page.goto(settings("team"));
      await page
        .getByRole("navigation", { name: "Organization settings" })
        .getByRole("link", { name: "Sprites" })
        .click();
      await expect(page).toHaveURL(/\/settings\/sprites$/u);
      await expect(page.getByRole("form", { name: "Sprites configuration" })).toBeVisible();
      note(`not-configured main text: ${JSON.stringify(await mainText(page))}`);
      await shot(page, "04-admin-not-configured.png");

      const form = page.getByRole("form", { name: "Sprites configuration" });
      const tokenInput = form.locator('input[name="token"]');
      note(`token input outerHTML: ${await tokenInput.evaluate((el) => el.outerHTML)}`);
      note(`token input type: ${await tokenInput.getAttribute("type")}`);
      note(
        `buttons inside the form: ${JSON.stringify(await form.getByRole("button").allInnerTexts())}`,
      );
      note(
        `token field container HTML: ${await tokenInput.evaluate((el) => el.closest("[data-slot], div")?.parentElement?.outerHTML ?? "")}`,
      );
      await shot(page, "05-token-field-password.png", form);

      await tokenInput.fill("");
      await form.locator('input[name="memoryMb"]').fill("0");
      await form.getByRole("button", { name: "Save" }).click();
      await expect(form.getByText("Enter the Sprites organization token.")).toBeVisible();
      await expect(form.getByText("Enter a whole number of megabytes above zero.")).toBeVisible();
      note(`validation form text: ${JSON.stringify(await form.innerText())}`);
      note(
        `aria-invalid token/memory: ${await tokenInput.getAttribute("aria-invalid")} / ${await form.locator('input[name="memoryMb"]').getAttribute("aria-invalid")}`,
      );
      note(
        `server functions sent by invalid submit: ${serverFns.filter((f: any) => f.method === "POST").length}`,
      );
      await shot(page, "06-validation-empty-token-memory-0.png");

      await page.reload();
      await expect(page.getByRole("form", { name: "Sprites configuration" })).toBeVisible();
      note(
        `memory field value before first save: ${await form.locator('input[name="memoryMb"]').inputValue()}`,
      );
      await form.locator('input[name="token"]').fill(token);
      await form.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Sprites configuration saved.")).toBeVisible();
      await page.waitForLoadState("networkidle");
      note(`after save main text: ${JSON.stringify(await mainText(page))}`);
      await shot(page, "07-saved-notice.png");
      note(
        `token input value after save: ${JSON.stringify(await form.locator('input[name="token"]').inputValue())}`,
      );

      await page.reload();
      await expect(page.getByRole("form", { name: "Sprites configuration" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      note(`configured (reloaded) main text: ${JSON.stringify(await mainText(page))}`);
      await shot(page, "08-configured-summary-replace-form.png");
    }

    if (step === "replace") {
      await page.goto(settings("sprites"));
      const form = page.getByRole("form", { name: "Sprites configuration" });
      await expect(form).toBeVisible();
      await form.locator('input[name="token"]').fill(token);
      await form.locator('input[name="memoryMb"]').fill(memory);
      await form.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Sprites configuration saved.")).toBeVisible();
      await page.waitForLoadState("networkidle");
      note(`after replace main text: ${JSON.stringify(await mainText(page))}`);
      await shot(page, "09-replaced-16384.png");
    }

    writeFileSync(`${outDir}/browser-bodies-${step}.txt`, bodies.join("\n"));
    writeFileSync(`${stateDir}/serverfn-${step}.json`, JSON.stringify(serverFns, null, 2));
  } finally {
    writeFileSync(`${outDir}/ui-${step}.log`, log.join("\n") + "\n");
    await browser.close();
  }
}

async function settingsLinks(page: Page) {
  return page
    .getByRole("navigation", { name: "Organization settings" })
    .getByRole("link")
    .allInnerTexts();
}

async function mainText(page: Page) {
  return page.locator("main").innerText();
}

async function shot(page: Page, name: string, locator?: ReturnType<Page["locator"]>) {
  if (locator) await locator.screenshot({ path: `${outDir}/${name}` });
  else await page.screenshot({ path: `${outDir}/${name}`, fullPage: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
