/**
 * Helpers for multi-instance sync E2E tests.
 * Uses WebDriverIO multiremote to control two Tauri app instances (userA, userB).
 */

/** Wait for a specific browser instance to load the app */
export async function waitForAppReady(instance: WebdriverIO.Browser) {
  await instance.waitUntil(
    async () => {
      const sidebar = await instance.$('input[placeholder*="Search"]');
      if (await sidebar.isExisting()) return true;
      const editor = await instance.$(".cm-editor");
      if (await editor.isExisting()) return true;
      return false;
    },
    { timeout: 30_000, interval: 500, timeoutMsg: "App did not load within 30s" },
  );
  await instance.pause(1000);
}

/** Sign in with email/password via the test helper injected by VITE_TEST_MODE */
export async function loginWithEmail(
  instance: WebdriverIO.Browser,
  email: string,
  password: string,
) {
  // Check if already logged in (Sign in button absent = already authenticated)
  const signInBtn = await instance.$('button*=Sign in');
  const needsLogin = await signInBtn.isExisting();

  if (needsLogin) {
    // Pack credentials as single JSON string arg.
    const credsJson = JSON.stringify({ email, password });
    await instance.execute(
      function (creds: any) {
        var parsed = JSON.parse(creds);
        var w = window as any;
        var fn = w.__TEST_LOGIN__;
        if (!fn) { w.__LOGIN_RESULT__ = "error:no_fn"; return; }
        w.__LOGIN_RESULT__ = "pending";
        fn(parsed.email, parsed.password)
          .then(function(uid: any) { w.__LOGIN_RESULT__ = "ok:" + uid; })
          .catch(function(e: any) { w.__LOGIN_RESULT__ = "error:" + (e.message || e); });
      },
      credsJson,
    );

    // Poll until login completes
    await instance.waitUntil(
      async () => {
        const r = await instance.execute(function () {
          return (window as any).__LOGIN_RESULT__;
        });
        if (!r || r === "pending") return false;
        if (typeof r === "string" && r.startsWith("error:")) {
          throw new Error(`Login failed for ${email}: ${r}`);
        }
        return typeof r === "string" && r.startsWith("ok:");
      },
      { timeout: 15_000, interval: 500, timeoutMsg: `Login timed out for ${email}` },
    );

    // Wait for auth state to propagate
    await instance.waitUntil(
      async () => {
        const btn = await instance.$('button*=Sign in');
        return !(await btn.isExisting());
      },
      { timeout: 15_000, interval: 500, timeoutMsg: "Auth state did not propagate" },
    );
  }

  await instance.pause(3000); // wait for syncFromCloud
}

/** Create a new document via the "+" icon */
export async function createNewDocument(instance: WebdriverIO.Browser) {
  const newDocBtn = await instance.$('span[title="New document"]');
  if (await newDocBtn.isExisting()) {
    await newDocBtn.click();
  } else {
    const plusIcons = await instance.$$(".lucide-plus");
    if (plusIcons.length > 0) {
      await plusIcons[0].click();
    }
  }
  const editor = await instance.$(".cm-editor");
  await editor.waitForExist({ timeout: 10_000 });
  await instance.pause(500);
}

/** Type text into the CodeMirror editor via execCommand (works in WebKitGTK) */
export async function typeInEditor(
  instance: WebdriverIO.Browser,
  text: string,
  clear = false,
) {
  if (clear) {
    await focusEditor(instance);
    await instance.keys(["Control", "a"]);
    await instance.keys(["Backspace"]);
    await instance.pause(300);
  }
  if (text) {
    await focusEditor(instance);
    await instance.execute(
      function (txt: any) {
        var el = document.querySelector(".cm-editor .cm-content") as any;
        if (el) { el.focus(); document.execCommand("insertText", false, txt); }
      },
      text,
    );
  }
  await instance.pause(500);
}

