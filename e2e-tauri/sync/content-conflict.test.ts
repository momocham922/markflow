/**
 * Content conflict and edge-case sync tests.
 * Tests scenarios that historically caused data loss, reversion, or ghost recovery.
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

describe("Content conflict resolution", function () {
  before(async function () {
    if (!USER_A_EMAIL || !USER_B_EMAIL) {
      return this.skip();
    }
    await waitForAppReady(browser.getInstance("userA"));
    await waitForAppReady(browser.getInstance("userB"));
    await loginWithEmail(browser.getInstance("userA"), USER_A_EMAIL, USER_A_PASSWORD);
    await loginWithEmail(browser.getInstance("userB"), USER_B_EMAIL, USER_B_PASSWORD);
  });

  describe("Owner edits propagate to collaborator", () => {
    it("setup: create and share a doc", async () => {
      const instanceA = browser.getInstance("userA");
      await createNewDocument(instanceA);
      await typeInEditor(instanceA, "# Conflict Test\nBase content", true);
      await instanceA.pause(2000);

      const shareResult = await shareDocProgrammatic(instanceA, USER_B_EMAIL, "editor");
      expect(shareResult).toMatch(/^ok:/);
      await waitForSync(5000);
      await forceSyncViaReload(browser.getInstance("userB"));
    });

    it("User A appends text → User B sees via cloud sync", async () => {
      const instanceA = browser.getInstance("userA");
      const instanceB = browser.getInstance("userB");

      await appendToEditor(instanceA, "Alpha addition");
      await instanceA.pause(2000);
      await saveToCloud(instanceA);

      await waitForSync(3000);
      await forceSyncViaReload(instanceB);
      await clickDocInSidebar(instanceB, "Conflict Test");

      const contentB = await getEditorContent(instanceB);
      expect(contentB).toContain("Alpha");
      expect(contentB).toContain("Base content");
    });

    it("User A appends more text → User B sees accumulated edits", async () => {
      const instanceA = browser.getInstance("userA");
      const instanceB = browser.getInstance("userB");

      await appendToEditor(instanceA, "Beta addition");
      await instanceA.pause(2000);
      await saveToCloud(instanceA);

      await waitForSync(3000);
      await forceSyncViaReload(instanceB);
      await clickDocInSidebar(instanceB, "Conflict Test");

      const contentB = await getEditorContent(instanceB);
      expect(contentB).toContain("Alpha");
      expect(contentB).toContain("Beta");
    });
  });

  describe("Content clearing edge cases", () => {
    it("setup: create shared doc with content", async () => {
      const instanceA = browser.getInstance("userA");
      await createNewDocument(instanceA);
      await typeInEditor(instanceA, "# Clear Edge Test\nImportant content here", true);
      await instanceA.pause(2000);

      const shareResult = await shareDocProgrammatic(instanceA, USER_B_EMAIL, "editor");
      expect(shareResult).toMatch(/^ok:/);
      await waitForSync(5000);
      await forceSyncViaReload(browser.getInstance("userB"));
    });

    it("User A clears and rewrites — User B sees new content via cloud sync", async () => {
      const instanceA = browser.getInstance("userA");
      const instanceB = browser.getInstance("userB");

      await typeInEditor(instanceA, "# Recovered\nNew content after clear", true);
      await instanceA.pause(2000);
      await saveToCloud(instanceA);

      await waitForSync(3000);
      await forceSyncViaReload(instanceB);
      await clickDocInSidebar(instanceB, "Recovered");

      const contentB = await getEditorContent(instanceB);
      expect(contentB).toContain("Recovered");
      expect(contentB).toContain("New content after clear");
    });
  });

  describe("Stale sync overwrite prevention", () => {
    it("setup: create shared doc", async () => {
      const instanceA = browser.getInstance("userA");
      await createNewDocument(instanceA);
      await typeInEditor(instanceA, "# Stale Test\nOriginal by A", true);
      await instanceA.pause(2000);

      const shareResult = await shareDocProgrammatic(instanceA, USER_B_EMAIL, "editor");
      expect(shareResult).toMatch(/^ok:/);
      await waitForSync(5000);
      await forceSyncViaReload(browser.getInstance("userB"));
      await clickDocInSidebar(browser.getInstance("userB"), "Stale Test");
    });

    it("User A edits — content persists after sync cycle", async () => {
      const instanceA = browser.getInstance("userA");

      await appendToEditor(instanceA, "A's important edit");
      await instanceA.pause(2000);
      await saveToCloud(instanceA);

      // Trigger a sync cycle
      await waitForSync(3000);
      await forceSyncViaReload(instanceA);

      // A's edit should still be present
      await clickDocInSidebar(instanceA, "Stale Test");
      const afterA = await getEditorContent(instanceA);
      expect(afterA).toContain("A's important edit");
    });
  });

  describe("Document switching stability", () => {
    it("switching between docs preserves content", async () => {
      const instanceA = browser.getInstance("userA");

      // Create two docs
      await createNewDocument(instanceA);
      await typeInEditor(instanceA, "# Switch Test 1\nContent of doc 1", true);
      await instanceA.pause(1500);
      await saveToCloud(instanceA);

      await createNewDocument(instanceA);
      await typeInEditor(instanceA, "# Switch Test 2\nContent of doc 2", true);
      await instanceA.pause(1500);
      await saveToCloud(instanceA);

      // Switch to doc 1
      await clickDocInSidebar(instanceA, "Switch Test 1");
      const content1 = await getEditorContent(instanceA);
      expect(content1).toContain("Content of doc 1");

      // Switch to doc 2
      await clickDocInSidebar(instanceA, "Switch Test 2");
      const content2 = await getEditorContent(instanceA);
      expect(content2).toContain("Content of doc 2");

      // Switch back to doc 1 — should NOT have reverted
      await clickDocInSidebar(instanceA, "Switch Test 1");
      const content1Again = await getEditorContent(instanceA);
      expect(content1Again).toContain("Content of doc 1");
    });
  });
});
