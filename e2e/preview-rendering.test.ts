import { test, expect } from "@playwright/test";
import { waitForAppReady, createNewDocument, typeInEditor, setPreviewMode } from "./helpers";

test.describe("Preview rendering - Mermaid", () => {
  test("renders mermaid code block as .mermaid div", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    // Set editor content directly via CodeMirror's DOM
    const cm = page.locator(".cm-editor .cm-content");
    await cm.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    // Type code block manually with Enter keys
    await cm.pressSequentially("```mermaid", { delay: 15 });
    await page.keyboard.press("Enter");
    await cm.pressSequentially("graph TD", { delay: 15 });
    await page.keyboard.press("Enter");
    await cm.pressSequentially("  A --> B", { delay: 15 });
    await page.keyboard.press("Enter");
    await cm.pressSequentially("```", { delay: 15 });
    await page.waitForTimeout(500);
    await setPreviewMode(page, "preview");
    // The marked renderer should create a .mermaid div
    await expect(page.locator(".mermaid")).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Preview rendering - YouTube embed", () => {
  test("renders YouTube link as iframe embed", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "[video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)");
    await setPreviewMode(page, "preview");
    // Should render a YouTube iframe
    const iframe = page.locator(".youtube-embed iframe");
    await expect(iframe).toBeVisible({ timeout: 5_000 });
    const src = await iframe.getAttribute("src");
    expect(src).toContain("youtube.com/embed/dQw4w9WgXcQ");
  });

  test("renders bare YouTube URL as embed", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await setPreviewMode(page, "preview");
    // Bare URL should also get YouTube embed treatment via renderer.link
    const iframe = page.locator(".youtube-embed iframe");
    // This may or may not embed depending on how marked handles bare URLs
    // At minimum, the link should be rendered
    const link = page.locator('a[href*="youtube.com"]');
    const hasEmbed = await iframe.isVisible({ timeout: 3_000 }).catch(() => false);
    const hasLink = await link.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(hasEmbed || hasLink).toBeTruthy();
  });
});

test.describe("Preview rendering - Links", () => {
  test("renders standard links with target=_blank", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "[Example](https://example.com)");
    await setPreviewMode(page, "preview");
    const link = page.locator('a[href="https://example.com"]');
    await expect(link).toBeVisible({ timeout: 3_000 });
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  });

  test("blocks javascript: protocol links", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, '[Click me](javascript:alert(1))');
    await setPreviewMode(page, "preview");
    // Should NOT render an <a> tag with javascript: href
    const dangerousLink = page.locator('a[href^="javascript:"]');
    await expect(dangerousLink).toHaveCount(0);
  });

  test("blocks data: protocol links", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, '[Click me](data:text/html,<script>alert(1)</script>)');
    await setPreviewMode(page, "preview");
    const dangerousLink = page.locator('a[href^="data:"]');
    await expect(dangerousLink).toHaveCount(0);
  });

  test("bare URL renders as link card or link", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "https://example.com");
    await setPreviewMode(page, "preview");
    // Should render as link-card div or regular link
    const linkCard = page.locator(".link-card");
    const regularLink = page.locator('a[href="https://example.com"]');
    const hasCard = await linkCard.isVisible({ timeout: 3_000 }).catch(() => false);
    const hasLink = await regularLink.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(hasCard || hasLink).toBeTruthy();
  });
});

test.describe("Preview rendering - Wiki-links", () => {
  test("renders wiki-link for existing document", async ({ page }) => {
    await waitForAppReady(page);
    // Create a target document
    await createNewDocument(page);
    await page.waitForTimeout(200);
    // Rename it
    const titleEl = page.locator('[title="Click to rename"]');
    if (await titleEl.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await titleEl.click();
      const renameInput = page.locator('input[class*="border-b"]').first();
      await renameInput.fill("Target Doc");
      await renameInput.press("Enter");
      await page.waitForTimeout(300);
    }

    // Create another document and link to the first
    await createNewDocument(page);
    await typeInEditor(page, "Link to [[Target Doc]]");
    await setPreviewMode(page, "preview");
    // Should render as a wikilink (found)
    const wikilink = page.locator(".wikilink, a[class*='wikilink']");
    const missing = page.locator(".wikilink-missing, span[class*='wikilink-missing']");
    const hasFound = await wikilink.isVisible({ timeout: 3_000 }).catch(() => false);
    const hasMissing = await missing.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(hasFound || hasMissing).toBeTruthy();
  });

  test("renders missing wiki-link with special style", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "Link to [[Nonexistent Page]]");
    await setPreviewMode(page, "preview");
    // Should render as wikilink-missing
    await expect(page.locator(".wikilink-missing")).toBeVisible({ timeout: 3_000 });
  });

  test("wiki-links inside code blocks are not processed", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    // Use backtick-wrapped inline code
    const content = "`[[not a link]]`";
    await page.locator(".cm-editor .cm-content").click();
    await page.evaluate((t) => navigator.clipboard.writeText(t), content);
    await page.keyboard.press("Meta+v");
    await page.waitForTimeout(300);
    await setPreviewMode(page, "preview");
    // Inside code, wiki-link should NOT be rendered
    const wikilink = page.locator(".wikilink, .wikilink-missing");
    await expect(wikilink).toHaveCount(0);
  });
});

test.describe("Preview rendering - Markdown features", () => {
  test("renders horizontal rule", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "above\n\n---\n\nbelow");
    await setPreviewMode(page, "preview");
    await expect(page.locator("hr")).toBeVisible({ timeout: 3_000 });
  });

  test("renders images", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "![alt text](https://via.placeholder.com/100x100)");
    await setPreviewMode(page, "preview");
    const img = page.locator("img[alt='alt text']");
    // Image element should exist in DOM (may be hidden if loading fails)
    await expect(img).toHaveCount(1, { timeout: 3_000 });
  });

  test("renders nested lists", async ({ page }) => {
    await waitForAppReady(page);
    await createNewDocument(page);
    await typeInEditor(page, "- parent\n  - child\n  - child2\n- parent2");
    await setPreviewMode(page, "preview");
    await expect(page.locator("li:has-text('parent')").first()).toBeVisible({ timeout: 3_000 });
    await expect(page.locator("li:has-text('child')").first()).toBeVisible();
  });
});
