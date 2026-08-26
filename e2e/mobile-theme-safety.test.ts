import { test, expect } from "@playwright/test";

// Regression guard for the beta.45 "mobile theme change → full black screen,
// can't operate" report. A throw during a theme-triggered render unmounts the
// tree; html{background:var(--background)} then paints near-black in dark mode,
// leaving an unrecoverable black screen. This exercises every mobile
// theme-change surface (light/dark toggle in editor + preview + mind map, and
// cycling every mind-map theme) and asserts no pageerror/console error fires
// and the body never goes empty.
//
// Mobile emulation so module-level isMobile === true at import time.
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});

test("mobile theme change must not throw / black-screen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) =>
    errors.push(`PAGEERROR: ${e.stack || e.message}`),
  );
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`CONSOLE: ${m.text()}`);
  });

  await page.goto("/");
  await expect(page.locator("text=Loading...")).toBeHidden({ timeout: 15_000 });

  const click = async (sel: string, timeout = 1500) => {
    const l = page.locator(sel).first();
    if (await l.isVisible({ timeout }).catch(() => false)) {
      await l.click({ timeout: 1500 }).catch(() => {});
      return true;
    }
    return false;
  };
  const isDark = () =>
    page.locator("html").evaluate((el) => el.classList.contains("dark"));
  const toggleTheme = async () => {
    const before = await isDark();
    await click("button:has(.lucide-moon), button:has(.lucide-sun)");
    await page.waitForTimeout(250);
    return before;
  };

  await click('button:has-text("OK")'); // privacy banner
  await click("button:has(.lucide-panel-left)"); // open sidebar
  await page.waitForTimeout(300);
  await click('button:has-text("My Documents")');
  const plus = page
    .locator('button:has-text("My Documents")')
    .locator("..")
    .locator(".lucide-plus")
    .first();
  if (await plus.isVisible({ timeout: 1500 }).catch(() => false))
    await plus.click().catch(() => {});
  await expect(page.locator(".cm-editor")).toBeVisible({ timeout: 5000 });

  // Content that stresses the preview renderer.
  const editor = page.locator(".cm-editor .cm-content");
  await editor.click();
  await page.keyboard.type("# Title\n\n**bold**\n\n## Section\n\n### Sub\n");

  // PROOF the toggle fires: flip must change html.dark.
  const wasDark = await toggleTheme();
  expect(await isDark(), "theme toggle did not flip html.dark").toBe(!wasDark);
  await toggleTheme();
  await toggleTheme();

  // Preview mode + theme toggles.
  expect(await click('button[title="Preview only"]')).toBe(true);
  await expect(page.locator(".prose")).toBeVisible({ timeout: 3000 });
  await toggleTheme();
  await toggleTheme();

  // Mind map mode + theme toggles + cycle every mindmap theme.
  expect(await click('button[title="Mind Map"]')).toBe(true);
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 3000 });
  await toggleTheme();
  await toggleTheme();
  if (await click('button:has-text("Theme")')) {
    for (const name of ["Ocean", "Forest", "Sunset", "Mono", "Lavender"]) {
      await click(`button:has-text("${name}")`, 800);
      await page.waitForTimeout(150);
      await click('button:has-text("Theme")');
    }
  }

  const bodyText = await page.locator("body").innerText();
  expect(bodyText.length, "body empty (blank/black screen)").toBeGreaterThan(0);
  expect(errors, `Captured errors:\n${errors.join("\n")}`).toEqual([]);
});
