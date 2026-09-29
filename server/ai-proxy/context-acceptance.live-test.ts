import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildRefinePrompt, REFINE_EFFORT, REFINE_MAX_TOKENS, SseTextAccumulator,
  type RefinePromptInput,
} from "./refine";

const SC = "/private/tmp/claude-1258380075/-Users-3937-Desktop-VSCodeProjects-markflow/b947539f-35e0-4a80-abf3-23acb7b4ab06/scratchpad";

describe("live: topic pass brings prior context without importing derived docs", () => {
  it("uses correspondence, ignores MarkFlow's own earlier output", async () => {
    const transcript = readFileSync(`${SC}/doc-3992cb62-b5d0-4ec6-8979-440413a9dd96.txt`, "utf-8");
    const base = JSON.parse(readFileSync(`${SC}/oldinput.body.json`, "utf-8")) as RefinePromptInput;
    const windowText = readFileSync(`${SC}/real-records.txt`, "utf-8");
    const topics = JSON.parse(readFileSync(`${SC}/topic-records.json`, "utf-8")) as Array<{term:string;text:string}>;

    const input: RefinePromptInput = {
      ...base,
      contextRecords: [
        { source: "mita-activity-hub", text: windowText },
        ...topics.map((t) => ({ source: `mita-activity-hub（「${t.term}」で検索）`, text: t.text })),
      ],
    };
    const { system, user } = buildRefinePrompt(transcript, 4, input);
    console.log(`[acc] prompt user ${user.length} chars`);

    const token = execFileSync("gcloud", ["auth","print-access-token","--account","ga.crossmedia@gmail.com"], { encoding: "utf-8" }).trim();
    const r = await fetch("https://aiplatform.googleapis.com/v1/projects/markflow-app-2026/locations/global/publishers/anthropic/models/claude-opus-5:streamRawPredict", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ anthropic_version: "vertex-2023-10-16", max_tokens: REFINE_MAX_TOKENS, thinking: { type: "adaptive" }, output_config: { effort: REFINE_EFFORT }, system, messages: [{ role: "user", content: user }], stream: true }),
    });
    if (!r.ok) throw new Error(`vertex ${r.status}: ${await r.text()}`);
    const reader = r.body!.getReader(); const dec = new TextDecoder(); const acc = new SseTextAccumulator();
    for (;;) { const { done, value } = await reader.read(); if (done) break; acc.push(dec.decode(value, { stream: true })); }
    acc.end();
    const out = acc.text;
    writeFileSync(`${SC}/acc-output.md`, out);

    // These phrases exist ONLY in the verified document I wrote afterwards —
    // never in the recording, never in the correspondence. If they appear, a
    // derived artefact was treated as evidence (rule 11 failed).
    const derivedOnly = ["21歳", "Pre-Authorization", "景品表示法", "ノンニコチン", "薬機法", "CASA"];
    const leaked = derivedOnly.filter((t) => out.includes(t));
    console.log(`[acc] ${out.length} chars | derived leak: ${leaked.length ? leaked.join(", ") : "なし"}`);
    console.log(`[acc] 堀ノ上:${(out.match(/堀ノ上/g)||[]).length} 堀江:${(out.match(/堀江/g)||[]).length}`);
    const h2 = out.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
    console.log(`[acc] H2: ${h2.join(" / ")}`);
    expect(leaked).toEqual([]);
    expect(out).toContain("堀ノ上");
  }, 900000);
});
