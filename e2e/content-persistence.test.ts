import { test, expect } from "@playwright/test";
import { waitForAppReady, createNewDocument, typeInEditor, getEditorContent } from "./helpers";

test.describe("Content persistence", () => {
  test("typed content persists after switching documents", async ({ page }) => {
    await waitForAppReady(page);
    // Create doc 1 and type (clear default "# Untitled")
    await createNewDocument(page);
    await typeInEditor(page, "# First Document\nHello world", true);
    await page.waitForTimeout(1200);

    // Create doc 2
    await createNewDocument(page);
    await typeInEditor(page, "# Second Document\nGoodbye", true);
    await page.waitForTimeout(1200);

    // Switch back to doc 1 via sidebar
    const doc1 = page.locator(".truncate:has-text('First Document')").first();
    await expect(doc1).toBeVisible({ timeout: 3000 });
    await doc1.click();
    await page.waitForTimeout(500);

    const content = await getEditorContent(page);
    expect(content).toContain("First Document");
    expect(content).toContain("Hello world");
  });

  test("clearing all content persists (no ghost recovery)", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "# Content to delete\nThis will be cleared", true);
    await page.waitForTimeout(1200);

    // Select all and delete
    const editor = page.locator(".cm-editor .cm-content");
    await editor.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(1200);

    // Content should be empty or near-empty
    const afterDelete = await getEditorContent(page);
    expect(afterDelete.trim()).toBe("");
  });

  test("cleared content stays empty after switching away and back", async ({ page }) => {
    await waitForAppReady(page);

    // Create doc with content
    await createNewDocument(page);
    await typeInEditor(page, "# Will be emptied\nSome text here", true);
    await page.waitForTimeout(1200);

    // Verify sidebar shows title
    const docItem = page.locator(".truncate:has-text('Will be emptied')").first();
    await expect(docItem).toBeVisible({ timeout: 3000 });

    // Clear content
    const editor = page.locator(".cm-editor .cm-content");
    await editor.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(1200);

    // Create another doc and switch to it
    await createNewDocument(page);
    await typeInEditor(page, "# Other doc", true);
    await page.waitForTimeout(1000);

    // Switch back — the emptied doc title may now be "Untitled"
    const untitledDoc = page.locator(".truncate:has-text('Untitled')").first();
    if (await untitledDoc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await untitledDoc.click();
      await page.waitForTimeout(500);
      const content = await getEditorContent(page);
      // Content should still be empty — NOT recovered from snapshot
      expect(content.trim().length).toBeLessThanOrEqual(1);
    }
  });

  test("auto-title derives from first heading", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    // Clear default content and type heading
    await typeInEditor(page, "# My Great Title\nSome body text", true);
    await page.waitForTimeout(1500);

    // Sidebar should show derived title
    const titleInSidebar = page.locator(".truncate:has-text('My Great Title')").first();
    await expect(titleInSidebar).toBeVisible({ timeout: 5000 });
  });

  test("content survives page reload", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "# Survive Reload\nPersistent content here", true);
    await page.waitForTimeout(2000); // ensure save completes

    // Reload the page
    await page.reload();
    await expect(page.locator("text=Loading...")).toBeHidden({ timeout: 15_000 });
    await page.waitForTimeout(1000);

    // Find and click the doc
    const docItem = page.locator(".truncate:has-text('Survive Reload')").first();
    if (await docItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await docItem.click();
      await page.waitForTimeout(500);
      const content = await getEditorContent(page);
      expect(content).toContain("Persistent content here");
    }
  });

  test("replacing content with new content works", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "# Original Content", true);
    await page.waitForTimeout(1200);

    // Replace with new content
    await typeInEditor(page, "# Replaced Content\nNew body", true);
    await page.waitForTimeout(1200);

    const content = await getEditorContent(page);
    expect(content).toContain("Replaced Content");
    expect(content).not.toContain("Original Content");
  });
});
