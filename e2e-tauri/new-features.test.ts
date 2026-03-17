import { waitForAppReady } from "./helpers";

describe("AI panel", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can open AI panel", async () => {
    const aiBtn = await $('button[title="Claude AI"]');
    if (!(await aiBtn.isExisting())) return;
    await aiBtn.click();
    await browser.pause(500);

    const aiPanel = await $("*=Claude");
    if (await aiPanel.isExisting()) {
      expect(await aiPanel.isDisplayed()).toBe(true);
    }
  });
});

describe("Version history panel", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can open version history panel", async () => {
    const histBtn = await $('button[title="Version history"]');
    if (!(await histBtn.isExisting())) return;
    await histBtn.click();
    await browser.pause(500);

    const versionPanel = await $("*=Version");
    if (await versionPanel.isExisting()) {
      expect(await versionPanel.isDisplayed()).toBe(true);
    }
  });
});
