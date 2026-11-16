// Isolated browser verification. All external services are mocked; never uses production credentials.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const artifacts =
  process.env.BROWSER_ARTIFACT_DIR || join(tmpdir(), "member-network-browser");
import { fixture, member, community } from "../test/helpers.js";
const f = await fixture();
let browser;
try {
  await member(f);
  await community(f);
  await f.app.listen({ port: 3000, host: "127.0.0.1" });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium")
        ? "/usr/bin/chromium"
        : chromium.executablePath()),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400)
      console.log("HTTP", r.status(), new URL(r.url()).pathname);
  });
  await page.goto("http://localhost:3000");
  await page.getByRole("heading", { name: "Test Community" }).waitFor();
  await page.getByRole("combobox", { name: "Bahasa" }).selectOption("en");
  await page.getByRole("button", { name: "Cari", exact: true }).click();
  await page
    .getByText("Ruang baru sedang disiapkan", { exact: true })
    .waitFor();
  await page.getByRole("combobox", { name: "Bahasa" }).selectOption("id");
  await page.getByRole("button", { name: "Cari", exact: true }).click();
  await page.getByRole("heading", { name: "Test Community" }).waitFor();
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({
    path: join(artifacts, "catalog.png"),
    fullPage: true,
  });
  await page.goto("http://localhost:3000/admin");
  await page.getByLabel("Email admin").fill("admin@example.test");
  await page.getByLabel("Kata sandi").fill("correct");
  await page.getByRole("button", { name: "Masuk ke panel" }).click();
  await page.getByRole("heading", { name: "Ringkasan jaringan" }).waitFor();
  await page.getByRole("button", { name: "Komunitas", exact: false }).click();
  await page.getByRole("button", { name: "+ Tambahkan" }).click();
  await page.getByLabel("Discord Server ID").fill("456789012345678901");
  await page.getByLabel("Nama komunitas").fill("Komunitas Kreatif");
  await page
    .getByLabel("Deskripsi", { exact: true })
    .fill("Ruang untuk berkreasi dan belajar bersama.");
  await page
    .getByLabel("Minat, pisahkan dengan koma", { exact: true })
    .fill("seni, desain");
  await page
    .getByRole("button", { name: "Daftarkan komunitas", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: "Komunitas Kreatif" });
  await row.waitFor();
  await row.getByRole("button", { name: "Setujui", exact: true }).click();
  await row.getByText("approved", { exact: true }).waitFor();
  // Complete OAuth using server injection to capture the cookie and exercise actual callback logic.
  const start = await f.app.inject("/auth/discord/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const oauthCookie = start.headers["set-cookie"].split(";")[0];
  const callback = await f.app.inject({
    url: `/auth/discord/callback?state=${state}&code=test-code`,
    headers: { cookie: oauthCookie },
  });
  const cookies = Array.isArray(callback.headers["set-cookie"])
    ? callback.headers["set-cookie"]
    : [callback.headers["set-cookie"]];
  const memberCookie = cookies.find((x) => x.startsWith("mn_member="));
  assert(memberCookie);
  await page.context().addCookies([
    {
      name: "mn_member",
      value: memberCookie.split(";")[0].slice("mn_member=".length),
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("http://localhost:3000");
  await page.getByRole("heading", { name: "Halo, Test Member" }).waitFor();
  await page
    .locator("#catalog article")
    .filter({ hasText: "Test Community" })
    .getByRole("button", { name: "Setujui auto-join" })
    .click();
  await page.locator("#consent-dialog input[type=checkbox]").check();
  await page.getByRole("button", { name: "Setujui selama 30 hari" }).click();
  await page
    .locator("#catalog")
    .getByRole("button", { name: "Cabut persetujuan" })
    .waitFor();
  await page.goto("http://localhost:3000/admin");
  await page.getByRole("button", { name: "Campaign", exact: false }).click();
  await page.getByRole("button", { name: "+ Tambahkan" }).click();
  await page.getByLabel("Nama campaign").fill("Campaign Perdana");
  await page
    .getByLabel("Komunitas tujuan")
    .selectOption({ label: "Test Community" });
  await page.getByLabel("Mulai", { exact: true }).fill("2026-01-01T10:00");
  await page.getByLabel("Selesai", { exact: true }).fill("2099-12-31T10:00");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  const campaignRow = page
    .getByRole("row")
    .filter({ hasText: "Campaign Perdana" });
  await campaignRow.waitFor();
  page.once("dialog", (d) => d.accept());
  await campaignRow.getByRole("button", { name: "Mulai", exact: true }).click();
  await campaignRow.getByText("running", { exact: true }).waitFor();
  await f.work.runOne();
  assert.equal(f.calls.joins.length, 1);
  await page.getByRole("button", { name: "Ringkasan", exact: false }).click();
  await page
    .locator("#metrics strong")
    .last()
    .getByText("1", { exact: true })
    .waitFor();
  await page.screenshot({ path: join(artifacts, "admin.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: join(artifacts, "admin-mobile.png"),
    fullPage: true,
  });
  await page.goto("http://localhost:3000");
  await page.getByRole("heading", { name: "Halo, Test Member" }).waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page
    .locator("#catalog")
    .getByRole("button", { name: "Cabut persetujuan" })
    .click();
  await page
    .locator("#catalog article")
    .filter({ hasText: "Test Community" })
    .getByRole("button", { name: "Setujui auto-join" })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Browser flow passed: admin login, community create/approve, member OAuth/consent, campaign start, worker result, revoke, desktop/mobile layouts.",
  );
} catch (e) {
  if (browser) {
    const pages = browser.contexts()[0]?.pages();
    if (pages?.[0]) {
      console.log(
        "Browser status:",
        await pages[0].locator("#status").textContent(),
      );
      await pages[0].screenshot({
        path: join(artifacts, "failure.png"),
        fullPage: true,
      });
    }
  }
  throw e;
} finally {
  await browser?.close();
  await f.close();
}
