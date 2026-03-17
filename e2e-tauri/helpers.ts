/**
 * Helpers for WebDriverIO + tauri-driver E2E tests.
 * Runs against the real Tauri app binary in a Linux container.
 */

/** Wait for the app to finish loading */
export async function waitForAppReady() {
  const loading = await $("*=Loading...");
  await loading.waitForDisplayed({ timeout: 20_000, reverse: true });
}

/** Create a new document via the "+" icon in sidebar */
export async function createNewDocument() {
  const plusIcons = await $$(".lucide-plus");
  if (plusIcons.length > 0) {
    await plusIcons[0].click();
  }
  const editor = await $(".cm-editor");
  await editor.waitForDisplayed({ timeout: 5_000 });
}

/** Type text into the CodeMirror editor */
export async function typeInEditor(text: string, clear = false) {
  const content = await $(".cm-editor .cm-content");
  await content.click();
  if (clear) {
    await browser.keys(["Meta", "a"]);
    await browser.keys(["Backspace"]);
  }
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length > 0) {
      for (const char of parts[i]) {
        await browser.keys([char]);
      }
    }
    if (i < parts.length - 1) {
      await browser.keys(["Enter"]);
    }
  }
}

/** Get the CodeMirror editor content */
export async function getEditorContent(): Promise<string> {
  const content = await $(".cm-editor .cm-content");
  return content.getText();
}

/** Switch preview mode */
export async function setPreviewMode(mode: "edit" | "split" | "preview" | "mindmap") {
  const titles: Record<string, string> = {
    edit: "Edit only",
    split: "Split view",
    preview: "Preview only",
    mindmap: "Mind Map",
  };
  const btn = await $(`button[title="${titles[mode]}"]`);
  await btn.click();
  await browser.pause(300);
}
