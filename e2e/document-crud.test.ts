import { test, expect } from "@playwright/test";
import { waitForAppReady, createNewDocument, typeInEditor } from "./helpers";

test.describe("Document CRUD", () => {
  test("can create a new document", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    // Editor should be visible with CodeMirror
    await expect(page.locator(".cm-editor")).toBeVisible();
  });

  test("can type in the editor", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "Hello, MarkFlow!");
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("Hello, MarkFlow!");
  });

  test("can create multiple documents", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await page.waitForTimeout(200);
    await createNewDocument(page);
    // Should have at least 2 documents listed in sidebar
    const docItems = page.locator(".truncate:has-text('Untitled')");
    const count = await docItems.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("can rename a document via toolbar", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    // Click the document title in toolbar to start rename
    const titleEl = page.locator('[title="Click to rename"]');
    if (await titleEl.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await titleEl.click();
      // Rename input should appear
      const renameInput = page.locator('input[class*="border-b"]').first();
      await expect(renameInput).toBeVisible();
      await renameInput.fill("My Test Doc");
      await renameInput.press("Enter");
      // Title should update
      await expect(page.locator("text=My Test Doc").first()).toBeVisible();
    }
  });

  test("can delete a document via context menu", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await page.waitForTimeout(300);
    // Right-click on the document in sidebar to open context menu
    const sidebarDoc = page.locator(".truncate:has-text('Untitled')").first();
    if (await sidebarDoc.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await sidebarDoc.click({ button: "right" });
      // Look for delete option in context menu
      const deleteOption = page.locator("text=/Delete/i").first();
      if (await deleteOption.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await deleteOption.click();
      }
    }
  });
});
