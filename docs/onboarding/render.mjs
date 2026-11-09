// manual.html → manual.pdf（A4）。ページごとの PNG も書き出して目視に使う。
// 使い方: node docs/onboarding/render.mjs   （リポジトリ直下で。@playwright/test を使う）
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch();
const p = await b.newPage();
await p.goto("file://" + path.join(here, "manual.html"));
await p.waitForLoadState("networkidle");
await p.evaluate(() => document.fonts.ready);
// はみ出しの検査: 各ページの本文が紙の中に収まっているか
const over = await p.evaluate(() => [...document.querySelectorAll(".page")].map((pg, i) => {
  const r = pg.getBoundingClientRect(); const body = pg.querySelector(".body");
  const last = [...body.querySelectorAll("*")].filter(e => !e.closest("svg") || e.tagName === "svg").reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), 0);
  return { page: i + 1, bodyBottom: Math.round(last - r.top), pageH: Math.round(r.height) };
}));
console.log(JSON.stringify(over));
await p.pdf({ path: path.join(here, "MarkFlow_取扱説明書_Android_Windows.pdf"), format: "A4", printBackground: true, preferCSSPageSize: true });
await b.close();
