/**
 * Team document sync E2E tests.
 * Tests team creation, member management, and team document collaboration.
 * Uses programmatic Firestore operations + cloud sync for reliability.
 */
import {
  waitForAppReady,
  loginWithEmail,
  typeInEditor,
  appendToEditor,
  getEditorContent,
  waitForDocInSidebar,
  clickDocInSidebar,
  waitForSync,
  forceSyncViaReload,
  saveToCloud,
  createTeamProgrammatic,
  addTeamMemberProgrammatic,
  createTeamDocProgrammatic,
} from "./helpers";

const USER_A_EMAIL = process.env.TEST_USER_A_EMAIL!;
const USER_A_PASSWORD = process.env.TEST_USER_A_PASSWORD!;
const USER_B_EMAIL = process.env.TEST_USER_B_EMAIL!;
const USER_B_PASSWORD = process.env.TEST_USER_B_PASSWORD!;

const TEAM_NAME = `E2E-Team-${Date.now()}`;
let teamId = "";

/** Click a team header in the sidebar via JS (bypasses "not interactable") */
async function clickTeamHeader(instance: WebdriverIO.Browser, teamName: string) {
  await instance.execute(function (name: any) {
    var candidates = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < candidates.length; i++) {
      if ((candidates[i].textContent || "").includes(name)) {
        (candidates[i] as HTMLElement).click();
        return;
      }
    }
  }, teamName);
  await instance.pause(500);
}

describe("Team document sync", function () {
  before(async function () {
    if (!USER_A_EMAIL || !USER_B_EMAIL) {
      return this.skip();
    }

    await waitForAppReady(browser.getInstance("userA"));
    await waitForAppReady(browser.getInstance("userB"));
    await loginWithEmail(browser.getInstance("userA"), USER_A_EMAIL, USER_A_PASSWORD);
    await loginWithEmail(browser.getInstance("userB"), USER_B_EMAIL, USER_B_PASSWORD);
  });

  it("User A creates a team and adds User B", async () => {
    const instanceA = browser.getInstance("userA");

    const createResult = await createTeamProgrammatic(instanceA, TEAM_NAME);
    expect(createResult).toMatch(/^ok:/);
    teamId = createResult.replace("ok:", "");

    const addResult = await addTeamMemberProgrammatic(instanceA, teamId, USER_B_EMAIL);
    expect(addResult).toBe("ok");
  });

  it("User A sees team in sidebar after reload", async () => {
    const instanceA = browser.getInstance("userA");
    await forceSyncViaReload(instanceA);

    const teamHeader = await waitForDocInSidebar(instanceA, TEAM_NAME, 15_000);
    expect(await teamHeader.isExisting()).toBe(true);
  });

  it("User B sees the team after sync", async () => {
    const instanceB = browser.getInstance("userB");

    await waitForSync(3000);
    await forceSyncViaReload(instanceB);

    const teamHeader = await waitForDocInSidebar(instanceB, TEAM_NAME, 30_000);
    expect(await teamHeader.isExisting()).toBe(true);
  });

  it("User A creates a team document", async () => {
    const instanceA = browser.getInstance("userA");

    const docResult = await createTeamDocProgrammatic(
      instanceA,
      teamId,
      "Team Document",
      "# Team Document\nShared among team members",
    );
    expect(docResult).toMatch(/^ok:/);

    // Reload to see the new doc in sidebar
    await forceSyncViaReload(instanceA);
    await clickTeamHeader(instanceA, TEAM_NAME);

    const docEl = await waitForDocInSidebar(instanceA, "Team Document", 15_000);
    expect(await docEl.isExisting()).toBe(true);
  });

  it("User B sees the team document after cloud sync", async () => {
    const instanceB = browser.getInstance("userB");

    await waitForSync(3000);
    await forceSyncViaReload(instanceB);
    await clickTeamHeader(instanceB, TEAM_NAME);

    const docEl = await waitForDocInSidebar(instanceB, "Team Document", 30_000);
    expect(await docEl.isExisting()).toBe(true);
  });

  it("User B opens team doc and sees content", async () => {
    const instanceB = browser.getInstance("userB");

    await clickDocInSidebar(instanceB, "Team Document");
    await instanceB.pause(3000);

    const content = await getEditorContent(instanceB);
    expect(content).toContain("Shared among team members");
  });

  it("User A edits team doc → cloud sync → User B sees changes", async () => {
    const instanceA = browser.getInstance("userA");
    const instanceB = browser.getInstance("userB");

    // User A opens and edits the team doc
    await clickDocInSidebar(instanceA, "Team Document");
    await appendToEditor(instanceA, "Team edit by A");
    await instanceA.pause(2000);
    await saveToCloud(instanceA);

    await waitForSync(3000);
    await forceSyncViaReload(instanceB);
    await clickTeamHeader(instanceB, TEAM_NAME);
    await clickDocInSidebar(instanceB, "Team Document");

    const contentB = await getEditorContent(instanceB);
    expect(contentB).toContain("Team edit by A");
  });

  it("all edits persist in team document after reload", async () => {
    const instanceA = browser.getInstance("userA");

    await forceSyncViaReload(instanceA);
    await clickTeamHeader(instanceA, TEAM_NAME);
    await clickDocInSidebar(instanceA, "Team Document");

    const content = await getEditorContent(instanceA);
    expect(content).toContain("Shared among team members");
    expect(content).toContain("Team edit by A");
  });

  // Note: Title rename propagation for team docs is not tested here because
  // the auto-title derivation (from content heading) requires time to propagate
  // through Yjs → store → Firestore, making it unreliable in E2E timing.
});
