/**
 * Shared document sync E2E tests.
 * Two Tauri instances (userA, userB) test collaboration on shared docs.
 * Uses cloud sync (Firestore) for cross-instance propagation.
 */
import {
  waitForAppReady,
  loginWithEmail,
  createNewDocument,
  typeInEditor,
  appendToEditor,
  getEditorContent,
  focusEditor,
  waitForDocInSidebar,
  clickDocInSidebar,
  waitForSync,
  forceSyncViaReload,
  shareDocProgrammatic,
  saveToCloud,
} from "./helpers";

const USER_A_EMAIL = process.env.TEST_USER_A_EMAIL!;
const USER_A_PASSWORD = process.env.TEST_USER_A_PASSWORD!;
const USER_B_EMAIL = process.env.TEST_USER_B_EMAIL!;
const USER_B_PASSWORD = process.env.TEST_USER_B_PASSWORD!;

describe("Shared document sync", () => {
  before(async () => {
    if (!USER_A_EMAIL || !USER_B_EMAIL) {
      throw new Error(
        "TEST_USER_A_EMAIL/PASSWORD and TEST_USER_B_EMAIL/PASSWORD env vars required",
      );
    }
  });

  it("both instances load and sign in", async () => {
    await waitForAppReady(browser.getInstance("userA"));
    await waitForAppReady(browser.getInstance("userB"));

    await loginWithEmail(browser.getInstance("userA"), USER_A_EMAIL, USER_A_PASSWORD);
    await loginWithEmail(browser.getInstance("userB"), USER_B_EMAIL, USER_B_PASSWORD);
  });

  it("User A creates a doc and shares with User B", async () => {
    const instanceA = browser.getInstance("userA");

    await createNewDocument(instanceA);
    await typeInEditor(instanceA, "# Shared Test Doc\nCreated by User A", true);
    await instanceA.pause(2000);

    const shareResult = await shareDocProgrammatic(instanceA, USER_B_EMAIL, "editor");
    expect(shareResult).toMatch(/^ok:/);
  });

  it("User B sees the shared doc in sidebar", async () => {
    const instanceB = browser.getInstance("userB");

    await waitForSync(5000);
    await forceSyncViaReload(instanceB);

    let docEl: WebdriverIO.Element;
    try {
      docEl = await waitForDocInSidebar(instanceB, "Shared Test Doc", 15_000);
    } catch {
      await forceSyncViaReload(instanceB);
      docEl = await waitForDocInSidebar(instanceB, "Shared Test Doc", 30_000);
    }
    expect(await docEl.isExisting()).toBe(true);
  });

  it("User B opens shared doc and sees User A content", async () => {
    const instanceB = browser.getInstance("userB");

    await clickDocInSidebar(instanceB, "Shared Test Doc");
    const content = await getEditorContent(instanceB);
    expect(content).toContain("Created by User A");
  });

  it("User A edits → cloud sync → User B sees changes", async () => {
    const instanceA = browser.getInstance("userA");
    const instanceB = browser.getInstance("userB");

    await appendToEditor(instanceA, "Edit from A");
    await instanceA.pause(2000);
    await saveToCloud(instanceA);

    await waitForSync(3000);
    await forceSyncViaReload(instanceB);
    await clickDocInSidebar(instanceB, "Shared Test Doc");

    const contentB = await getEditorContent(instanceB);
    expect(contentB).toContain("Edit from A");
  });

  it("User A renames doc → title propagates to User B", async () => {
    const instanceA = browser.getInstance("userA");
    const instanceB = browser.getInstance("userB");

    await typeInEditor(instanceA, "# Renamed Doc\nContent after rename", true);
    await instanceA.pause(2000);
    await saveToCloud(instanceA);

    await waitForSync(5000);
    await forceSyncViaReload(instanceB);

    const docEl = await waitForDocInSidebar(instanceB, "Renamed Doc", 30_000);
    expect(await docEl.isExisting()).toBe(true);
  });

  it("User A rewrites content → User B sees new content", async () => {
    const instanceA = browser.getInstance("userA");
    const instanceB = browser.getInstance("userB");

    await typeInEditor(instanceA, "# Final Version\nCompletely rewritten", true);
    await instanceA.pause(2000);
    await saveToCloud(instanceA);

    await waitForSync(3000);
    await forceSyncViaReload(instanceB);
    await clickDocInSidebar(instanceB, "Final Version");

    const contentB = await getEditorContent(instanceB);
    expect(contentB).toContain("Completely rewritten");
  });
});
