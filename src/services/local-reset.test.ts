import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertDocument,
  getAllDocuments,
  createVersion,
  getVersions,
  trackDeletedDoc,
  getDeletedDocIds,
  setSetting,
  getSetting,
  clearAllLocalDocuments,
} from "./database";
import { wipeLocalUserData } from "./local-reset";

// These run against the in-memory database adapter (isTauri === false in jsdom),
// exercising the same code path the web build uses. The point under test is the
// account-switch data-isolation guarantee: after a purge, NO previous-account
// document, version, snapshot, or delete-tombstone remains locally.

async function seedDoc(id: string, ownerId: string) {
  // Two writes so the second leaves a write-ahead snapshot of the first.
  await upsertDocument({
    id,
    title: `t-${id}`,
    content: "v1",
    createdAt: 1,
    updatedAt: 1,
    ownerId,
  });
  await upsertDocument({
    id,
    title: `t-${id}`,
    content: "v2",
    createdAt: 1,
    updatedAt: 2,
    ownerId,
  });
  await createVersion({
    id: `ver-${id}`,
    documentId: id,
    content: "v1",
    title: `t-${id}`,
    message: null,
  });
}

beforeEach(async () => {
  // Reset any state left by a prior test (the adapter is a module singleton).
  await clearAllLocalDocuments();
});

describe("clearAllLocalDocuments", () => {
  // NOTE: write-ahead snapshots (document_snapshots_v2) are exercised only by the
  // real SQLite adapter. The in-memory adapter used in jsdom cannot preserve them
  // because its equality-WHERE emulation over-matches the prune DELETE's leading
  // `document_id = $1` clause and drops every snapshot for the doc — a pre-existing
  // adapter limitation, unrelated to the wipe. clearAllLocalDocuments issues a
  // `DELETE FROM document_snapshots_v2` regardless, so the table is cleared either
  // way; the assertions below cover the artifacts the memory adapter models faithfully.
  it("removes every document, version, and delete-tombstone", async () => {
    await seedDoc("doc-a", "userA");
    await seedDoc("doc-b", "userA");
    await trackDeletedDoc("doc-gone");

    expect((await getAllDocuments()).length).toBe(2);
    expect((await getVersions("doc-a")).length).toBe(1);
    expect((await getDeletedDocIds()).size).toBe(1);

    await clearAllLocalDocuments();

    expect(await getAllDocuments()).toEqual([]);
    expect(await getVersions("doc-a")).toEqual([]);
    expect((await getDeletedDocIds()).size).toBe(0);
  });

  it("resets per-user bookkeeping settings but keeps device prefs", async () => {
    await setSetting("lastSyncAt", "12345");
    await setSetting("folders", JSON.stringify(["/work"]));
    await setSetting("theme", "dark");

    await clearAllLocalDocuments();

    expect(await getSetting("lastSyncAt")).toBeNull();
    expect(await getSetting("folders")).toBeNull();
    // Device-level pref must survive — it is not user-scoped content.
    expect(await getSetting("theme")).toBe("dark");
  });
});

describe("account switch isolation", () => {
  it("leaves no trace of account A after wiping for account B", async () => {
    // Account A works locally.
    await seedDoc("a-private", "userA");
    await setSetting("lastSyncAt", "999");
    expect((await getAllDocuments()).map((d) => d.id)).toContain("a-private");

    // Account B signs in on the same device → purge.
    await wipeLocalUserData();

    // Account B must see NOTHING of account A.
    expect(await getAllDocuments()).toEqual([]);
    expect(await getSetting("lastSyncAt")).toBeNull();

    // Account B creates its own doc; it is the only one present.
    await seedDoc("b-private", "userB");
    const docs = await getAllDocuments();
    expect(docs.map((d) => d.id)).toEqual(["b-private"]);
  });

  it("wipeLocalUserData never throws when IndexedDB enumeration is unavailable", async () => {
    // jsdom has no indexedDB.databases(); the wipe must degrade gracefully.
    await expect(wipeLocalUserData()).resolves.toBeUndefined();
  });

  it("clears user/session-scoped localStorage but keeps device theme", async () => {
    // Canvas embeds sticky-note TEXT (user content) — must not survive a switch.
    localStorage.setItem(
      "markflow-canvas-state",
      JSON.stringify({ stickyNotes: [{ text: "secret note" }] }),
    );
    localStorage.setItem("markflow:research:includeInStructure", "true");
    localStorage.setItem("markflow_view_as", "pro");
    localStorage.setItem("markflow_pending_checkout", "team");
    // Device-level UI preference — must survive the account switch.
    localStorage.setItem("markflow:themeSettings", '{"accent":"blue"}');

    await wipeLocalUserData();

    expect(localStorage.getItem("markflow-canvas-state")).toBeNull();
    expect(
      localStorage.getItem("markflow:research:includeInStructure"),
    ).toBeNull();
    expect(localStorage.getItem("markflow_view_as")).toBeNull();
    expect(localStorage.getItem("markflow_pending_checkout")).toBeNull();
    // Not user content — kept so the device's look doesn't reset per login.
    expect(localStorage.getItem("markflow:themeSettings")).toBe(
      '{"accent":"blue"}',
    );
  });
});
