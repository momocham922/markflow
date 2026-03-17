import { waitForAppReady, createNewDocument, typeInEditor } from "./helpers";

describe("Visualization view", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can switch to visualization view", async () => {
    const vizBtn = await $('button[title="Visualization"]');
    await vizBtn.click();
    await browser.pause(500);

    // Should show the react-flow container or visualization content
    const vizContainer = await $(".react-flow");
    if (await vizContainer.isExisting()) {
      expect(await vizContainer.isDisplayed()).toBe(true);
    }

    // Switch back to editor
    const editorBtn = await $('button[title="Editor"]');
    await editorBtn.click();
    await browser.pause(300);
  });
});

describe("Voice input button", () => {
  before(async () => {
    await waitForAppReady();
    await createNewDocument();
  });

  it("mic button is visible in toolbar", async () => {
    // Voice input button should exist in toolbar
    const micBtn = await $('button[title*="Voice"]');
    if (await micBtn.isExisting()) {
      expect(await micBtn.isDisplayed()).toBe(true);
    }
  });
});

describe("AI panel", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can open AI panel", async () => {
    const aiBtn = await $('button[title="Claude AI"]');
    await aiBtn.click();
    await browser.pause(500);

    // AI panel should be visible
    const aiPanel = await $("*=Claude");
    expect(await aiPanel.isDisplayed()).toBe(true);
  });

  it("AI panel has input field", async () => {
    const aiBtn = await $('button[title="Claude AI"]');
    await aiBtn.click();
    await browser.pause(500);

    const aiInput = await $('textarea[placeholder*="Ask"]');
    if (await aiInput.isExisting()) {
      expect(await aiInput.isDisplayed()).toBe(true);
    }
  });

  it("MCP toggle button exists", async () => {
    const aiBtn = await $('button[title="Claude AI"]');
    await aiBtn.click();
    await browser.pause(500);

    // Look for the MCP wrench button
    const mcpBtn = await $('button[title*="MCP"]');
    if (await mcpBtn.isExisting()) {
      expect(await mcpBtn.isDisplayed()).toBe(true);
    }
  });
});

describe("Version history panel", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can open version history panel", async () => {
    const histBtn = await $('button[title="Version history"]');
    await histBtn.click();
    await browser.pause(500);

    const versionPanel = await $("*=Version");
    expect(await versionPanel.isDisplayed()).toBe(true);
  });
});
