import { waitForAppReady, createNewDocument, typeInEditor, setPreviewMode } from "./helpers";

describe("Editor formatting toolbar", () => {
  beforeEach(async () => {
    await waitForAppReady();
    await createNewDocument();
  });

  it("bold button wraps selection", async () => {
    await typeInEditor("hello");
    await browser.keys(["Control", "a"]);
    const boldBtn = await $('button[title="Bold (Cmd+B)"]');
    await boldBtn.click();
    const content = await $(".cm-editor .cm-content").then((el) => el.getText());
    expect(content).toContain("**");
  });

  it("heading buttons add line prefix", async () => {
    await typeInEditor("title");
    const h1Btn = await $('button[title="Heading 1"]');
    await h1Btn.click();
    const content = await $(".cm-editor .cm-content").then((el) => el.getText());
    expect(content).toContain("# ");
  });

  it("bullet list button adds prefix", async () => {
    await typeInEditor("item");
    const listBtn = await $('button[title="Bullet list"]');
    await listBtn.click();
    const content = await $(".cm-editor .cm-content").then((el) => el.getText());
    expect(content).toContain("- ");
  });

  it("blockquote button adds prefix", async () => {
    await typeInEditor("quote");
    const quoteBtn = await $('button[title="Blockquote"]');
    await quoteBtn.click();
    const content = await $(".cm-editor .cm-content").then((el) => el.getText());
    expect(content).toContain("> ");
  });
});

describe("Preview modes", () => {
  beforeEach(async () => {
    await waitForAppReady();
    await createNewDocument();
  });

  it("split mode shows editor and preview", async () => {
    await typeInEditor("# Hello World");
    await setPreviewMode("split");
    const editor = await $(".cm-editor");
    expect(await editor.isDisplayed()).toBe(true);
    const heading = await $("h1=Hello World");
    await heading.waitForDisplayed({ timeout: 3000 });
    expect(await heading.isDisplayed()).toBe(true);
  });

  it("preview mode hides editor", async () => {
    await typeInEditor("# Preview Test");
    await setPreviewMode("preview");
    const heading = await $("h1=Preview Test");
    await heading.waitForDisplayed({ timeout: 3000 });
    const editor = await $(".cm-editor");
    expect(await editor.isDisplayed()).toBe(false);
  });

  it("switching modes preserves content", async () => {
    await typeInEditor("persistent content");
    await setPreviewMode("preview");
    await setPreviewMode("edit");
    const content = await $(".cm-editor .cm-content").then((el) => el.getText());
    expect(content).toContain("persistent content");
  });
});
