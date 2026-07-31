import http from "http";
import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const PORT = parseInt(process.env.PORT || "8080", 10);
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "markflow-app-2026";
// Claude (Anthropic) Vertex region. Opus 4.7+ are served from the global
// endpoint, not us-east5 regional. GCP_REGION is used ONLY for the Claude
// endpoint below (Gemini/image/STT have their own locations).
const GCP_REGION = process.env.GCP_REGION || "global";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const NANOBANANA_MODEL =
  process.env.NANOBANANA_MODEL || "gemini-3.1-flash-image-preview";
const STT_LOCATION = process.env.STT_LOCATION || "asia-northeast1";
const STT_MODEL = process.env.STT_MODEL || "chirp_3";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GCS_BUCKET =
  process.env.GCS_BUCKET || "markflow-app-2026.firebasestorage.app";

// Initialize Firebase Admin (uses default service account on Cloud Run)
initializeApp();

function getVertexAiUrl(): string {
  // The global endpoint host has no region prefix.
  const host =
    GCP_REGION === "global"
      ? "aiplatform.googleapis.com"
      : `${GCP_REGION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/anthropic/models/${CLAUDE_MODEL}:streamRawPredict`;
}

function getNanoBananaUrl(): string {
  return `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/global/publishers/google/models/${NANOBANANA_MODEL}:generateContent`;
}

