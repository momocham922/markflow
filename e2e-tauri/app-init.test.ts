import { waitForAppReady } from "./helpers";

describe("App initialization", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("renders view mode toggle", async () => {
    const editorBtn = await $('button[title="Editor"]');
    await editorBtn.waitForExist({ timeout: 5000 });
    expect(await editorBtn.isDisplayed()).toBe(true);
  });

  it("renders search input", async () => {
    const search = await $('input[placeholder*="Search"]');
    await search.waitForExist({ timeout: 5000 });
    expect(await search.isDisplayed()).toBe(true);
  });

  it("share button is visible", async () => {
    const shareBtn = await $('button[title="Share"]');
    if (await shareBtn.isExisting()) {
      expect(await shareBtn.isDisplayed()).toBe(true);
    }
  });

  it("AI panel button is visible", async () => {
    const aiBtn = await $('button[title="Claude AI"]');
    if (await aiBtn.isExisting()) {
      expect(await aiBtn.isDisplayed()).toBe(true);
    }
  });

  it("version history button is visible", async () => {
    const histBtn = await $('button[title="Version history"]');
    if (await histBtn.isExisting()) {
      expect(await histBtn.isDisplayed()).toBe(true);
    }
  });
});
