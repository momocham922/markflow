import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "./confirm";

describe("confirmDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Browser build: window.confirm is the native SYNCHRONOUS boolean.
  it("passes through a native synchronous true/false", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await confirmDialog("ok?")).toBe(true);

    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await confirmDialog("ok?")).toBe(false);
  });

  // Tauri build: tauri-plugin-dialog replaces window.confirm with an ASYNC
  // function returning a Promise. The whole point of confirmDialog is that the
  // caller `await`s it so Cancel (resolved false) is honored — a bare
  // `if (confirm(...))` would test the always-truthy Promise and act on Cancel.
  it("awaits the Promise from the Tauri async window.confirm (Cancel => false)", async () => {
    vi.spyOn(window, "confirm").mockResolvedValue(false);
    expect(await confirmDialog("delete?")).toBe(false);
    vi.spyOn(window, "confirm").mockResolvedValue(true);
    expect(await confirmDialog("delete?")).toBe(true);
  });

  // Regression guard for the data-loss bug: a thenable resolving to false must
  // NOT be treated as a confirmation.
  it("a Cancel result is falsy after await (not a truthy Promise)", async () => {
    vi.spyOn(window, "confirm").mockResolvedValue(false);
    const result = await confirmDialog("delete the document?");
    expect(result).toBeFalsy();
    expect(typeof result).toBe("boolean");
  });
});