function getGeminiUrl(model: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/global/publishers/google/models/${model}:generateContent`;
}

function classifyCredibility(
  domain: string,
): "academic" | "official" | "news" | "general" {
  const d = domain.toLowerCase();
  if (
    [".edu", ".ac.jp", ".ac.uk"].some((s) => d.endsWith(s)) ||
    [
      "scholar.google",
      "arxiv.org",
      "pubmed",
      "researchgate.net",
      "doi.org",
    ].some((s) => d.includes(s))
  )
    return "academic";
  if (
    [".go.jp", ".gov", ".gov.uk"].some((s) => d.endsWith(s)) ||
    ["who.int", "un.org", "europa.eu"].some((s) => d.includes(s))
  )
    return "official";
  if (
    [
      "nikkei.com",
      "reuters.com",
      "bloomberg.com",
      "nhk.or.jp",
      "bbc.com",
      "nytimes.com",
      "wsj.com",
      "ft.com",
      "techcrunch.com",
      "theverge.com",
    ].some((s) => d.includes(s))
  )
    return "news";
  return "general";
}

async function getGcpAccessToken(): Promise<string> {
  const metadataUrl =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const res = await fetch(metadataUrl, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok)
    throw new Error("Failed to get access token from metadata server");
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function verifyFirebaseToken(
  authHeader: string | undefined,
): Promise<string> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const idToken = authHeader.slice(7);
  const decoded = await getAuth().verifyIdToken(idToken);
  return decoded.uid;
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("MarkFlow AI Proxy");
    return;
  }

  // --- Public: serve a published document (NO auth) ---
  // markflow.jp/p/{docId} → nginx (markflow-site) reverse-proxies here. We read
  // published/{docId}.html from the (private) Storage bucket with the proxy's
  // service account and serve it as HTML. Published docs are public by design.
  if (req.method === "GET" && req.url && req.url.startsWith("/p/")) {
    try {
      const docId = decodeURIComponent(req.url.slice(3).split(/[?#]/)[0]);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(docId)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid document id");
        return;
      }
      const objectPath = `published/${docId}.html`;
      const token = await getGcpAccessToken();
      const objUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(
        objectPath,
      )}?alt=media`;
      const r = await fetch(objUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:-apple-system,sans-serif;padding:3rem;text-align:center;color:#555"><h1 style="font-size:1.2rem">このドキュメントは公開されていません</h1><p>リンクが失効したか、公開が停止された可能性があります。</p></body>',
        );
        return;
      }
      const html = await r.text();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
      res.end(html);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[publish] serve /p error: ${msg}`);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
      return;
    }
  }

  if (req.method !== "POST") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Read request body (shared by all POST routes)
  const readBody = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => (data += chunk.toString()));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  // --- /v1/voice/transcribe ---
  if (req.url === "/v1/voice/transcribe") {
    try {
      await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = JSON.parse(body);
      const audio: string = parsed.audio; // base64-encoded audio
      const language: string = parsed.language || "ja-JP";

      if (!audio) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "audio is required" }));
        return;
      }

      const accessToken = await getGcpAccessToken();
      const sttUrl = `https://${STT_LOCATION}-speech.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${STT_LOCATION}/recognizers/_:recognize`;

      // Support explicit encoding (LINEAR16 from Rust) or auto-detect (webm/opus from browser)
      const encoding: string | undefined = parsed.encoding;
      const sampleRate: number | undefined = parsed.sampleRate;
      const channels: number | undefined = parsed.channels;

      const hints: string[] | undefined = parsed.hints;
      const hasHints = hints && hints.length > 0;

      // chirp_3: diarization + adaptation は併用不可（404エラー）
      // hints有り → adaptation優先（ドキュメント固有語彙で精度向上）
      // hints無し → diarization有効（話者境界検出）
      const enableDiarization = parsed.diarization !== false && !hasHints;

      const sttConfig: Record<string, unknown> = {
        model: STT_MODEL,
        languageCodes: [language],
        features: {
          enableAutomaticPunctuation: true,
          ...(enableDiarization && {
            diarizationConfig: {
              minSpeakerCount: parsed.minSpeakers || 1,
              maxSpeakerCount: parsed.maxSpeakers || 6,
            },
          }),
        },
        denoiserConfig: {
          denoiseAudio: true,
        },
      };

      if (hasHints) {
        sttConfig.adaptation = {
          phraseSets: [
            {
              inlinePhraseSet: {
                phrases: hints
                  .slice(0, 100)
                  .map((h: string) => ({ value: h, boost: 3 })),
              },
            },
          ],
        };
      }

      if (encoding) {
        sttConfig.explicitDecodingConfig = {
          encoding,
          sampleRateHertz: sampleRate || 48000,
          audioChannelCount: channels || 1,
        };
      } else {
        sttConfig.autoDecodingConfig = {};
      }

      const sttRes = await fetch(sttUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          config: sttConfig,
          content: audio,
        }),
      });

      if (!sttRes.ok) {
        const errText = await sttRes.text();
        const audioBytes = Math.round((audio.length * 3) / 4);
        console.error(
          `[voice] STT error: ${sttRes.status} | encoding=${encoding} rate=${sampleRate} audioBytes=${audioBytes} | ${errText}`,
        );
        res.writeHead(sttRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sttData = (await sttRes.json()) as any;
      const transcript =
        sttData.results
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ?.map((r: any) => r.alternatives?.[0]?.transcript || "")
          .join("") || "";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const words: Array<{ word: string; speakerLabel: string }> = (
        sttData.results || []
      ).flatMap(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r.alternatives?.[0]?.words || [],
      );

      let taggedText = transcript;
      const speakerLabels = new Set(
        words.map((w) => w.speakerLabel).filter(Boolean),
      );
      if (speakerLabels.size > 1) {
        let currentSpeaker = "";
        const parts: string[] = [];
        for (const w of words) {
          const label = w.speakerLabel || "";
          if (label && label !== currentSpeaker) {
            currentSpeaker = label;
            parts.push(`\n[Speaker ${label}] `);
          }
          parts.push(w.word);
        }
        taggedText = parts.join("").trim();
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text: transcript,
          taggedText: speakerLabels.size > 1 ? taggedText : undefined,
          speakerCount: speakerLabels.size,
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // --- /v1/voice/batch-transcribe ---
  if (req.url === "/v1/voice/batch-transcribe") {
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = JSON.parse(body);
      const language: string = parsed.language || "ja-JP";
      const OVERLAP_SECS = 20; // must match the client-side split overlap

      // Accept either `chunks` (ordered ≤55min parts of a long recording, each
      // with 20s overlap) or a single `gcsUri` (short recording / back-compat).
      type BatchChunk = {
        gcsUri: string;
        startSec: number;
        durationSec: number;
      };
      let chunks: BatchChunk[] = [];
      if (Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
        chunks = parsed.chunks.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => ({
            gcsUri: String(c.gcsUri || ""),
            startSec: Number(c.startSec) || 0,
            durationSec: Number(c.durationSec) || 0,
          }),
        );
      } else if (parsed.gcsUri) {
        chunks = [
          { gcsUri: String(parsed.gcsUri), startSec: 0, durationSec: 0 },
        ];
      }

      if (chunks.length === 0 || chunks.some((c) => !c.gcsUri)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gcsUri or chunks is required" }));
        return;
      }

      const expectedPrefix = `gs://markflow-app-2026.firebasestorage.app/audio/${uid}/`;
      if (chunks.some((c) => !c.gcsUri.startsWith(expectedPrefix))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied: invalid audio path" }));
        return;
      }
      const multi = chunks.length > 1;

      const batchUrl = `https://${STT_LOCATION}-speech.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${STT_LOCATION}/recognizers/_:batchRecognize`;

      // Transcribe one file: start the op, poll to completion, surface per-file
      // errors, and return its SpeechRecognitionResult[] (word-level speaker
      // labels + timestamps). Throws on any failure.
      const transcribeFile = async (
        uri: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ): Promise<any[]> => {
        const startToken = await getGcpAccessToken();
        const startRes = await fetch(batchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${startToken}`,
          },
          body: JSON.stringify({
            config: {
              model: STT_MODEL,
              languageCodes: [language],
              features: {
                enableAutomaticPunctuation: true,
                diarizationConfig: { minSpeakerCount: 1, maxSpeakerCount: 6 },
              },
              denoiserConfig: { denoiseAudio: true },
              autoDecodingConfig: {},
            },
            files: [{ uri }],
            recognitionOutputConfig: { inlineResponseConfig: {} },
          }),
        });
        if (!startRes.ok) {
          const t = await startRes.text();
          throw new Error(
            `BatchRecognize start failed (${startRes.status}): ${t}`,
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const op = (await startRes.json()) as any;
        const opName: string = op.name;
        const shortName = uri.split("/").pop();
        console.log(`[batch] Operation started: ${opName} (${shortName})`);

        // Parallel across chunks → total ≈ slowest chunk; keep each poll under
        // the Cloud Run 900s request timeout.
        const maxPollMs = 12 * 60 * 1000;
        const pollInterval = 5000;
        const t0 = Date.now();
        let fails = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let result: any = null;
        while (Date.now() - t0 < maxPollMs) {
          await new Promise((r) => setTimeout(r, pollInterval));
          const tok = await getGcpAccessToken();
          const pollRes = await fetch(
            `https://${STT_LOCATION}-speech.googleapis.com/v2/${opName}`,
            { headers: { Authorization: `Bearer ${tok}` } },
          );
          if (!pollRes.ok) {
            fails++;
            const t = await pollRes.text();
            console.error(
              `[batch] Poll error (${fails}/5) ${shortName}: ${pollRes.status} | ${t}`,
            );
            if (fails >= 5)
              throw new Error(`Poll circuit breaker for ${shortName}`);
            continue;
          }
          fails = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const status = (await pollRes.json()) as any;
          if (status.done) {
            result = status;
            break;
          }
        }
        if (!result) throw new Error(`BatchRecognize timed out (${shortName})`);
        if (result.error)
          throw new Error(`STT op error: ${JSON.stringify(result.error)}`);
        const fileResults = result.response?.results || {};
        const fileKey = Object.keys(fileResults)[0];
        if (!fileKey) {
          console.error(
            `[batch] No file results for ${shortName}: ${JSON.stringify(
              result.response || {},
            ).slice(0, 1500)}`,
          );
          throw new Error("BatchRecognize returned no file results");
        }
        const fileError = fileResults[fileKey]?.error;
        if (fileError) {
          console.error(
            `[batch] Per-file STT error ${shortName}: ${JSON.stringify(fileError)}`,
          );
          throw new Error(
            `STT failed: ${fileError.message || JSON.stringify(fileError)}`,
          );
        }
        return fileResults[fileKey]?.inlineResult?.transcript?.results || [];
      };

      // Duration string ("1.200s") → seconds.
      const parseOffset = (v: unknown): number => {
        if (v == null) return 0;
        const n = parseFloat(String(v).replace(/s$/, ""));
        return isNaN(n) ? 0 : n;
      };

      // Run all chunks in parallel (total ≈ slowest chunk).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let chunkResults: any[][];
      try {
        chunkResults = await Promise.all(
          chunks.map((c) => transcribeFile(c.gcsUri)),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[batch] Transcription failed: ${msg}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
        return;
      }

      // Dedup the 20s overlap by word timestamp — split the overlap at its
      // midpoint so each boundary word is emitted exactly once — then build a
      // speaker-tagged transcript per chunk joined by "---" boundaries (labels
      // are only consistent within a segment; Claude unifies across "---").
      const allSpeakerLabels = new Set<string>();
      const taggedSegments: string[] = [];
      const plainSegments: string[] = [];

      for (let i = 0; i < chunkResults.length; i++) {
        const results = chunkResults[i];
        const c = chunks[i];
        const leadCut = i === 0 ? 0 : OVERLAP_SECS / 2;
        const trailCut =
          i === chunkResults.length - 1 || c.durationSec <= 0
            ? Infinity
            : c.durationSec - OVERLAP_SECS / 2;

        const words: Array<{ word: string; speakerLabel: string }> = [];
        let plain = "";
        for (const r of results) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const alt = (r as any).alternatives?.[0];
          if (!alt) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ws: any[] = alt.words || [];
          if (multi && ws.length > 0) {
            for (const w of ws) {
              const t = parseOffset(w.startOffset);
              if (t >= leadCut && t < trailCut) {
                words.push({
                  word: w.word || "",
                  speakerLabel: w.speakerLabel || "",
                });
                plain += w.word || "";
              }
            }
          } else {
            for (const w of ws)
              words.push({
                word: w.word || "",
                speakerLabel: w.speakerLabel || "",
              });
            plain += alt.transcript || "";
          }
        }

        const labels = new Set(
          words.map((w) => w.speakerLabel).filter(Boolean),
        );
        labels.forEach((l) => allSpeakerLabels.add(l));

        let tagged = plain;
        if (labels.size > 1 && words.length > 0) {
          let cur = "";
          const parts: string[] = [];
          for (const w of words) {
            const label = w.speakerLabel || "";
            if (label && label !== cur) {
              cur = label;
              parts.push(`\n[Speaker ${label}] `);
            }
            parts.push(w.word);
          }
          tagged = parts.join("").trim();
        }

        if (plain.trim()) {
          taggedSegments.push(tagged.trim());
          plainSegments.push(plain.trim());
        }
      }

      const transcript = plainSegments.join("\n");
      const taggedTranscript = taggedSegments.join("\n---\n");
      const speakerCount = allSpeakerLabels.size;

      console.log(
        `[batch] Done: ${chunks.length} chunk(s), ${transcript.length} chars, ${speakerCount} speakers`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transcript,
          taggedTranscript: taggedTranscript || transcript,
          speakerCount,
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[batch] Error: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // --- /v1/image/generate ---
  if (req.url === "/v1/image/generate") {
    try {
      await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = JSON.parse(body);
      const prompt: string = parsed.prompt;
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "prompt is required" }));
        return;
      }

      const accessToken = await getGcpAccessToken();
      const geminiRes = await fetch(getNanoBananaUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        res.writeHead(geminiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geminiData = (await geminiRes.json()) as any;
      const parts = geminiData.candidates?.[0]?.content?.parts;
      if (!parts || !Array.isArray(parts)) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image generated" }));
        return;
      }

      // Find the image part (inlineData)
      const imagePart = parts.find(
        (p: { inlineData?: { mimeType: string; data: string } }) =>
          p.inlineData,
      );
      if (!imagePart?.inlineData) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image in response" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: imagePart.inlineData.data,
          media_type: imagePart.inlineData.mimeType || "image/png",
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // --- /v1/research/analyze (Research Director — Claude Opus) ---
  if (req.url === "/v1/research/analyze") {
    try {
      await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = JSON.parse(body);
      const transcriptDiff: string = parsed.transcriptDiff || "";
      const fullContext: string = parsed.fullContext || "";
      const documentContext: string = parsed.documentContext || "";
      const searchedTopics: string[] = parsed.searchedTopics || [];

      if (!transcriptDiff) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "transcriptDiff is required" }));
        return;
      }

      const accessToken = await getGcpAccessToken();

      const systemPrompt = `あなたは会議のシニアリサーチディレクターです。
音声認識テキストを深く分析し、会議参加者に真に有益な調査を設計してください。

## あなたの役割
1. 会議の文脈・目的・参加者の関心事を深く読み解く
2. リサーチ価値のあるトピックを特定する
3. 各トピックについて「何を」「なぜ」「どの切り口で」調べるべきかを判断する
4. Web検索担当（リサーチアシスタント）への詳細なブリーフを設計する

## リサーチブリーフの設計指針
あなたのブリーフの質が、最終的なアウトプットの質を決定します。

**researchAngle（調査の焦点）の設計:**
- 悪い例: 「ソニーについて調べて」
- 良い例: 「ソニーのゲーム事業に焦点。議論ではPS5の販売台数が話題になっており、直近四半期のG&NS部門の売上・ハードウェア出荷台数・サブスクリプション会員数の推移が最も関連する。競合(Xbox, Nintendo)との比較データも有用」

**desiredOutput（出力形式の指示）の設計:**
- 悪い例: 「情報をまとめて」
- 良い例: 「先頭に結論1行（例: PS5累計6000万台、前年比+15%）。続いて直近2Qの数値を箇条書き。議論で出た『1億台突破は来年』という発言の妥当性を最後に1行で判定」

## リサーチ対象の判定基準
以下に該当する場合にリサーチを設計:
1. **企業・ブランド・人名**: 最新動向、財務状況、市場ポジション
2. **数値・事実の主張**: 「シェアは○%」「売上○億」→ 正確な数値で裏付けor修正
3. **業界動向・技術トレンド**: 最新の市場データ、競合情報
4. **明示的な調査依頼**: 「調べて」「確認して」等の発言

以下はリサーチ不要:
- 一般的な雑談・挨拶・意見表明
- 検索済みトピックと実質同じ内容
- 検索しても有用な情報が得られない曖昧な話題

0〜3件のsearchesを返してください。検索価値がなければ空配列。

## スピーカーへの質問（questions）の設計
相手（自分以外の話者）が実質的な内容を**まとまって話した**直後に、こちらが次に投げるべき
鋭い質問を設計します。これは会議参加者が「いざ質問しようとすると引き出しが少ない」場面を
支える機能です。Web検索は不要で、発言そのものへの深い読み込みから設計します。

- 直近の発言に対して、**狙いの異なる質問を3〜4問**用意する。狙いは分散させること:
  - 数値・事実を引き出す（「具体的に何%／いつ／いくら？」）
  - 前提・根拠を掘る（「その判断の前提は？なぜそう言える？」）
  - 具体化を促す（「具体例を1つ挙げると？」）
  - リスク・反例を突く（「未達／失敗時は？逆のケースは？」）
  - 次アクションを確定させる（「誰が・いつまでに？」）
- 会議の言語で、**そのまま口に出せる簡潔な問い**にする。長い前置き禁止。
- 以下では questions を出さない（空にする）:
  - 挨拶・雑談・相槌・自分（記録者）側の発言
  - 掘り下げる価値のない断片的な発言
  - 直近の質問候補と実質同じ問い

必ずJSON形式のみで出力してください。

出力フォーマット:
{
  "searches": [
    {
      "query": "検索クエリ（具体的に。年号含む）",
      "type": "topic | fact-check | financial | explicit-request",
      "researchAngle": "調査の焦点。会議の文脈を踏まえ、何に焦点を当てて調べるべきか",
      "desiredOutput": "最も有用な出力の形式と内容。具体的に指示",
      "claim": "(fact-checkのみ) 検証対象の元の発言をそのまま引用"
    }
  ],
  "questions": {
    "topic": "質問群の見出し（例: 新規事業のKPI）。相手の発言テーマを短く",
    "items": [
      { "question": "現在の達成率は具体的に何%ですか？", "intent": "数値を引き出す" }
    ]
  }
}

questions は掘り下げ価値がある時のみ。無ければ "questions": { "items": [] } とすること。`;

      let userPrompt = `## 新しいトランスクリプト（音声認識 — 誤認識を含む可能性あり）\n${transcriptDiff.slice(0, 3000)}`;
      if (fullContext) {
        userPrompt += `\n\n## 会議の全体コンテキスト（直近部分）\n${fullContext.slice(-4000)}`;
      }
      if (documentContext) {
        userPrompt += `\n\n## 構造化済みドキュメント（参考）\n${documentContext.slice(0, 2000)}`;
      }
      userPrompt += `\n\n## 検索済みトピック（重複禁止）\n${searchedTopics.length > 0 ? searchedTopics.join(", ") : "(なし)"}`;

      const vertexRes = await fetch(getVertexAiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          anthropic_version: "vertex-2023-10-16",
          max_tokens: 3072,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          stream: false,
        }),
      });

      if (!vertexRes.ok) {
        const errText = await vertexRes.text();
        console.error(
          `[research] analyze error: ${vertexRes.status} | ${errText}`,
        );
        res.writeHead(vertexRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vertexData = (await vertexRes.json()) as any;
      const text =
        vertexData.content?.[0]?.text || vertexData.content?.text || "";

      if (!text) {
        console.log("[research] analyze: empty response from Claude");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ searches: [], questions: null }));
        return;
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error("[research] analyze: no JSON found in response");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ searches: [], questions: null }));
        return;
      }

      const result = JSON.parse(jsonMatch[0]);
      const searches = Array.isArray(result.searches) ? result.searches : [];
      // Questions are follow-up prompts the user can ASK — no web search needed.
      // Only surface them when the director produced a non-empty item list.
      const rawQuestions = result.questions;
      const questionItems = Array.isArray(rawQuestions?.items)
        ? rawQuestions.items.filter(
            (q: { question?: string }) =>
              q && typeof q.question === "string" && q.question.trim(),
          )
        : [];
      const questions =
        questionItems.length > 0
          ? { topic: rawQuestions.topic || "", items: questionItems }
          : null;
      console.log(
        `[research] analyze: ${searches.length} searches, ${questionItems.length} questions — ${searches.map((s: { query: string }) => s.query).join(" | ")}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ searches, questions }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[research] analyze error: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // --- /v1/research/grounded-search ---
  if (req.url === "/v1/research/grounded-search") {
    try {
      await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = JSON.parse(body);
      const query: string = parsed.query || "";
      const researchAngle: string = parsed.researchAngle || "";
      const desiredOutput: string = parsed.desiredOutput || "";
      const claim: string = parsed.claim || "";

      if (!query) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "query is required" }));
        return;
      }

      const accessToken = await getGcpAccessToken();

      const systemPrompt = researchAngle
        ? `会議のリアルタイムリサーチアシスタント。ディレクターのブリーフに基づき、正確で具体的な情報を提供する。

## 調査の焦点
${researchAngle}

## 求められるアウトプット
${desiredOutput || "数値・日付・固有名詞を含む具体的な情報を箇条書きで提供"}
${claim ? `\n## 検証対象の発言\n「${claim}」` : ""}

## 品質基準（厳守）
- 数値・日付・固有名詞を必ず含める。抽象的な記述は禁止
- 「〜と言われている」「〜の見方がある」等の曖昧表現禁止。断定と出典で書く
- 不明な情報は「確認不能」と明記。推測で補完しない
- コンパクトに。会議中にチラ見して即座に使える分量（最大8行）`
        : `会議中にチラ見するカンペを生成する。数値・固有名詞・日付を含め、曖昧表現は禁止。最大8行。`;

      const userPrompt = query;

      const geminiRes = await fetch(getGeminiUrl(GEMINI_MODEL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userPrompt }],
            },
          ],
          tools: [{ googleSearch: {} }],
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error(
          `[research] grounded-search error: ${geminiRes.status} | ${errText}`,
        );
        res.writeHead(geminiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geminiData = (await geminiRes.json()) as any;
      const summary =
        geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const groundingMeta = geminiData.candidates?.[0]?.groundingMetadata;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sources = (groundingMeta?.groundingChunks || []).map(
        (chunk: any) => {
          const uri: string = chunk.web?.uri || "";
          const title: string = chunk.web?.title || "";
          let domain = "";
          try {
            domain = new URL(uri).hostname;
          } catch {
            domain = uri;
          }
          return {
            url: uri,
            title,
            domain,
            credibility: classifyCredibility(domain),
          };
        },
      );

      const webSearchQueries: string[] = groundingMeta?.webSearchQueries || [];

      console.log(
        `[research] grounded-search: query="${query}" sources=${sources.length} searches=${webSearchQueries.length}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ summary, sources, webSearchQueries }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[research] grounded-search error: ${message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // --- /v1/chat ---
  if (req.url !== "/v1/chat") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    // Verify Firebase auth
    await verifyFirebaseToken(req.headers.authorization);

    const body = await readBody();
    const parsed = JSON.parse(body);
    const isStream = parsed.stream === true;

    // Build Vertex AI request (model is in URL, not body)
    const vertexBody: Record<string, unknown> = {
      anthropic_version: "vertex-2023-10-16",
      max_tokens: parsed.max_tokens || 4096,
      messages: parsed.messages || [],
      stream: isStream,
    };
    if (parsed.system) {
      vertexBody.system = parsed.system;
    }
    if (parsed.tools) {
      vertexBody.tools = parsed.tools;
    }

    const accessToken = await getGcpAccessToken();

    const vertexRes = await fetch(getVertexAiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(vertexBody),
    });

    if (!vertexRes.ok) {
      const errText = await vertexRes.text();
      res.writeHead(vertexRes.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errText }));
      return;
    }

    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const reader = vertexRes.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const data = await vertexRes.text();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    const isAuthError =
      message.includes("Authorization") ||
      message.includes("Firebase ID token") ||
      message.includes("Decoding Firebase ID token");
    res.writeHead(isAuthError ? 401 : 500, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI proxy server running on port ${PORT}`);
});
