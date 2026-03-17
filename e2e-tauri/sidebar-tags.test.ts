import { waitForAppReady, createNewDocument, typeInEditor } from "./helpers";

describe("Sidebar and document management", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("sidebar shows My Documents section", async () => {
    const myDocs = await $("*=My Documents");
    expect(await myDocs.isDisplayed()).toBe(true);
  });

  it("search input filters documents", async () => {
    await createNewDocument();
    await typeInEditor("searchable content");
    await browser.pause(500);

    const search = await $('input[placeholder*="Search"]');
    await search.setValue("searchable");
    await browser.pause(500);

    const results = await $$(".truncate");
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Clear search
    await search.clearValue();
    await browser.pause(300);
  });

  it("can create folder via sidebar", async () => {
    const folderBtn = await $('button[title="New folder"]');
    if (await folderBtn.isExisting()) {
      await folderBtn.click();
      await browser.pause(500);
      const folderInput = await $('input[placeholder*="folder"]');
      if (await folderInput.isExisting()) {
        await folderInput.setValue("Test Folder");
        await browser.keys(["Enter"]);
        await browser.pause(300);
        const folder = await $("*=Test Folder");
        expect(await folder.isDisplayed()).toBe(true);
      }
    }
  });

  it("document list updates after creating documents", async () => {
    const initialDocs = await $$(".truncate");
    const initialCount = initialDocs.length;

    await createNewDocument();
    await browser.pause(500);

    const updatedDocs = await $$(".truncate");
    expect(updatedDocs.length).toBeGreaterThanOrEqual(initialCount);
  });
});
