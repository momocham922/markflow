import { waitForAppReady } from "./helpers";

describe("App initialization", () => {
  before(async () => {
    await waitForAppReady();
  });

  it("renders view mode toggle", async () => {
    const editorBtn = await $('button[title="Editor"]');
    expect(await editorBtn.isDisplayed()).toBe(true);
    const canvasBtn = await $('button[title="Canvas"]');
    expect(await canvasBtn.isDisplayed()).toBe(true);
  });

  it("renders visualization button", async () => {
    const vizBtn = await $('button[title="Visualization"]');
    expect(await vizBtn.isDisplayed()).toBe(true);
  });

  it("renders status bar with Local label", async () => {
    const statusBar = await $("*=Local");
    expect(await statusBar.isDisplayed()).toBe(true);
  });

  it("renders sidebar with My Documents", async () => {
    const myDocs = await $("*=My Documents");
    expect(await myDocs.isDisplayed()).toBe(true);
  });

  it("renders search input", async () => {
    const search = await $('input[placeholder*="Search"]');
    expect(await search.isDisplayed()).toBe(true);
  });

  it("share button is visible", async () => {
    const shareBtn = await $('button[title="Share"]');
    expect(await shareBtn.isDisplayed()).toBe(true);
  });

  it("AI panel button is visible", async () => {
    const aiBtn = await $('button[title="Claude AI"]');
    expect(await aiBtn.isDisplayed()).toBe(true);
  });

  it("version history button is visible", async () => {
    const histBtn = await $('button[title="Version history"]');
    expect(await histBtn.isDisplayed()).toBe(true);
  });
});
