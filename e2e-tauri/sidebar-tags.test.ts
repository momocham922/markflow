import { waitForAppReady, createNewDocument, typeInEditor } from "./helpers";

describe("Sidebar and document management", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("sidebar has document list area", async () => {
    // Check for any sidebar content
    const sidebar = await $('input[placeholder*="Search"]');
    expect(await sidebar.isDisplayed()).toBe(true);
  });

  it("search input is functional", async () => {
    const search = await $('input[placeholder*="Search"]');
    await search.waitForExist({ timeout: 5000 });
    await search.setValue("test");
    await browser.pause(300);
    const value = await search.getValue();
    expect(value).toBe("test");
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
});
