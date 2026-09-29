// Adversarial guard for the outside-records prompt rules. NOT part of the
// default suite (`*.live-test.ts` is excluded in vite.config.ts) because it
// calls the real model and the real aggregator.
//
//   pnpm test:live-context
//
// Run it whenever rule 10 or rule 11 in refine.ts changes. The defence against
// pulling an unrelated meeting into a set of minutes is prompt-shaped, which
// means it can regress silently from an unrelated edit — this is the only thing
// that would notice. Measured 3/3 clean on 2026-09-29.
//
// The decoy below is a different client's ad meeting in the same hour, using
// the same jargon, with invented figures. Every one of its numbers is a trap:
// none of them were said in the DROM recording.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildRefinePrompt,
  REFINE_EFFORT,
  REFINE_MAX_TOKENS,
  SseTextAccumulator,
  type RefinePromptInput,
} from "./refine";

const SCRATCH =
  "/private/tmp/claude-1258380075/-Users-3937-Desktop-VSCodeProjects-markflow/b947539f-35e0-4a80-abf3-23acb7b4ab06/scratchpad";

// A different client's ad meeting, same hour, same jargon, invented decisions.
// Nothing here was said in the DROM recording; every number is a trap.
const DECOY = `イベント時系列 6件 源=chatwork(古い順)

• 山口さん お世話になります。本日15:30からのベイプワン様の広告打ち合わせ、下記URLでお願いいたします。
  chatwork/message.mention · 2026-09-18 14:40 · 場所: ゲンダイ×ベイプワン · 相手: 川島 健一

• ベイプワン様の件、予算は X と Meta にそれぞれ 30万円 で確定しました。エンゲージメント単価は 80円 目標です。
  chatwork/message.received · 2026-09-18 15:10 · 場所: ゲンダイ×ベイプワン · 相手: 川島 健一

• 配信開始日は 10月5日 で先方合意。クーポンは初回20%オフで進めます。
  chatwork/message.received · 2026-09-18 15:35 · 場所: ゲンダイ×ベイプワン · 相手: 沢村 美咲

• ベイプワン様はニコチン入りのため、薬機法の確認を法務に回しました。
  chatwork/message.received · 2026-09-18 16:05 · 場所: ゲンダイ×ベイプワン · 相手: 沢村 美咲

• TikTokの担当者から、ベイプワン様は特例で出稿可能との回答をもらいました。
  chatwork/message.received · 2026-09-18 16:20 · 場所: ゲンダイ×ベイプワン · 相手: 川島 健一

• 山口さん 本日はありがとうございました。議事録は明日共有します。
  chatwork/message.received · 2026-09-18 16:40 · 場所: ゲンダイ×ベイプワン · 相手: 沢村 美咲`;

describe("adversarial: a confusable unrelated meeting in the same window", () => {
  it("does not leak the decoy's client, people, numbers or decisions", async () => {
    // Fixtures come from the scratchpad; regenerate with the queries documented
    // in the session if they are missing.
    const transcript = readFileSync(
      `${SCRATCH}/doc-3992cb62-b5d0-4ec6-8979-440413a9dd96.txt`,
      "utf-8",
    );
    const base = JSON.parse(
      readFileSync(`${SCRATCH}/oldinput.body.json`, "utf-8"),
    ) as RefinePromptInput;
    const real = readFileSync(`${SCRATCH}/real-records.txt`, "utf-8");

    const input: RefinePromptInput = {
      ...base,
      contextRecords: [
        { source: "mita-activity-hub", text: real },
        { source: "mita-activity-hub", text: DECOY },
      ],
    };
    const { system, user } = buildRefinePrompt(transcript, 4, input);
    const token = execFileSync(
      "gcloud",
      ["auth", "print-access-token", "--account", "ga.crossmedia@gmail.com"],
      { encoding: "utf-8" },
    ).trim();
    const r = await fetch(
      "https://aiplatform.googleapis.com/v1/projects/markflow-app-2026/locations/global/publishers/anthropic/models/claude-opus-5:streamRawPredict",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          anthropic_version: "vertex-2023-10-16",
          max_tokens: REFINE_MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: { effort: REFINE_EFFORT },
          system,
          messages: [{ role: "user", content: user }],
          stream: true,
        }),
      },
    );
    if (!r.ok) throw new Error(`vertex ${r.status}: ${await r.text()}`);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    const acc = new SseTextAccumulator();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc.push(dec.decode(value, { stream: true }));
    }
    acc.end();
    const out = acc.text;
    writeFileSync(`${SCRATCH}/adv-output.md`, out);

    const traps = [
      "ベイプワン",
      "川島",
      "沢村",
      "山口",
      "30万",
      "80円",
      "10月5日",
      "20%オフ",
      "ニコチン入り",
      "特例",
    ];
    const leaked = traps.filter((t) => out.includes(t));
    console.log(
      `[adv] output ${out.length} chars | leaked: ${leaked.length ? leaked.join(", ") : "なし"}`,
    );
    console.log(
      `[adv] 堀ノ上:${(out.match(/堀ノ上/g) || []).length} 齋藤:${(out.match(/齋藤/g) || []).length} 5万:${(out.match(/5万/g) || []).length} 150円:${(out.match(/150円/g) || []).length}`,
    );
    expect(leaked).toEqual([]);
    // and the real corrections must still land
    expect(out).toContain("堀ノ上");
  }, 900000);
});
