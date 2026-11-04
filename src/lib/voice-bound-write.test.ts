import { describe, it, expect } from "vitest";
import { resolveBoundWrite } from "./voice-bound-write";

const plain = { isShared: false };
const shared = { isShared: true };

describe("resolveBoundWrite", () => {
  it("writes through the editor when the bound document is the open one", () => {
    expect(
      resolveBoundWrite({
        boundDocId: "rec",
        renderedActiveDocId: "rec",
        currentActiveDocId: "rec",
        boundDoc: plain,
      }),
    ).toBe("active");
  });

  // Regression: 2026-11-02 Windows beta.11 — recording continued on "rec"
  // while another document was open, and a structuring pass replaced the open
  // document's body. The output must go to the recording's document instead.
  it("writes the recording's document (not the open one) after navigating away", () => {
    expect(
      resolveBoundWrite({
        boundDocId: "rec",
        renderedActiveDocId: "other",
        currentActiveDocId: "other",
        boundDoc: plain,
      }),
    ).toBe("store");
  });

  it("does not trust a stale render when the user switched since", () => {
    expect(
      resolveBoundWrite({
        boundDocId: "rec",
        renderedActiveDocId: "rec",
        currentActiveDocId: "other",
        boundDoc: plain,
      }),
    ).toBe("store");
  });

  it("defers a shared document that is not open (its content lives in the Y.Doc)", () => {
    expect(
      resolveBoundWrite({
        boundDocId: "rec",
        renderedActiveDocId: "other",
        currentActiveDocId: "other",
        boundDoc: shared,
      }),
    ).toBe("defer");
  });

  it("writes a shared document through the editor while it is open", () => {
    expect(
      resolveBoundWrite({
        boundDocId: "rec",
        renderedActiveDocId: "rec",
        currentActiveDocId: "rec",
        boundDoc: shared,
      }),
    ).toBe("active");
  });

  it("defers when the bound document is unknown", () => {
    expect(
      resolveBoundWrite({
        boundDocId: null,
        renderedActiveDocId: "x",
        currentActiveDocId: "x",
        boundDoc: undefined,
      }),
    ).toBe("defer");
    expect(
      resolveBoundWrite({
        boundDocId: "gone",
        renderedActiveDocId: "x",
        currentActiveDocId: "x",
        boundDoc: undefined,
      }),
    ).toBe("defer");
  });
});
