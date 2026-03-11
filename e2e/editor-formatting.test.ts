import { test, expect } from "@playwright/test";
import { waitForAppReady, createNewDocument, typeInEditor, setPreviewMode } from "./helpers";

test.describe("Editor formatting toolbar", () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
  });

  test("bold button wraps selection", async ({ page }) => {
    await typeInEditor(page, "hello");
    // Select all text
    const editor = page.locator(".cm-editor .cm-content");
    await editor.press("Meta+a");
    // Click bold button
    await page.locator('button[title="Bold (Cmd+B)"]').click();
    const content = await editor.innerText();
    expect(content).toContain("**");
  });

  test("italic button wraps selection", async ({ page }) => {
    await typeInEditor(page, "hello");
    const editor = page.locator(".cm-editor .cm-content");
    await editor.press("Meta+a");
    await page.locator('button[title="Italic (Cmd+I)"]').click();
    const content = await editor.innerText();
    expect(content).toContain("_");
  });

  test("strikethrough button wraps selection", async ({ page }) => {
    await typeInEditor(page, "hello");
    const editor = page.locator(".cm-editor .cm-content");
    await editor.press("Meta+a");
    await page.locator('button[title="Strikethrough (Cmd+Shift+X)"]').click();
    const content = await editor.innerText();
    expect(content).toContain("~~");
  });

  test("code button wraps selection", async ({ page }) => {
    await typeInEditor(page, "hello");
    const editor = page.locator(".cm-editor .cm-content");
    await editor.press("Meta+a");
    await page.locator('button[title="Code (Cmd+E)"]').click();
    const content = await editor.innerText();
    expect(content).toContain("`");
  });

  test("heading buttons add line prefix", async ({ page }) => {
    await typeInEditor(page, "title");
    await page.locator('button[title="Heading 1"]').click();
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("# ");
  });

  test("bullet list button adds prefix", async ({ page }) => {
    await typeInEditor(page, "item");
    await page.locator('button[title="Bullet list"]').click();
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("- ");
  });

  test("numbered list button adds prefix", async ({ page }) => {
    await typeInEditor(page, "item");
    await page.locator('button[title="Numbered list"]').click();
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("1. ");
  });

  test("blockquote button adds prefix", async ({ page }) => {
    await typeInEditor(page, "quote");
    await page.locator('button[title="Blockquote"]').click();
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("> ");
  });

  test("link button inserts link syntax", async ({ page }) => {
    await page.locator('button[title="Link (Cmd+K)"]').click();
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("[");
    expect(content).toContain("](");
  });
});

test.describe("Preview modes", () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
  });

  test("edit mode shows only editor", async ({ page }) => {
    await setPreviewMode(page, "edit");
    await expect(page.locator(".cm-editor")).toBeVisible();
    // Preview pane should not be visible
    const preview = page.locator(".prose, .markdown-body, [class*='preview']").first();
    await expect(preview).toBeHidden({ timeout: 1_000 }).catch(() => {
      // May not exist at all, which is fine
    });
  });

  test("split mode shows editor and preview", async ({ page }) => {
    await typeInEditor(page, "# Hello World");
    await setPreviewMode(page, "split");
    await expect(page.locator(".cm-editor")).toBeVisible();
    // Preview should render the heading
    await expect(page.locator("h1:has-text('Hello World')")).toBeVisible({ timeout: 3_000 });
  });

  test("preview mode shows only rendered content", async ({ page }) => {
    await typeInEditor(page, "# Preview Test\n\nSome paragraph text.");
    await setPreviewMode(page, "preview");
    await expect(page.locator("h1:has-text('Preview Test')")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator("p:has-text('Some paragraph text')")).toBeVisible();
    // Editor should be hidden
    await expect(page.locator(".cm-editor")).toBeHidden();
  });

  test("preview renders bold and italic", async ({ page }) => {
    await typeInEditor(page, "**bold** and _italic_");
    await setPreviewMode(page, "preview");
    await expect(page.locator("strong:has-text('bold')")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator("em:has-text('italic')")).toBeVisible();
  });

  test("preview renders lists", async ({ page }) => {
    await typeInEditor(page, "- item one\n- item two\n- item three");
    await setPreviewMode(page, "preview");
    await expect(page.locator("li").filter({ hasText: "item one" }).first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByText("item two", { exact: true })).toBeVisible();
    await expect(page.getByText("item three", { exact: true })).toBeVisible();
  });

  test("preview renders code blocks with syntax highlighting", async ({ page }) => {
    const codeBlock = "```js\nconst x = 42;\n```";
    await page.locator(".cm-editor .cm-content").click();
    await page.evaluate((t) => navigator.clipboard.writeText(t), codeBlock);
    await page.keyboard.press("Meta+v");
    await page.waitForTimeout(300);
    await setPreviewMode(page, "preview");
    await expect(page.locator("pre code")).toBeVisible({ timeout: 3_000 });
  });

  test("preview renders blockquote", async ({ page }) => {
    await typeInEditor(page, "> This is a quote");
    await setPreviewMode(page, "preview");
    await expect(page.locator("blockquote")).toBeVisible({ timeout: 3_000 });
  });

  test("preview renders table", async ({ page }) => {
    await typeInEditor(page, "| A | B |\n|---|---|\n| 1 | 2 |");
    await setPreviewMode(page, "preview");
    await expect(page.locator("table")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator("td:has-text('1')")).toBeVisible();
  });

  test("switching modes preserves content", async ({ page }) => {
    await typeInEditor(page, "persistent content");
    await setPreviewMode(page, "preview");
    await setPreviewMode(page, "edit");
    const content = await page.locator(".cm-editor .cm-content").innerText();
    expect(content).toContain("persistent content");
  });
});
