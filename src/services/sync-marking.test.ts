import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertDocument,
  getDocument,
  markDocumentsSynced,
  clearAllLocalDocuments,
} from "./database";

// Guards the P0 data-loss fix: the deletion-reconciliation only deletes an own
// doc when it was PREVIOUSLY synced (synced_at set). This exercises the column
// migration + the in-memory UPDATE handler that make synced_at observable.

beforeEach(async () => {
  await clearAllLocalDocuments();
});

async function seed(id: string) {
  await upsertDocument({
    id,
    title: `t-${id}`,
    content: "hello",
    createdAt: 1,
    updatedAt: 1,
    ownerId: "userA",
  });
}

describe("synced_at marking", () => {
  it("a freshly-created doc starts with synced_at null (never uploaded)", async () => {
    await seed("doc-1");
    const doc = await getDocument("doc-1");
    expect(doc).not.toBeNull();
    // null OR undefined — both mean "never synced"; the reconciliation treats
    // falsy synced_at as unsynced and keeps the doc.
    expect(doc!.synced_at ?? null).toBeNull();
  });

  it("markDocumentsSynced stamps synced_at so the doc is no longer 'never synced'", async () => {
    await seed("doc-1");
    await seed("doc-2");
    await markDocumentsSynced(["doc-1"]);

    const d1 = await getDocument("doc-1");
    const d2 = await getDocument("doc-2");
    expect(typeof d1!.synced_at).toBe("number");
    expect(d1!.synced_at).toBeGreaterThan(0);
    // Only the marked doc is affected.
    expect(d2!.synced_at ?? null).toBeNull();
  });

  it("re-writing a doc after sync does not itself clear synced_at", async () => {
    // NOTE: upsertDocument sets is_dirty=1 but does NOT touch synced_at, so a
    // local edit after a successful sync keeps the doc's synced history intact —
    // the reconciliation still treats a later remote deletion as authoritative.
    await seed("doc-1");
    await markDocumentsSynced(["doc-1"]);
    const before = (await getDocument("doc-1"))!.synced_at;
    await upsertDocument({
      id: "doc-1",
      title: "t-doc-1",
      content: "edited",
      createdAt: 1,
      updatedAt: 2,
      ownerId: "userA",
    });
    const after = (await getDocument("doc-1"))!.synced_at;
    expect(after).toBe(before);
  });

  it("markDocumentsSynced with an empty list is a no-op and never throws", async () => {
    await expect(markDocumentsSynced([])).resolves.toBeUndefined();
  });
});
