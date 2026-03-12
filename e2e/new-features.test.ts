import { test, expect } from "@playwright/test";
import { waitForAppReady, createNewDocument, typeInEditor, setPreviewMode } from "./helpers";

test.describe("Version History dialog", () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
  });

  test("History button is visible in editor toolbar", async ({ page }) => {
    const historyBtn = page.locator('button:has-text("History")');
    await expect(historyBtn).toBeVisible();
  });

  test("History button opens version history dialog", async ({ page }) => {
    await page.locator('button:has-text("History")').click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await expect(dialog.locator("text=Version History")).toBeVisible();
  });

  test("Version history shows empty state for new document", async ({ page }) => {
    await page.locator('button:has-text("History")').click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await expect(dialog.locator("text=No versions yet")).toBeVisible();
  });

  test("Version history dialog can be closed", async ({ page }) => {
    await page.locator('button:has-text("History")').click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 2_000 });
  });
});

test.describe("Mind Map view", () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
  });

  test("Mind Map button is visible in toolbar", async ({ page }) => {
    await expect(page.locator('button[title="Mind Map"]')).toBeVisible();
  });

  test("Mind Map mode hides editor and shows ReactFlow", async ({ page }) => {
    await typeInEditor(page, "# Root\n## Branch A\n## Branch B\n### Leaf");
    await setPreviewMode(page, "mindmap");
    // Editor should be hidden
    await expect(page.locator(".cm-editor")).toBeHidden();
    // ReactFlow canvas should be visible
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 3_000 });
  });

  test("Mind Map renders nodes from headings", async ({ page }) => {
    await typeInEditor(page, "# First Heading\n## Sub Heading\n### Deep Heading");
    await setPreviewMode(page, "mindmap");
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 3_000 });
    // Should have nodes rendered inside the ReactFlow canvas
    const flow = page.locator(".react-flow");
    await expect(flow.locator("text=First Heading")).toBeVisible({ timeout: 3_000 });
    await expect(flow.locator("text=Sub Heading")).toBeVisible();
    await expect(flow.locator("text=Deep Heading")).toBeVisible();
  });

  test("Mind Map shows root node for document with no headings", async ({ page }) => {
    await typeInEditor(page, "Just some plain text without headings");
    await setPreviewMode(page, "mindmap");
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 3_000 });
  });

  test("switching from Mind Map back to edit preserves content", async ({ page }) => {
    await typeInEditor(page, "# Test Heading\nSome content");
    await setPreviewMode(page, "mindmap");
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 3_000 });
    await setPreviewMode(page, "edit");
    await expect(page.locator(".cm-editor")).toBeVisible();
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("Test Heading");
  });

  test("Mind Map hides formatting toolbar", async ({ page }) => {
    await setPreviewMode(page, "mindmap");
    // Formatting buttons should not be visible
    await expect(page.locator('button[title="Bold (Cmd+B)"]')).toBeHidden();
  });
});

test.describe("Preview mode toggle completeness", () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "# Hello\n\nContent here");
  });

  test("all four view mode buttons are visible", async ({ page }) => {
    await expect(page.locator('button[title="Edit only"]')).toBeVisible();
    await expect(page.locator('button[title="Split view"]')).toBeVisible();
    await expect(page.locator('button[title="Preview only"]')).toBeVisible();
    await expect(page.locator('button[title="Mind Map"]')).toBeVisible();
  });

  test("cycling through all modes works", async ({ page }) => {
    // edit → split → preview → mindmap → edit
    await setPreviewMode(page, "edit");
    await expect(page.locator(".cm-editor")).toBeVisible();

    await setPreviewMode(page, "split");
    await expect(page.locator(".cm-editor")).toBeVisible();
    await expect(page.locator("h1:has-text('Hello')")).toBeVisible({ timeout: 3_000 });

    await setPreviewMode(page, "preview");
    await expect(page.locator(".cm-editor")).toBeHidden();
    await expect(page.locator("h1:has-text('Hello')")).toBeVisible();

    await setPreviewMode(page, "mindmap");
    await expect(page.locator(".cm-editor")).toBeHidden();
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 3_000 });

    await setPreviewMode(page, "edit");
    await expect(page.locator(".cm-editor")).toBeVisible();
  });
});
