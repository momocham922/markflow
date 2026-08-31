import { test, expect } from "@playwright/test";
import {
  waitForAppReady,
  createNewDocument,
  typeInEditor,
  getEditorContent,
} from "./helpers";

/**
 * Real-user operations that exercise editor behaviour beyond the formatting
 * toolbar: word/char counting (incl. CJK), undo/redo, list auto-continuation,
 * unicode/emoji round-trips, search filtering, and rapid clear/retype content
 * protection.
 */

test.describe("Word & character count (StatusBar)", () => {
  test("counts latin words by whitespace", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "hello world foo", true);
    // StatusBar polls store content; give the store a tick to update.
    await expect(
      page.locator("text=/\\d+ words \\/ \\d+ chars/"),
    ).toContainText("3 words", { timeout: 5_000 });
  });

  test("counts CJK text per character", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    // 8 CJK characters, no whitespace -> 8 "words".
    await typeInEditor(page, "これはテストです", true);
    await expect(
      page.locator("text=/\\d+ words \\/ \\d+ chars/"),
    ).toContainText("8 words", { timeout: 5_000 });
  });

  test("counts mixed CJK + latin correctly", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    // "hello world" = 2 latin words, "日本語" = 3 CJK chars -> 5 total.
    await typeInEditor(page, "hello world 日本語", true);
    await expect(
      page.locator("text=/\\d+ words \\/ \\d+ chars/"),
    ).toContainText("5 words", { timeout: 5_000 });
  });

  test("empty document reports zero words", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "temp", true);
    await typeInEditor(page, "", true); // clear
    await expect(
      page.locator("text=/\\d+ words \\/ \\d+ chars/"),
    ).toContainText("0 words", { timeout: 5_000 });
  });
});

test.describe("Undo / Redo", () => {
  test("Cmd+Z undoes typing and Cmd+Shift+Z redoes it", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "UndoRedoSample", true);
    expect(await getEditorContent(page)).toContain("UndoRedoSample");

    const editor = page.locator(".cm-editor .cm-content");
    await editor.click();
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(200);
    expect(await getEditorContent(page)).not.toContain("UndoRedoSample");

    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(200);
    expect(await getEditorContent(page)).toContain("UndoRedoSample");
  });
});

test.describe("Markdown list auto-continuation", () => {
  test("Enter after a bullet item continues the list", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    const editor = page.locator(".cm-editor .cm-content");
    await editor.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await editor.pressSequentially("- first", { delay: 15 });
    await page.keyboard.press("Enter");
    await editor.pressSequentially("second", { delay: 15 });
    await page.waitForTimeout(200);
    const content = await getEditorContent(page);
    expect(content).toContain("- first");
    // The editor should have auto-inserted a "- " marker for the second line.
    expect(content).toContain("- second");
  });

  test("Enter after a numbered item continues with the next number", async ({
    page,
  }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    const editor = page.locator(".cm-editor .cm-content");
    await editor.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await editor.pressSequentially("1. first", { delay: 15 });
    await page.keyboard.press("Enter");
    await editor.pressSequentially("second", { delay: 15 });
    await page.waitForTimeout(200);
    const content = await getEditorContent(page);
    expect(content).toContain("1. first");
    // The ordered-list marker should auto-increment to "2. ".
    expect(content).toContain("2. second");
  });
});

test.describe("Unicode & emoji round-trip", () => {
  test("emoji and CJK survive switching documents and back", async ({
    page,
  }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    const sample = "# 見出し\n\nHello 👍 世界 🎉 café naïve";
    await typeInEditor(page, sample, true);
    await page.waitForTimeout(300);

    // Create a second doc, then return to the first via the sidebar.
    await createNewDocument(page);
    await page.waitForTimeout(300);
    const firstDoc = page.locator(".truncate:has-text('見出し')").first();
    await firstDoc.click();
    await page.waitForTimeout(300);

    const content = await getEditorContent(page);
    expect(content).toContain("👍");
    expect(content).toContain("世界");
    expect(content).toContain("🎉");
    expect(content).toContain("café naïve");
  });
});

test.describe("Sidebar search filtering", () => {
  test("no-match query shows No results, clearing restores docs", async ({
    page,
  }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "# SearchableAlpha", true);
    await page.waitForTimeout(400); // let auto-title derive

    const search = page.locator(
      'input[placeholder="Search title & content..."]',
    );
    await search.fill("zzz-no-such-doc-qqq");
    await expect(page.locator("text=No results")).toBeVisible({
      timeout: 5_000,
    });

    await search.fill("");
    await expect(page.locator("text=No results")).toBeHidden({
      timeout: 5_000,
    });
    await expect(
      page.locator(".truncate:has-text('SearchableAlpha')").first(),
    ).toBeVisible();
  });

  test("matching query keeps the document visible", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "# UniqueSearchTerm", true);
    await page.waitForTimeout(400);

    const search = page.locator(
      'input[placeholder="Search title & content..."]',
    );
    await search.fill("UniqueSearch");
    await expect(
      page.locator(".truncate:has-text('UniqueSearchTerm')").first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=No results")).toBeHidden();
  });
});

test.describe("Content protection under rapid edits", () => {
  test("rapid clear then retype persists the new content", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "original content here", true);
    await page.waitForTimeout(200);
    // Clear and immediately retype (stresses empty-content guards).
    await typeInEditor(page, "replacement content", true);
    await page.waitForTimeout(300);

    // Switch away and back — content must be the replacement, not empty or old.
    await createNewDocument(page);
    await page.waitForTimeout(300);
    const firstDoc = page
      .locator(".truncate:has-text('replacement content')")
      .first();
    if (await firstDoc.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await firstDoc.click();
      await page.waitForTimeout(300);
    }
    const content = await getEditorContent(page);
    expect(content).toContain("replacement content");
    expect(content).not.toContain("original content here");
  });
});
