import { type Page, expect } from "@playwright/test";

/** Wait for the app to finish initializing (Loading... disappears) */
export async function waitForAppReady(page: Page) {
  await page.goto("/");
  await expect(page.locator("text=Loading...")).toBeHidden({ timeout: 15_000 });
}

/** Create a new document via the "+" icon next to "My Documents" */
export async function createNewDocument(page: Page) {
  const myDocsRow = page.locator('button:has-text("My Documents")').locator('..');
  await myDocsRow.locator('.lucide-plus').click();
  await expect(page.locator(".cm-editor")).toBeVisible({ timeout: 5_000 });
}

/**
 * Type into the CodeMirror editor. Handles newlines by pressing Enter.
 * Clears existing content first with Cmd+A then types.
 */
export async function typeInEditor(page: Page, text: string, clear = false) {
  const editor = page.locator(".cm-editor .cm-content");
  await editor.click();
  if (clear) {
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
  }
  // Split by newline and type with Enter presses
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length > 0) {
      await editor.pressSequentially(parts[i], { delay: 15 });
    }
    if (i < parts.length - 1) {
      await page.keyboard.press("Enter");
    }
  }
}

/** Get the CodeMirror editor content */
export async function getEditorContent(page: Page): Promise<string> {
  return page.locator(".cm-editor .cm-content").innerText();
}

/** Switch preview mode */
export async function setPreviewMode(page: Page, mode: "edit" | "split" | "preview" | "mindmap") {
  const titles: Record<string, string> = {
    edit: "Edit only",
    split: "Split view",
    preview: "Preview only",
    mindmap: "Mind Map",
  };
  await page.locator(`button[title="${titles[mode]}"]`).click();
  await page.waitForTimeout(300);
}
