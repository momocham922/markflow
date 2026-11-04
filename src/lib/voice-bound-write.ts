/**
 * Where live Structure output from the voice panel goes.
 *
 * A recording is bound to the document it started in, and keeps running while
 * the user opens other documents. Its output must land in that bound document,
 * never in the one currently in view:
 * - "active": the bound document is the open one — write through the editor
 *   (store + collaboration).
 * - "store": the bound document is not open and not shared — the store is its
 *   source of truth and the editor renders it from there on return.
 * - "defer": the bound document is not open and is shared — its content lives
 *   in its Y.Doc, which is only attached while it is open, so it can't be
 *   written now; the caller structures that part again later.
 */
export type BoundWriteTarget = "active" | "store" | "defer";

export function resolveBoundWrite(input: {
  boundDocId: string | null;
  /** The open document as of the render that built the writer. */
  renderedActiveDocId: string | null;
  /** The open document right now (store state at call time). */
  currentActiveDocId: string | null;
  boundDoc: { isShared?: boolean } | undefined;
}): BoundWriteTarget {
  const { boundDocId, renderedActiveDocId, currentActiveDocId, boundDoc } =
    input;
  if (!boundDocId || !boundDoc) return "defer";
  if (boundDocId === renderedActiveDocId && boundDocId === currentActiveDocId) {
    return "active";
  }
  return boundDoc.isShared ? "defer" : "store";
}
