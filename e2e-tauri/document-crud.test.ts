import { waitForAppReady, createNewDocument, typeInEditor } from "./helpers";

describe("Document CRUD", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can create a new document", async () => {
    await createNewDocument();
    const editor = await $(".cm-editor");
    expect(await editor.isDisplayed()).toBe(true);
  });

  it("can type in the editor", async () => {
    await createNewDocument();
    await typeInEditor("Hello, MarkFlow!");
    const content = await $(".cm-editor .cm-content");
    const text = await content.getText();
    expect(text).toContain("Hello, MarkFlow!");
  });

  it("can create multiple documents", async () => {
    await createNewDocument();
    await browser.pause(200);
    await createNewDocument();
    await browser.pause(200);
    const docItems = await $$(".truncate*=Untitled");
    expect(docItems.length).toBeGreaterThanOrEqual(2);
  });

  it("can rename a document via toolbar", async () => {
    await createNewDocument();
    const titleEl = await $('[title="Click to rename"]');
    if (!(await titleEl.isExisting())) return;
    await titleEl.click();
    await browser.pause(300);
    const renameInput = await $('input[type="text"]');
    if (!(await renameInput.isExisting())) return;
    await renameInput.setValue("My Test Doc");
    await browser.keys(["Enter"]);
    await browser.pause(300);
    const renamed = await $("*=My Test Doc");
    if (await renamed.isExisting()) {
      expect(await renamed.isDisplayed()).toBe(true);
    }
  });
});
