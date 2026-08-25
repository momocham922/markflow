import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, type Document } from "./app-store";

// Guards the in-memory (store-layer) half of the fail-closed account isolation.
// Even if the SQLite purge is skipped (getSetting/wipe throwing on iOS) or a
// cold-start loadDocuments re-injects the previous account's rows, the sidebar
// must never keep a PRIVATE doc owned by another account. dropForeignDocuments
// is the store-level guard; the Sidebar render filter uses the same predicate.

const B = "userB";

function doc(
  id: string,
  ownerId: string | null,
  extra: Partial<Document> = {},
): Document {
  return {
    id,
    title: `t-${id}`,
    content: "hello",
    createdAt: 1,
    updatedAt: 1,
    folder: "/",
    tags: [],
    ownerId,
    ...extra,
  };
}

describe("dropForeignDocuments (in-memory account isolation)", () => {
  beforeEach(() => {
    useAppStore.setState({ documents: [], activeDocId: null });
  });

  it("removes another account's PRIVATE docs, keeps own/unclaimed/shared/team", () => {
    useAppStore.setState({
      documents: [
        doc("own", B),
        doc("unclaimed", null),
        doc("foreign-private", "userA"),
        doc("foreign-shared", "userA", { isShared: true }),
        doc("foreign-team", "userA", { teamId: "team1" }),
      ],
    });
    useAppStore.getState().dropForeignDocuments(B);
    const ids = useAppStore
      .getState()
      .documents.map((d) => d.id)
      .sort();
    expect(ids).toEqual(["foreign-shared", "foreign-team", "own", "unclaimed"]);
  });

  it("clears activeDocId when the active doc was a foreign private doc", () => {
    useAppStore.setState({
      documents: [doc("own", B), doc("foreign-private", "userA")],
      activeDocId: "foreign-private",
    });
    useAppStore.getState().dropForeignDocuments(B);
    expect(useAppStore.getState().activeDocId).toBeNull();
  });

  it("keeps activeDocId when the active doc survives the purge", () => {
    useAppStore.setState({
      documents: [doc("own", B), doc("foreign-private", "userA")],
      activeDocId: "own",
    });
    useAppStore.getState().dropForeignDocuments(B);
    expect(useAppStore.getState().activeDocId).toBe("own");
  });

  it("is a no-op for an empty uid (never wipes the cache blindly)", () => {
    useAppStore.setState({ documents: [doc("foreign", "userA")] });
    useAppStore.getState().dropForeignDocuments("");
    expect(useAppStore.getState().documents.length).toBe(1);
  });
});