/** Append text to the end of the editor (adds a newline before the text) */
export async function appendToEditor(instance: WebdriverIO.Browser, text: string) {
  await focusEditor(instance);
  // Move to end of document
  await instance.keys(["Control", "End"]);
  await instance.keys(["Enter"]);
  await instance.pause(200);
  await instance.execute(
    function (txt: any) {
      var el = document.querySelector(".cm-editor .cm-content") as any;
      if (el) { el.focus(); document.execCommand("insertText", false, txt); }
    },
    text,
  );
  await instance.pause(500);
}

/** Focus the CodeMirror editor via JS (avoids WebKitGTK "not interactable" issue) */
export async function focusEditor(instance: WebdriverIO.Browser) {
  await instance.execute(function () {
    var el = document.querySelector(".cm-editor .cm-content") as any;
    if (el) el.focus();
  });
  await instance.pause(300);
}

/** Get editor content from a specific instance.
 * Shared docs may show "Syncing document..." for up to 15s while waiting
 * for y-websocket connection, so we use a 25s timeout. */
export async function getEditorContent(instance: WebdriverIO.Browser): Promise<string> {
  const content = await instance.$(".cm-editor .cm-content");
  await content.waitForExist({ timeout: 25_000 });
  // WebKitGTK getText() can return empty for styled elements — use JS fallback
  const text = await instance.execute(function () {
    var el = document.querySelector(".cm-editor .cm-content") as HTMLElement;
    return el ? el.textContent || "" : "";
  });
  return text;
}

/** Save the active document to Firestore (via syncToCloud) */
export async function saveToCloud(instance: WebdriverIO.Browser) {
  await instance.execute(function () {
    var fn = (window as any).__TEST_SAVE_TO_CLOUD__;
    if (!fn) { (window as any).__SAVE_RESULT__ = "error:no_fn"; return; }
    (window as any).__SAVE_RESULT__ = "pending";
    fn()
      .then(function (r: any) { (window as any).__SAVE_RESULT__ = r || "ok"; })
      .catch(function (e: any) { (window as any).__SAVE_RESULT__ = "error:" + e; });
  });

  await instance.waitUntil(
    async () => {
      const r = await instance.execute(function () {
        return (window as any).__SAVE_RESULT__;
      });
      return r && r !== "pending";
    },
    { timeout: 15_000, interval: 500, timeoutMsg: "saveToCloud timed out" },
  );
}

/** Open the share dialog for the current document */
export async function openShareDialog(instance: WebdriverIO.Browser) {
  // The share button has title="Share"
  const shareBtn = await instance.$('button[title="Share"]');
  await shareBtn.waitForExist({ timeout: 5000 });
  await shareBtn.click();
  await instance.pause(500);
}

/** Invite a collaborator by email in the share dialog (People tab) */
export async function inviteCollaborator(
  instance: WebdriverIO.Browser,
  email: string,
  role: "editor" | "viewer" = "editor",
) {
  // Switch to People tab (default tab is "link")
  const peopleTab = await instance.$('button*=People');
  await peopleTab.waitForExist({ timeout: 5000 });
  await peopleTab.click();
  await instance.pause(500);

  // Select role before typing email
  if (role !== "viewer") {
    // Default is "viewer", switch to "editor"
    const roleSelect = await instance.$('select');
    if (await roleSelect.isExisting()) {
      await roleSelect.selectByAttribute("value", role);
    }
  }

  // Find the email input (placeholder="Email address")
  const emailInput = await instance.$('input[placeholder="Email address"]');
  await emailInput.waitForExist({ timeout: 5000 });
  await emailInput.setValue(email);

  // Click invite button
  const inviteBtn = await instance.$('button*=Invite');
  await inviteBtn.waitForExist({ timeout: 3000 });
  await inviteBtn.click();
  await instance.pause(2000);
}

/** Wait for a document to appear in the sidebar and return the clickable element.
 * Uses JS textContent because WebKitGTK's getText() returns empty for .truncate spans.
 * Returns via data attribute to avoid race conditions between JS and WDIO. */
