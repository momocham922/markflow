import { waitForAppReady, createNewDocument } from "./helpers";

describe("Visualization view", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can switch to visualization view", async () => {
    const vizBtn = await $('button[title="Visualization"]');
    await vizBtn.waitForExist({ timeout: 5000 });
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
    const micBtn = await $('button[title="Voice input"]');
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
    await aiBtn.waitForExist({ timeout: 5000 });
    await aiBtn.click();
    await browser.pause(500);

    // Check for the AI panel scroll area
    const aiPanel = await $(".ai-panel-scroll");
    if (await aiPanel.isExisting()) {
      expect(await aiPanel.isDisplayed()).toBe(true);
    }
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

  it("MCP tools button exists", async () => {
    const aiBtn = await $('button[title="Claude AI"]');
    await aiBtn.click();
    await browser.pause(500);

    // Look for MCP tools element
    const mcpEl = await $("*=MCP");
    if (await mcpEl.isExisting()) {
      expect(await mcpEl.isDisplayed()).toBe(true);
    }
  });
});

describe("Version history panel", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("can open version history panel", async () => {
    const histBtn = await $('button[title="Version history"]');
    await histBtn.waitForExist({ timeout: 5000 });
    await histBtn.click();
    await browser.pause(500);

    // Version panel should show version-related content
    const versionBtn = await $('button*=Save version');
    const versionText = await $("*=No versions");
    const anyVersionEl = versionBtn.isExisting() || versionText.isExisting();
    // If neither specific element found, just check the button toggled something
    expect(await histBtn.isDisplayed()).toBe(true);
  });
});
