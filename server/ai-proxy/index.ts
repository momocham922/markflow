import http from "http";
import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const PORT = parseInt(process.env.PORT || "8080", 10);
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "markflow-app-2026";
const GCP_REGION = process.env.GCP_REGION || "us-east5";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-6";
const NANOBANANA_MODEL = process.env.NANOBANANA_MODEL || "gemini-3.1-flash-image-preview";
const STT_LOCATION = process.env.STT_LOCATION || "us-central1";
const STT_MODEL = process.env.STT_MODEL || "chirp_2";

// Initialize Firebase Admin (uses default service account on Cloud Run)
initializeApp();

function getVertexAiUrl(): string {
  return `https://${GCP_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/anthropic/models/${CLAUDE_MODEL}:streamRawPredict`;
}

function getNanoBananaUrl(): string {
  return `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/global/publishers/google/models/${NANOBANANA_MODEL}:generateContent`;
}

async function getGcpAccessToken(): Promise<string> {
  const metadataUrl =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const res = await fetch(metadataUrl, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) throw new Error("Failed to get access token from metadata server");
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function verifyFirebaseToken(authHeader: string | undefined): Promise<string> {
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

      const sttConfig: Record<string, unknown> = {
        model: STT_MODEL,
        languageCodes: [language],
        features: {
          enableAutomaticPunctuation: true,
        },
      };

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
        console.error(`[voice] STT error: ${sttRes.status} | encoding=${encoding} rate=${sampleRate} audioBytes=${audioBytes} | ${errText}`);
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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: transcript }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
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
        (p: { inlineData?: { mimeType: string; data: string } }) => p.inlineData,
      );
      if (!imagePart?.inlineData) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image in response" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: imagePart.inlineData.data,
        media_type: imagePart.inlineData.mimeType || "image/png",
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
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
    const message = err instanceof Error ? err.message : "Internal server error";
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI proxy server running on port ${PORT}`);
});