export async function waitForDocInSidebar(
  instance: WebdriverIO.Browser,
  titleSubstring: string,
  timeout = 30_000,
): Promise<WebdriverIO.Element> {
  const marker = `test-match-${Date.now()}`;

  await instance.waitUntil(
    async () => {
      // Find and mark the matching clickable element via JS (atomic operation)
      const found = await instance.execute(
        function (sub: any, mark: any) {
          // Remove old markers
          var old = document.querySelector("[data-test-match]");
          if (old) old.removeAttribute("data-test-match");
          // Search buttons AND div[role="button"] (personal docs use div)
          var candidates = document.querySelectorAll('button, [role="button"]');
          for (var i = 0; i < candidates.length; i++) {
            var t = candidates[i].textContent || "";
            if (t.includes(sub)) {
              candidates[i].setAttribute("data-test-match", mark);
              return true;
            }
          }
          return false;
        },
        titleSubstring,
        marker,
      );
      return found;
    },
    { timeout, interval: 2000, timeoutMsg: `Doc "${titleSubstring}" not found in sidebar` },
  );

  const el = await instance.$(`[data-test-match="${marker}"]`);
  await el.waitForExist({ timeout: 5000 });
  return el;
}

/** Click a document in the sidebar (JS click for WebKitGTK interactability) */
export async function clickDocInSidebar(
  instance: WebdriverIO.Browser,
  titleSubstring: string,
) {
  const docEl = await waitForDocInSidebar(instance, titleSubstring);
  // Use JS click to bypass WebKitGTK "not interactable" issues
  await instance.execute(function (sub: any) {
    var candidates = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < candidates.length; i++) {
      if ((candidates[i].textContent || "").includes(sub)) {
        (candidates[i] as HTMLElement).click();
        return;
      }
    }
  }, titleSubstring);
  // Shared docs may show "Syncing document..." for up to 15s (WS timeout)
  const editor = await instance.$(".cm-editor");
  try {
    await editor.waitForExist({ timeout: 25_000 });
  } catch {
    // Editor might not appear if doc has no content or is still syncing
  }
  await instance.pause(1000);
}

/** Wait for sync to propagate (cloud sync has ~3.5s delay + network) */
export async function waitForSync(ms = 8000) {
  await browser.pause(ms);
}

/**
 * Force sync by reloading the page.
 * Reload triggers both syncFromCloud (via auth listener) and
 * sidebar's fetchSharedWithMe (via useEffect on mount).
 * A simple syncFromCloud call is NOT enough because the sidebar
 * maintains its own sharedDocs state separately.
 */
export async function forceSyncViaReload(instance: WebdriverIO.Browser) {
  await instance.refresh();
  await waitForAppReady(instance);
  await instance.pause(5000); // wait for syncFromCloud + fetchSharedWithMe
}

/** Get shared documents visible to this instance's logged-in user */
export async function getSharedDocs(instance: WebdriverIO.Browser): Promise<string> {
  const result = await instance.execute(function () {
    var fn = (window as any).__TEST_GET_SHARED_DOCS__;
    if (!fn) return "no_fn";
    (window as any).__SHARED_DOCS_RESULT__ = "pending";
    fn()
      .then(function (r: any) { (window as any).__SHARED_DOCS_RESULT__ = r; })
      .catch(function (e: any) { (window as any).__SHARED_DOCS_RESULT__ = "error:" + e; });
    return "started";
  });

  if (result !== "started") return "no_fn";

  await instance.waitUntil(
    async () => {
      const r = await instance.execute(function () {
        return (window as any).__SHARED_DOCS_RESULT__;
      });
      return r && r !== "pending";
    },
    { timeout: 10_000, interval: 500, timeoutMsg: "getSharedDocs timed out" },
  );

  return await instance.execute(function () {
    return (window as any).__SHARED_DOCS_RESULT__ || "";
  });
}

