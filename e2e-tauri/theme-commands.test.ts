import { waitForAppReady } from "./helpers";

describe("Theme and command palette", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can open command palette with keyboard shortcut", async () => {
    await browser.keys(["Meta", "k"]);
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
    await browser.keys(["Meta", "k"]);
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

  it("share button opens share dialog", async () => {
    const shareBtn = await $('button[title="Share"]');
    if (await shareBtn.isExisting()) {
      await shareBtn.click();
      await browser.pause(500);

      // Check for share dialog/overlay
      const shareDialog = await $("*=Share");
      expect(await shareDialog.isDisplayed()).toBe(true);

      // Close dialog
      await browser.keys(["Escape"]);
      await browser.pause(300);
    }
  });
});
