/* oxlint-disable */
// Usage: npx tsx docs/qa/ac-7vf/setup-accounts.ts <origin> <state-dir>
// Walks the bootstrap owner through the password change, invites an admin and a member through the
// Team UI, has each accept, and saves every account's browser storage state for later scripts.
import { chromium, expect, type Browser, type Page } from "@playwright/test";

const [origin = "http://127.0.0.1:3000", stateDir = "/tmp/ac7vf/state"] = process.argv.slice(2);
const OWNER = { email: "owner@ac7vf.test", password: "ac7vf-owner-password" };
const OWNER_NEW_PASSWORD = "ac7vf-owner-password-2";

async function main() {
  const browser = await chromium.launch();
  try {
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await ownerPage.goto(origin);
    const signIn = ownerPage.getByRole("form", { name: "Sign in" });
    await signIn.getByLabel("Email").fill(OWNER.email);
    await signIn.getByLabel("Password").fill(OWNER.password);
    await signIn.getByRole("button", { name: "Sign in" }).click();
    await expect(ownerPage.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    const change = ownerPage.getByRole("form", { name: "Choose a new password" });
    await change.getByLabel("Current password").fill(OWNER.password);
    await change
      .getByRole("textbox", { name: "New password", exact: true })
      .fill(OWNER_NEW_PASSWORD);
    await change.getByLabel("Confirm new password").fill(OWNER_NEW_PASSWORD);
    await change.getByRole("button", { name: "Save password" }).click();
    await expect(ownerPage.getByRole("heading", { name: "Set up your apps" })).toBeVisible();
    await ownerPage.getByRole("button", { name: "Do this later", exact: true }).click();
    await expect(ownerPage.getByRole("heading", { name: "Connect a daemon" })).toBeVisible();
    await ownerPage.getByRole("button", { name: "Do this later", exact: true }).click();
    await expect(ownerPage.getByRole("heading", { name: "Triggers", exact: true })).toBeVisible();
    const slug = /\/o\/([^/]+)/u.exec(ownerPage.url())?.[1];
    if (slug === undefined) throw new Error(`no organization slug in ${ownerPage.url()}`);
    await owner.storageState({ path: `${stateDir}/owner.json` });

    for (const role of ["admin", "member"] as const) {
      const link = await invite(ownerPage, owner, slug, `${role}@ac7vf.test`, role);
      await join(browser, link, role, `${stateDir}/${role}.json`);
    }
    console.log(JSON.stringify({ slug }));
  } finally {
    await browser.close();
  }
}

async function invite(
  page: Page,
  context: Awaited<ReturnType<Browser["newContext"]>>,
  slug: string,
  email: string,
  role: "admin" | "member",
) {
  await page.goto(`${origin}/o/${slug}/settings/team`);
  await page.getByRole("button", { name: "Invite member" }).click();
  const form = page.getByRole("form", { name: "Invite team member" });
  await form.getByLabel("Invitee email").fill(email);
  const select = form.getByRole("combobox", { name: "Role" });
  await select.click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: role[0]!.toUpperCase() + role.slice(1), exact: true })
    .click();
  await form.getByRole("button", { name: "Create invitation" }).click();
  await expect(form).toBeHidden();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page
    .getByRole("table", { name: "Pending invitations" })
    .getByRole("row")
    .filter({ hasText: email })
    .getByRole("button", { name: `Actions for ${email}` })
    .click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  await expect(page.getByRole("status")).toHaveText("Invitation link copied.");
  return page.evaluate(() => navigator.clipboard.readText());
}

async function join(browser: Browser, link: string, role: string, statePath: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  const form = page.getByRole("form", { name: "Create account" });
  await form.getByLabel("Name").fill(role === "admin" ? "Ada Admin" : "Max Member");
  await form.getByLabel("Password").fill(`ac7vf-${role}-password`);
  await form.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByRole("button", { name: "Accept invitation" })).toBeHidden({
    timeout: 15000,
  });
  await page.waitForLoadState("networkidle");
  await context.storageState({ path: statePath });
  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
