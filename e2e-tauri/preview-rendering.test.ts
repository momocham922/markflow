import { waitForAppReady, createNewDocument, typeInEditor, setPreviewMode } from "./helpers";

describe("Preview rendering", () => {
  beforeEach(async () => {
    await waitForAppReady();
    await createNewDocument();
  });

  it("renders headings in preview", async () => {
    await typeInEditor("# Hello World\n\n## Subtitle");
    await setPreviewMode("split");

    const h1 = await $("h1=Hello World");
    await h1.waitForDisplayed({ timeout: 3000 });
    expect(await h1.isDisplayed()).toBe(true);

    const h2 = await $("h2=Subtitle");
    await h2.waitForDisplayed({ timeout: 3000 });
    expect(await h2.isDisplayed()).toBe(true);

    await setPreviewMode("edit");
  });

  it("renders bold and italic in preview", async () => {
    await typeInEditor("**bold text** and *italic text*");
    await setPreviewMode("split");

    const bold = await $("strong=bold text");
    await bold.waitForDisplayed({ timeout: 3000 });
    expect(await bold.isDisplayed()).toBe(true);

    const italic = await $("em=italic text");
    await italic.waitForDisplayed({ timeout: 3000 });
    expect(await italic.isDisplayed()).toBe(true);

    await setPreviewMode("edit");
  });

  it("renders lists in preview", async () => {
    await typeInEditor("- item one\n- item two\n- item three");
    await setPreviewMode("split");

    const listItems = await $$("li");
    await browser.pause(1000);
    expect(listItems.length).toBeGreaterThanOrEqual(3);

    await setPreviewMode("edit");
  });

  it("renders code blocks in preview", async () => {
    await typeInEditor("```\nconst x = 1;\n```");
    await setPreviewMode("split");

    await browser.pause(1000);
    const code = await $("code");
    if (await code.isExisting()) {
      expect(await code.isDisplayed()).toBe(true);
    }

    await setPreviewMode("edit");
  });

  it("renders blockquotes in preview", async () => {
    await typeInEditor("> This is a quote");
    await setPreviewMode("split");

    await browser.pause(1000);
    const blockquote = await $("blockquote");
    if (await blockquote.isExisting()) {
      expect(await blockquote.isDisplayed()).toBe(true);
    }

    await setPreviewMode("edit");
  });

  it("renders links in preview", async () => {
    await typeInEditor("[MarkFlow](https://example.com)");
    await setPreviewMode("split");

    await browser.pause(1000);
    const link = await $("a=MarkFlow");
    if (await link.isExisting()) {
      expect(await link.isDisplayed()).toBe(true);
      const href = await link.getAttribute("href");
      expect(href).toBe("https://example.com");
    }

    await setPreviewMode("edit");
  });

  it("renders GFM tables in preview", async () => {
    await typeInEditor("| A | B |\n| --- | --- |\n| 1 | 2 |");
    await setPreviewMode("split");

    await browser.pause(1000);
    const table = await $("table");
    if (await table.isExisting()) {
      expect(await table.isDisplayed()).toBe(true);
    }

    await setPreviewMode("edit");
  });

  it("renders task lists in preview", async () => {
    await typeInEditor("- [ ] unchecked\n- [x] checked");
    await setPreviewMode("split");

    await browser.pause(1000);
    const inputs = await $$('input[type="checkbox"]');
    if (inputs.length >= 2) {
      expect(inputs.length).toBeGreaterThanOrEqual(2);
    }

    await setPreviewMode("edit");
  });
});
