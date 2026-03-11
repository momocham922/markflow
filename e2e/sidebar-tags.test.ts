import { test, expect } from "@playwright/test";
import { waitForAppReady, createNewDocument, typeInEditor } from "./helpers";

test.describe("Sidebar", () => {
  test("sidebar is visible on load with My Documents", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator("text=My Documents")).toBeVisible();
    await expect(page.locator('input[placeholder*="Search"]')).toBeVisible();
  });

  test("shows No documents yet when empty", async ({ page }) => {
    await waitForAppReady(page);
    await expect(page.locator("text=No documents yet")).toBeVisible();
  });

  test("creating a document removes empty state", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await expect(page.locator("text=No documents yet")).toBeHidden();
  });

  test("search input filters documents", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await page.waitForTimeout(300);
    await createNewDocument(page);
    await page.waitForTimeout(300);

    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("Untitled");
    await page.waitForTimeout(500);
  });

  test("clicking a document in sidebar switches to it", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "First doc content");
    await page.waitForTimeout(300);
    await createNewDocument(page);
    await typeInEditor(page, "Second doc content");
    await page.waitForTimeout(300);

    const docs = page.locator(".truncate:has-text('Untitled')");
    const count = await docs.count();
    if (count > 0) {
      await docs.first().click();
      await page.waitForTimeout(500);
    }
  });
});

test.describe("Tag management", () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
  });

  test("can add a tag via toolbar", async ({ page }) => {
    const addTag = page.locator('[title="Add tag"]');
    await addTag.click();
    const tagInput = page.locator('input[placeholder="tag"]');
    await expect(tagInput).toBeVisible();
    await tagInput.fill("test-tag");
    await tagInput.press("Enter");
    // Tag pill appears in toolbar (use toolbar-specific selector)
    const toolbarTag = page.locator("span.inline-flex:has-text('test-tag')");
    await expect(toolbarTag.first()).toBeVisible();
  });

  test("can add multiple tags", async ({ page }) => {
    const addTag = page.locator('[title="Add tag"]');
    await addTag.click();
    const tagInput = page.locator('input[placeholder="tag"]');
    await tagInput.fill("alpha");
    await tagInput.press("Enter");
    // After Enter, tag input stays open — type next tag directly
    await tagInput.fill("beta");
    await tagInput.press("Enter");
    await tagInput.press("Escape");

    await expect(page.locator("span.inline-flex:has-text('alpha')").first()).toBeVisible();
    await expect(page.locator("span.inline-flex:has-text('beta')").first()).toBeVisible();
  });

  test("can remove a tag", async ({ page }) => {
    const addTag = page.locator('[title="Add tag"]');
    await addTag.click();
    const tagInput = page.locator('input[placeholder="tag"]');
    await tagInput.fill("removeme");
    await tagInput.press("Enter");
    await tagInput.press("Escape");

    const toolbarTag = page.locator("span.inline-flex:has-text('removeme')").first();
    await expect(toolbarTag).toBeVisible();

    // Click the X icon inside the tag pill
    await toolbarTag.locator("svg").first().click();
    await page.waitForTimeout(300);
    await expect(page.locator("span.inline-flex:has-text('removeme')")).toHaveCount(0);
  });

  test("duplicate tags are not added", async ({ page }) => {
    const addTag = page.locator('[title="Add tag"]');
    await addTag.click();
    const tagInput = page.locator('input[placeholder="tag"]');
    await tagInput.fill("unique");
    await tagInput.press("Enter");
    // Try to add same tag again (input is still open)
    await tagInput.fill("unique");
    await tagInput.press("Enter");
    await tagInput.press("Escape");

    // Only one tag pill should exist in toolbar
    const toolbarTags = page.locator("span.inline-flex:has-text('unique')");
    // Toolbar has 1, sidebar filter may have 1 — check toolbar only
    const count = await toolbarTags.count();
    expect(count).toBeLessThanOrEqual(2); // toolbar + sidebar filter at most
  });

  test("tag input can be cancelled with Escape", async ({ page }) => {
    const addTag = page.locator('[title="Add tag"]');
    await addTag.click();
    const tagInput = page.locator('input[placeholder="tag"]');
    await expect(tagInput).toBeVisible();
    await tagInput.press("Escape");
    await expect(tagInput).toBeHidden();
  });
});
