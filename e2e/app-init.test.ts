import { test, expect } from "@playwright/test";
import { waitForAppReady } from "./helpers";

test.describe("App initialization", () => {
  test("shows loading screen then main UI", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Loading...")).toBeHidden({ timeout: 15_000 });
  });

  test("renders top bar with view mode toggle", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('button[title="Editor"]')).toBeVisible();
    await expect(page.locator('button[title="Canvas"]')).toBeVisible();
  });

  test("renders toolbar hint text", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator("text=Cmd+K search")).toBeVisible();
  });

  test("renders status bar", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator("text=docs")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Local")).toBeVisible();
  });

  test("renders sidebar with My Documents", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator("text=My Documents")).toBeVisible();
  });

  test("shows empty state when no document selected", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator("text=No document selected")).toBeVisible();
  });

  test("share button is visible", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('button[title="Share"]')).toBeVisible();
  });

  test("AI panel button is visible", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('button[title="Claude AI"]')).toBeVisible();
  });

  test("version history button is visible", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('button[title="Version history"]')).toBeVisible();
  });

  test("search input is visible in sidebar", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator('input[placeholder*="Search"]')).toBeVisible();
  });
});