/** Share the active document programmatically (bypasses UI) */
export async function shareDocProgrammatic(
  instance: WebdriverIO.Browser,
  email: string,
  role: "editor" | "viewer" = "editor",
): Promise<string> {
  const argsJson = JSON.stringify({ email, role });
  await instance.execute(
    function (args: any) {
      var parsed = JSON.parse(args);
      var fn = (window as any).__TEST_SHARE_DOC__;
      if (!fn) { (window as any).__SHARE_RESULT__ = "error:no_fn"; return; }
      (window as any).__SHARE_RESULT__ = "pending";
      fn(parsed.email, parsed.role)
        .then(function (r: any) { (window as any).__SHARE_RESULT__ = r; })
        .catch(function (e: any) { (window as any).__SHARE_RESULT__ = "error:" + e; });
    },
    argsJson,
  );

  await instance.waitUntil(
    async () => {
      const r = await instance.execute(function () {
        return (window as any).__SHARE_RESULT__;
      });
      return r && r !== "pending";
    },
    { timeout: 15_000, interval: 500, timeoutMsg: "Share doc timed out" },
  );

  return await instance.execute(function () {
    return (window as any).__SHARE_RESULT__ || "";
  });
}

/** Get current user's UID */
export async function getUid(instance: WebdriverIO.Browser): Promise<string> {
  return await instance.execute(function () {
    var fn = (window as any).__TEST_GET_UID__;
    return fn ? fn() : "no_fn";
  });
}

/** Get document info from Firestore for debugging */
export async function getDocInfo(instance: WebdriverIO.Browser, docId: string): Promise<string> {
  await instance.execute(
    function (id: any) {
      var fn = (window as any).__TEST_DOC_INFO__;
      if (!fn) { (window as any).__DOC_INFO_RESULT__ = "no_fn"; return; }
      (window as any).__DOC_INFO_RESULT__ = "pending";
      fn(id)
        .then(function (r: any) { (window as any).__DOC_INFO_RESULT__ = r; })
        .catch(function (e: any) { (window as any).__DOC_INFO_RESULT__ = "error:" + e; });
    },
    docId,
  );

  await instance.waitUntil(
    async () => {
      const r = await instance.execute(function () {
        return (window as any).__DOC_INFO_RESULT__;
      });
      return r && r !== "pending";
    },
    { timeout: 10_000, interval: 500, timeoutMsg: "getDocInfo timed out" },
  );

  return await instance.execute(function () {
    return (window as any).__DOC_INFO_RESULT__ || "";
  });
}

/** Open team management dialog via the Users icon button (JS click for WebKitGTK) */
export async function openTeamDialog(instance: WebdriverIO.Browser) {
  await instance.execute(function () {
    var selectors = ['button[title="Manage Teams"]', 'button[title="Teams"]'];
    for (var i = 0; i < selectors.length; i++) {
      var btn = document.querySelector(selectors[i]) as HTMLElement;
      if (btn) { btn.click(); return; }
    }
    // Fallback: click first .lucide-users parent button
    var icons = document.querySelectorAll(".lucide-users");
    for (var j = 0; j < icons.length; j++) {
      var parent = icons[j].closest("button") as HTMLElement;
      if (parent) { parent.click(); return; }
    }
  });
  await instance.pause(1000);
}

/** Create a team via the team dialog (JS clicks for WebKitGTK) */
export async function createTeam(instance: WebdriverIO.Browser, teamName: string) {
  await openTeamDialog(instance);

  // Input: placeholder="New team name"
  const input = await instance.$('input[placeholder="New team name"]');
  await input.waitForExist({ timeout: 5000 });
  await input.setValue(teamName);

  // Click "Create" button via JS
  await instance.execute(function () {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || "").includes("Create")) { btns[i].click(); return; }
    }
  });
  await instance.pause(2000);
}

