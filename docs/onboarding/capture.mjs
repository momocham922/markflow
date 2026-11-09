import { chromium } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
// 使い方（リポジトリ直下で・pnpm dev を 1420 番で起動した状態）:
//   cp docs/onboarding/capture.mjs ./.cap-tmp.mjs && node ./.cap-tmp.mjs "$PWD/docs/onboarding/img"; rm ./.cap-tmp.mjs
// （@playwright/test をリポジトリの node_modules から解決するため直下で実行する）
// ログイン完了の画面は src-tauri/src/lib.rs の HTML をそのまま描く（一時フォルダに書き出す）。
const OAUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mf-oauth-"));
{
  const rs = fs.readFileSync(path.join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
  const android = rs.match(/const OAUTH_ANDROID_RETURN_HTML: &str = r#"([\s\S]*?)"#;/)[1]
    .replace('window.location.href="markflow://oauth"', "void 0");
  const desktop = rs.match(/let html = r#"(<!DOCTYPE html><html><head><style>[\s\S]*?)"#;/)[1];
  fs.writeFileSync(path.join(OAUTH_DIR, "oauth-android.html"), android);
  fs.writeFileSync(path.join(OAUTH_DIR, "oauth-desktop.html"), desktop);
}
const out = process.argv[2]; const boxes = {}; const TITLE = "# 11/7 定例ミーティング\n";
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"] });
const bb = async (key, loc) => { boxes[key] = await loc.boundingBox(); };
async function setup(opts){ const ctx = await b.newContext({ ...opts, permissions: ["microphone"], locale: "ja-JP", colorScheme: "light" }); const p = await ctx.newPage(); await p.goto("http://localhost:1420/"); await p.waitForSelector("text=Loading...", { state: "detached", timeout: 20000 }).catch(()=>{}); await p.waitForTimeout(1500); return [ctx,p]; }
const plus = (p)=>p.locator('button:has-text("My Documents")').locator('..').locator('.lucide-plus').first();
{ const [ctx,p] = await setup({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await bb("pc.signin",p.locator('button[title="Sign in with Google"]')); await bb("pc.ok",p.getByRole("button",{name:"OK",exact:true}));
  await p.screenshot({ path: `${out}/pc-home.png` });
  await p.getByRole("button",{name:"OK",exact:true}).click(); await bb("pc.plus",plus(p));
  await plus(p).click(); await p.waitForTimeout(1000);
  await p.locator(".cm-editor .cm-content").click(); await p.keyboard.press("Meta+a"); await p.keyboard.type(TITLE); await p.waitForTimeout(800);
  await bb("pc.voice",p.locator('button[title="Voice input"]')); await bb("pc.share",p.locator('button[title="Share"]'));
  await p.screenshot({ path: `${out}/pc-editor.png` });
  await p.locator('button[title="Voice input"]').click(); await p.waitForTimeout(800);
  const pcSel = p.locator("select").filter({ has: p.locator('option[value="300"]') }).first();
  await pcSel.selectOption("300"); await p.waitForTimeout(300); await bb("pc.interval", pcSel);
  await bb("pc.record",p.getByRole("button",{name:"Record"})); await bb("pc.structure",p.locator('button[title="Structure"]'));
  await p.screenshot({ path: `${out}/pc-voice.png` });
  await p.getByRole("button",{name:"Record"}).click(); await p.waitForTimeout(3500);
  await bb("pc.stop",p.locator('button:not([title])', { hasText: "Stop" }).first());
  await bb("pc.recstructure",p.locator('button[title="Structure"]'));
  await bb("pc.countdown",p.locator("span.font-mono", { hasText: /^\d+s$/ }).first());
  await p.screenshot({ path: `${out}/pc-recording.png` }); await ctx.close(); }
{ const [ctx,p] = await setup({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36" });
  boxes["sp.cw"] = await p.evaluate(()=>document.documentElement.clientWidth);
  await bb("sp.signin",p.locator('button[title="Sign in with Google"]')); await bb("sp.ok",p.getByRole("button",{name:"OK",exact:true}));
  await p.screenshot({ path: `${out}/sp-home.png` });
  await p.getByRole("button",{name:"OK",exact:true}).click(); await p.waitForTimeout(400);
  await bb("sp.menu",p.locator("button").first()); await p.locator("button").first().click(); await p.waitForTimeout(600);
  await bb("sp.plus",plus(p)); await p.screenshot({ path: `${out}/sp-sidebar.png` });
  await plus(p).click(); await p.waitForTimeout(1000);
  await p.locator(".cm-editor .cm-content").click(); await p.keyboard.press("Meta+a"); await p.keyboard.type(TITLE); await p.waitForTimeout(500);
  await p.evaluate(()=>document.activeElement && document.activeElement.blur());
  await bb("sp.voice",p.locator('button[title="Voice input"]')); await bb("sp.share",p.locator('button[title="Share"]'));
  await p.screenshot({ path: `${out}/sp-editor.png` });
  await p.locator('button[title="Voice input"]').click(); await p.waitForTimeout(800);
  const spSel = p.locator("select").filter({ has: p.locator('option[value="300"]') }).first();
  await spSel.selectOption("300"); await p.waitForTimeout(300); await bb("sp.interval", spSel);
  await bb("sp.record",p.getByRole("button",{name:"Record"}));
  await p.screenshot({ path: `${out}/sp-voice.png` }); await ctx.close(); }
{ const ctx = await b.newContext({ viewport:{width:390,height:844}, deviceScaleFactor:3, isMobile:true }); const p = await ctx.newPage();
  await p.goto("file://"+OAUTH_DIR+"/oauth-android.html"); await p.waitForTimeout(300); await bb("sp.return",p.locator("a.btn"));
  await p.screenshot({ path: `${out}/sp-oauth.png` }); await ctx.close(); }
{ const ctx = await b.newContext({ viewport:{width:1000,height:560}, deviceScaleFactor:2 }); const p = await ctx.newPage();
  await p.goto("file://"+OAUTH_DIR+"/oauth-desktop.html"); await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/pc-oauth.png` }); await ctx.close(); }
fs.writeFileSync(`${out}/boxes.json`, JSON.stringify(boxes,null,1)); await b.close();
