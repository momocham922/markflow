import { waitForAppReady } from "./helpers";

describe("App initialization", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("renders import button in top bar", async () => {
    const importBtn = await $('button[title="Import .md file"]');
    await importBtn.waitForExist({ timeout: 5000 });
    expect(await importBtn.isDisplayed()).toBe(true);
  });

  it("renders search input", async () => {
    const search = await $('input[placeholder*="Search"]');
    await search.waitForExist({ timeout: 5000 });
    expect(await search.isDisplayed()).toBe(true);
  });

  it("share button is visible", async () => {
    const shareBtn = await $('button[title="Share"]');
    await shareBtn.waitForExist({ timeout: 5000 });
    expect(await shareBtn.isDisplayed()).toBe(true);
  });

  it("AI panel button is visible", async () => {
    const aiBtn = await $('button[title="MarkFlow AI"]');
    await aiBtn.waitForExist({ timeout: 5000 });
    expect(await aiBtn.isDisplayed()).toBe(true);
  });

  it("version history button is visible", async () => {
    const histBtn = await $('button[title="Version history"]');
    await histBtn.waitForExist({ timeout: 5000 });
    expect(await histBtn.isDisplayed()).toBe(true);
  });
});