/** Create a team programmatically (bypasses UI) */
export async function createTeamProgrammatic(
  instance: WebdriverIO.Browser,
  teamName: string,
): Promise<string> {
  await instance.execute(
    function (name: any) {
      var fn = (window as any).__TEST_CREATE_TEAM__;
      if (!fn) { (window as any).__TEAM_RESULT__ = "error:no_fn"; return; }
      (window as any).__TEAM_RESULT__ = "pending";
      fn(name)
        .then(function (r: any) { (window as any).__TEAM_RESULT__ = r; })
        .catch(function (e: any) { (window as any).__TEAM_RESULT__ = "error:" + e; });
    },
    teamName,
  );

  await instance.waitUntil(
    async () => {
      const r = await instance.execute(function () {
        return (window as any).__TEAM_RESULT__;
      });
      return r && r !== "pending";
    },
    { timeout: 15_000, interval: 500, timeoutMsg: "createTeam timed out" },
  );

  return await instance.execute(function () {
    return (window as any).__TEAM_RESULT__ || "";
  });
}

/** Add a member to a team programmatically (bypasses UI) */
export async function addTeamMemberProgrammatic(
  instance: WebdriverIO.Browser,
  teamId: string,
  email: string,
  role: "admin" | "member" = "member",
): Promise<string> {
  const argsJson = JSON.stringify({ teamId, email, role });
  await instance.execute(
    function (args: any) {
      var fn = (window as any).__TEST_ADD_TEAM_MEMBER__;
      if (!fn) { (window as any).__TEAM_MEMBER_RESULT__ = "error:no_fn"; return; }
      (window as any).__TEAM_MEMBER_RESULT__ = "pending";
      fn(args)
        .then(function (r: any) { (window as any).__TEAM_MEMBER_RESULT__ = r; })
        .catch(function (e: any) { (window as any).__TEAM_MEMBER_RESULT__ = "error:" + e; });
    },
    argsJson,
  );

  await instance.waitUntil(
    async () => {
      const r = await instance.execute(function () {
        return (window as any).__TEAM_MEMBER_RESULT__;
      });
      return r && r !== "pending";
    },
    { timeout: 15_000, interval: 500, timeoutMsg: "addTeamMember timed out" },
  );

  return await instance.execute(function () {
    return (window as any).__TEAM_MEMBER_RESULT__ || "";
  });
}

/** Create a team document programmatically (bypasses UI) */
export async function createTeamDocProgrammatic(
  instance: WebdriverIO.Browser,
  teamId: string,
  title: string,
  content: string,
): Promise<string> {
  const argsJson = JSON.stringify({ teamId, title, content });
  await instance.execute(
    function (args: any) {
      var fn = (window as any).__TEST_CREATE_TEAM_DOC__;
      if (!fn) { (window as any).__TEAM_DOC_RESULT__ = "error:no_fn"; return; }
      (window as any).__TEAM_DOC_RESULT__ = "pending";
      fn(args)
        .then(function (r: any) { (window as any).__TEAM_DOC_RESULT__ = r; })
        .catch(function (e: any) { (window as any).__TEAM_DOC_RESULT__ = "error:" + e; });
    },
    argsJson,
  );

  await instance.waitUntil(
    async () => {
      const r = await instance.execute(function () {
        return (window as any).__TEAM_DOC_RESULT__;
      });
      return r && r !== "pending";
    },
    { timeout: 15_000, interval: 500, timeoutMsg: "createTeamDoc timed out" },
  );

  return await instance.execute(function () {
    return (window as any).__TEAM_DOC_RESULT__ || "";
  });
}

/** Add a member to a team in the team dialog (JS clicks for WebKitGTK) */
export async function addTeamMember(
  instance: WebdriverIO.Browser,
  memberEmail: string,
) {
  // Click "Add member" button via JS
  await instance.execute(function () {
    var btn = document.querySelector('button[title="Add member"]') as HTMLElement;
    if (btn) btn.click();
  });
  await instance.pause(300);

  // Input: placeholder="Email"
  const emailInput = await instance.$('input[placeholder="Email"]');
  await emailInput.waitForExist({ timeout: 3000 });
  await emailInput.setValue(memberEmail);

  // Click "Add" button via JS
  await instance.execute(function () {
    var btns = document.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      var txt = (btns[i].textContent || "").trim();
      if (txt === "Add") { btns[i].click(); return; }
    }
  });
  await instance.pause(2000);
}
