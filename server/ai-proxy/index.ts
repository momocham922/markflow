import http from "http";
import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const PORT = parseInt(process.env.PORT || "8080", 10);
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "markflow-app-2026";
const GCP_REGION = process.env.GCP_REGION || "us-east5";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const NANOBANANA_MODEL =
  process.env.NANOBANANA_MODEL || "gemini-3.1-flash-image-preview";
const STT_LOCATION = process.env.STT_LOCATION || "asia-northeast1";
const STT_MODEL = process.env.STT_MODEL || "chirp_3";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// Initialize Firebase Admin (uses default service account on Cloud Run)
initializeApp();

function getVertexAiUrl(): string {
  return `https://${GCP_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/anthropic/models/${CLAUDE_MODEL}:streamRawPredict`;
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
      const gcsUri: string = parsed.gcsUri;
      const language: string = parsed.language || "ja-JP";

      if (!gcsUri) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gcsUri is required" }));
        return;
      }

      const expectedPrefix = `gs://markflow-app-2026.firebasestorage.app/audio/${uid}/`;
      if (!gcsUri.startsWith(expectedPrefix)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied: invalid audio path" }));
        return;
      }

      const accessToken = await getGcpAccessToken();
      const batchUrl = `https://${STT_LOCATION}-speech.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${STT_LOCATION}/recognizers/_:batchRecognize`;

      const batchRes = await fetch(batchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          config: {
            model: STT_MODEL,
            languageCodes: [language],
            features: {
              enableAutomaticPunctuation: true,
              diarizationConfig: {
                minSpeakerCount: 1,
                maxSpeakerCount: 6,
              },
            },
            denoiserConfig: { denoiseAudio: true },
            autoDecodingConfig: {},
          },
          files: [{ uri: gcsUri }],
          recognitionOutputConfig: {
            inlineResponseConfig: {},
          },
        }),
      });

      if (!batchRes.ok) {
        const errText = await batchRes.text();
        console.error(
          `[batch] BatchRecognize start error: ${batchRes.status} | ${errText}`,
        );
        res.writeHead(batchRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const operation = (await batchRes.json()) as any;
      const opName: string = operation.name;
      console.log(`[batch] Operation started: ${opName}`);

      // Poll for completion (max 14 minutes, every 5 seconds)
      const maxPollMs = 14 * 60 * 1000;
      const pollInterval = 5000;
      const startTime = Date.now();
      let consecutiveFailures = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any = null;

      while (Date.now() - startTime < maxPollMs) {
        await new Promise((r) => setTimeout(r, pollInterval));

        const freshToken = await getGcpAccessToken();
        const pollUrl = `https://${STT_LOCATION}-speech.googleapis.com/v2/${opName}`;
        const pollRes = await fetch(pollUrl, {
          headers: { Authorization: `Bearer ${freshToken}` },
        });

        if (!pollRes.ok) {
          consecutiveFailures++;
          const errText = await pollRes.text();
          console.error(
            `[batch] Poll error (${consecutiveFailures}/5): ${pollRes.status} | ${errText}`,
          );
          if (consecutiveFailures >= 5) {
            console.error(
              `[batch] Circuit breaker: 5 consecutive poll failures`,
            );
            break;
          }
          continue;
        }

        consecutiveFailures = 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status = (await pollRes.json()) as any;
        if (status.done) {
          result = status;
          break;
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[batch] Polling... ${elapsed}s elapsed`);
      }

      if (!result) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "BatchRecognize timed out (14 min)" }));
        return;
      }

      if (result.error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: JSON.stringify(result.error) }));
        return;
      }

      // Extract transcript with speaker labels from inline result
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fileResults = result.response?.results || {};
      const fileKey = Object.keys(fileResults)[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sttResults: any[] =
        fileResults[fileKey]?.inlineResult?.transcript?.results || [];

      const transcript = sttResults
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r.alternatives?.[0]?.transcript || "")
        .join("");

      // Build speaker-tagged transcript from word-level labels
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const words: Array<{ word: string; speakerLabel: string }> =
        sttResults.flatMap(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) => r.alternatives?.[0]?.words || [],
        );

      const speakerLabels = new Set(
        words.map((w) => w.speakerLabel).filter(Boolean),
      );

      let taggedTranscript = transcript;
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
        taggedTranscript = parts.join("").trim();
      }

      console.log(
        `[batch] Done: ${transcript.length} chars, ${speakerLabels.size} speakers`,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transcript,
          taggedTranscript:
            speakerLabels.size > 1 ? taggedTranscript : transcript,
          speakerCount: speakerLabels.size,
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

  // --- /v1/research/judge-topic ---
  if (req.url === "/v1/research/judge-topic") {
    try {
      await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = JSON.parse(body);
      const transcript: string = parsed.transcript || "";
      const delta: string = parsed.delta || "";
      const existingTopics: string[] = parsed.existingTopics || [];

      if (!delta) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "delta is required" }));
        return;
      }

      const accessToken = await getGcpAccessToken();
      const geminiRes = await fetch(getGeminiUrl(GEMINI_MODEL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `あなたは会議のリアルタイム音声認識テキストを分析し、参加者に役立つ補足情報（カンペ）を提供するために検索すべきトピックを判定するアシスタントです。

会議の文脈（直近部分）:
${transcript.slice(-2000)}

新しく検出されたキーワード:
${delta}

検索済みトピック:
${existingTopics.length > 0 ? existingTopics.join(", ") : "(なし)"}

判定基準:
- shouldSearch: true にすべきケース:
  - 具体的な企業名・製品名・人名・技術用語が出た（深掘り価値あり）
  - 数値・統計・市場データへの言及（「売上が○○億」「シェアは○%」等）
  - 事実確認が必要な主張（「○○は△△だったはず」等）
  - 明示的な調査依頼（「調べておいて」「確認が必要」「正確な数字は？」等）
  - 議論の文脈で背景知識があると有利なトピック
- shouldSearch: false にすべきケース:
  - 一般的な雑談・挨拶・意見表明
  - 既に検索済みのトピックと実質同じ内容
  - 検索しても有用な情報が得られないほど曖昧な話題

queryの作成指針:
- 議論の文脈を踏まえた具体的な検索クエリにする（単語の羅列ではなく、何を知りたいのかが明確なクエリ）
- 日本語トピックは日本語で、技術用語や英語固有名詞は英語で
- 最新データが重要な場合は年号を含める

type: "topic"=新しい話題の深掘り, "fact-check"=発言された数値・事実の裏付け, "explicit-request"=参加者が明示的に調査を依頼`,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                shouldSearch: { type: "BOOLEAN" },
                query: { type: "STRING" },
                type: {
                  type: "STRING",
                  enum: ["topic", "fact-check", "explicit-request"],
                },
                reason: { type: "STRING" },
              },
              required: ["shouldSearch", "query", "type", "reason"],
            },
          },
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error(
          `[research] judge-topic error: ${geminiRes.status} | ${errText}`,
        );
        res.writeHead(geminiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geminiData = (await geminiRes.json()) as any;
      const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            shouldSearch: false,
            query: "",
            type: "topic",
            reason: "No response from model",
          }),
        );
        return;
      }

      const result = JSON.parse(text);
      console.log(
        `[research] judge-topic: shouldSearch=${result.shouldSearch} query="${result.query}" type=${result.type}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[research] judge-topic error: ${message}`);
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
      const context: string = parsed.context || "";
      const type: string = parsed.type || "topic";

      if (!query) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "query is required" }));
        return;
      }

      const accessToken = await getGcpAccessToken();

      const systemPrompt =
        type === "fact-check"
          ? `あなたは会議中にリアルタイムで発言内容をファクトチェックするアシスタントです。
日本語と英語の両方で検索し、権威あるソースから裏付けを取ってください。

出力フォーマット（Markdown）:
### 検証結果
- **主張**: [発言された主張を簡潔に記述]
- **判定**: [正確 / 概ね正確 / 不正確 / 要確認] のいずれか
- **正確な数値・事実**: [検索で見つかった正確なデータ。年月日・出典名を必ず含める]
- **補足**: [主張と事実の差異、注意すべきニュアンス、文脈で知っておくべき追加情報]`
          : `あなたは会議中にリアルタイムで「カンペ」を提供するリサーチアシスタントです。
参加者が議論中に即座に活用できる、深い分析と具体的なデータを提供してください。
表面的なWeb検索のダイジェストではなく、議論に直接貢献できるインサイトを生成してください。
日本語と英語の両方で検索し、学術論文・公式レポート・業界分析も含めてください。

出力フォーマット（Markdown）:
### 要点
[このトピックについて、会議で即座に使える2-3文のエグゼクティブサマリー]

### キーデータ
- **[指標/事実名]**: [具体的な数値・日付・出典]（1-3個の最重要データポイント）

### 議論のポイント
- [この話題で押さえるべき論点や、発言に使える具体的な知見を2-3個。「〜という見方がある」ではなく「〜である（出典）」の形式で]

### 注意点
- [よくある誤解、落とし穴、考慮すべきリスクがあれば1-2個]`;

      const userPrompt =
        type === "fact-check"
          ? `以下の会議で出た発言を検証してください。\n\n会議の文脈:\n${context.slice(-1000)}\n\n検証対象:\n${query}`
          : `以下の会議で話題になっているトピックについて、参加者が議論に使えるカンペを作成してください。\n会議で今まさに話されている内容なので、議論の文脈に沿った情報を優先してください。\n\n会議の文脈:\n${context.slice(-1000)}\n\nリサーチ対象:\n${query}`;

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
