import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertDocument,
  getAllDocuments,
  purgeForeignDocuments,
  clearAllLocalDocuments,
} from "./database";

// Guards the fail-closed account-switch isolation (iOS build 196 regression):
// SQLite is a single per-device cache with NO per-user scoping. When a DIFFERENT
// account signs in, the previous user's PRIVATE docs must be removed from the
// cache even if the LAST_UID switch-purge was skipped (getSetting/wipe throwing)
// or an in-flight sync revived a row. purgeForeignDocuments is that independent,
// unconditional guard: it removes only docs owned by ANOTHER account that are not
// shared/team, and preserves own / unclaimed / shared docs.

const B = "userB";

async function seed(
  id: string,
  ownerId: string | null,
  isShared = false,
): Promise<void> {
  await upsertDocument({
    id,
    title: `t-${id}`,
    content: "hello",
    createdAt: 1,
    updatedAt: 1,
    ownerId,
    isShared,
  });
}

describe("purgeForeignDocuments (fail-closed account isolation)", () => {
  beforeEach(async () => {
    await clearAllLocalDocuments();
  });

  it("removes another account's PRIVATE docs, keeps own/unclaimed/shared", async () => {
    await seed("own", B); // own private
    await seed("unclaimed", null); // created offline before login
    await seed("foreign-private", "userA"); // LEAK — must be removed
    await seed("foreign-shared", "userA", true); // shared-with-me / team — keep

    const removed = await purgeForeignDocuments(B);
    expect(removed).toBe(1);

    const ids = (await getAllDocuments()).map((d) => d.id).sort();
    expect(ids).toEqual(["foreign-shared", "own", "unclaimed"]);
  });

  it("is a no-op (returns 0) when the cache holds only this account's docs", async () => {
    await seed("own1", B);
    await seed("own2", B);
    await seed("unclaimed", null);
    expect(await purgeForeignDocuments(B)).toBe(0);
    expect((await getAllDocuments()).length).toBe(3);
  });

  it("removes MULTIPLE foreign accounts' private docs at once", async () => {
    await seed("a1", "userA");
    await seed("c1", "userC");
    await seed("own", B);
    expect(await purgeForeignDocuments(B)).toBe(2);
    expect((await getAllDocuments()).map((d) => d.id)).toEqual(["own"]);
  });

  it("never deletes the whole cache via a mis-parsed compound WHERE", async () => {
    // Regression: the in-memory adapter only models `WHERE col = $N`. A compound
    // `owner_id != $1 AND is_shared = 0` predicate would match nothing and return
    // every row — deleting the entire cache. purgeForeignDocuments filters in JS,
    // so a cache of only-own docs must survive intact.
    await seed("own1", B);
    await seed("own2", B);
    await purgeForeignDocuments(B);
    expect((await getAllDocuments()).length).toBe(2);
  });

  it("returns 0 for an empty uid without touching the cache", async () => {
    await seed("foreign", "userA");
    expect(await purgeForeignDocuments("")).toBe(0);
    expect((await getAllDocuments()).length).toBe(1);
  });
});
