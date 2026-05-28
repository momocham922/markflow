/**
 * AI Image Generation service for MarkFlow.
 * Generates images via the AI proxy, uploads to Firebase Storage,
 * and returns markdown image syntax ready for insertion.
 */

import { auth } from "./firebase";
import { getPlatform } from "@/platform";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "http://localhost:8080";
const STORAGE_BUCKET = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "";

async function getFirebaseToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  return user.getIdToken();
}

export interface ImageGenResult {
  url: string;
  markdown: string;
}

/**
 * Generate an image from a text prompt.
 * Sends the prompt to the AI proxy's image generation endpoint.
 * The proxy should return { data: string (base64), media_type: string }.
 */
export async function generateImage(
  prompt: string,
  onStatus?: (status: string) => void,
): Promise<ImageGenResult> {
  const token = await getFirebaseToken();
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");

  onStatus?.("Generating image...");

  // Call AI proxy image generation endpoint
  const response = await fetch(`${AI_PROXY_URL}/v1/image/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Image generation failed: ${response.status} ${error}`);
  }

  const result = await response.json();
  const base64Data: string = result.data;
  const mediaType: string = result.media_type || "image/png";
  const ext = mediaType.split("/")[1] || "png";

  onStatus?.("Uploading to cloud...");

  // Upload to Firebase Storage via platform adapter
  const platform = await getPlatform();
  const url = await platform.uploadImageFromBase64(
    base64Data,
    ext,
    user.uid,
    token,
    STORAGE_BUCKET,
  );

  const sanitizedPrompt = prompt.replace(/[[\]]/g, "").slice(0, 60);
  const markdown = `![${sanitizedPrompt}](${url})`;

  return { url, markdown };
}
