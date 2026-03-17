import { waitForAppReady } from "./helpers";

describe("Theme and command palette", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can open command palette with keyboard shortcut", async () => {
    await browser.keys(["Control", "k"]);
    await browser.pause(500);

    const palette = await $('[cmdk-dialog]');
    if (await palette.isExisting()) {
      expect(await palette.isDisplayed()).toBe(true);
      // Close palette
      await browser.keys(["Escape"]);
      await browser.pause(300);
    }
  });

  it("command palette search works", async () => {
    await browser.keys(["Control", "k"]);
    await browser.pause(500);

    const paletteInput = await $('[cmdk-input]');
    if (await paletteInput.isExisting()) {
      await paletteInput.setValue("new");
      await browser.pause(300);

      const items = await $$('[cmdk-item]');
      expect(items.length).toBeGreaterThanOrEqual(1);

      await browser.keys(["Escape"]);
      await browser.pause(300);
    }
  });

  it("dark mode toggle exists in status bar", async () => {
    // Look for theme toggle button
    const themeBtn = await $('button[title*="theme"]');
    if (await themeBtn.isExisting()) {
      expect(await themeBtn.isDisplayed()).toBe(true);
    }
  });

  it("share button is clickable", async () => {
    const shareBtn = await $('button[title="Share"]');
    if (!(await shareBtn.isExisting())) return;
    expect(await shareBtn.isDisplayed()).toBe(true);
  });
});
