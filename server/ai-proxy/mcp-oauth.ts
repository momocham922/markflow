// =====================================================================
// MCP OAuth 2.1 Authorization Server — pure logic
// ---------------------------------------------------------------------
// The remote MCP server (/mcp) is a protected resource. Claude (claude.ai web /
// mobile / Desktop) discovers this proxy as its Authorization Server via
// RFC 9728 (protected-resource metadata) + RFC 8414 (AS metadata), performs
// RFC 7591 Dynamic Client Registration, then an OAuth 2.1 authorization_code +
// PKCE (S256) flow. The one non-standard step — authenticating the end user via
// Firebase Google sign-in inside /authorize — is why we hand-roll the AS instead
// of using the SDK's Express-only helpers (their provider model can't host our
// Firebase login page).
//
// This module is PURE (crypto is deterministic given inputs): PKCE verification,
// token/code minting + hashing, metadata builders, redirect-uri matching, and
// DCR request validation. All Firestore persistence + HTTP lives in index.ts.
// Kept free of firebase-admin / http imports so it unit-tests without mocks.
// =====================================================================

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// ---------------------------------------------------------------------
// Endpoint paths (single source shared by metadata + routing in index.ts)
// ---------------------------------------------------------------------

export const MCP_PATH = "/mcp";
export const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
export const ASM_PATH = "/.well-known/oauth-authorization-server";
export const REGISTER_PATH = "/oauth/register";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REVOKE_PATH = "/oauth/revoke";
// Server-side Google OAuth callback (Option b): the /authorize consent page sends
// the user to Google, which returns here. We redeem the code with the SERVER-held
// GOOGLE_OAUTH_CLIENT_SECRET, resolve the Firebase uid by email, and mint the MCP
// authorization code — so NO firebaseapp.com URL is ever exposed to the user.
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

export const MCP_SCOPE = "mcp";

// ---------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------

export const CODE_TTL_SEC = 300; // authorization code: 5 min, single-use
export const ACCESS_TTL_SEC = 3600; // access token: 1 hour
export const REFRESH_TTL_SEC = 30 * 24 * 3600; // refresh token: 30 days (rotated)

// ---------------------------------------------------------------------
// Crypto helpers (deterministic / testable)
// ---------------------------------------------------------------------

export function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 of a UTF-8 string, base64url-encoded (used for PKCE + token hashing). */
export function sha256base64url(input: string): string {
  return base64url(createHash("sha256").update(input, "utf8").digest());
}

/** Firestore doc-id-safe hash of an opaque secret (never store the raw secret). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a 256-bit opaque, URL-safe secret (auth codes, access/refresh tokens, client ids). */
export function newOpaqueToken(): string {
  return base64url(randomBytes(32));
}

/** PKCE S256: verify base64url(SHA256(verifier)) === challenge. S256 only. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  // RFC 7636: verifier is 43-128 chars of [A-Za-z0-9-._~]. Reject out-of-range
  // early so a malformed verifier can't be coerced into a match.
  if (verifier.length < 43 || verifier.length > 128) return false;
  return sha256base64url(verifier) === challenge;
}

// ---------------------------------------------------------------------
// Signed state (Google OAuth round-trip integrity) — Option b
// ---------------------------------------------------------------------
// The /authorize consent page hands the user to Google carrying the MCP OAuth
// params in Google's `state`. We MUST be able to trust those params on return, so
// we HMAC-sign the state with a server-only key (a subkey derived from
// GOOGLE_OAUTH_CLIENT_SECRET). This gives integrity + a short expiry; the callback
// ALSO re-validates the params against the registered client (defense in depth).
// The value carries no secret, only the already-public authorize params + iat.

/**
 * Derive the state-signing HMAC key from a server secret (domain-separated so the
 * OAuth client_secret is never used verbatim as an HMAC key). Returns "" for an
 * empty secret so callers fail closed.
 */
export function deriveStateKey(secret: string): string {
  if (!secret) return "";
  return createHash("sha256")
    .update("mcp-google-state:" + secret)
    .digest("hex");
}

/** base64url-decode a string back to a Buffer (inverse of base64url()). */
export function base64urlDecode(s: string): Buffer {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(norm, "base64");
}

/**
 * Sign an arbitrary JSON-serialisable payload into a compact `<body>.<mac>` token
 * (both parts base64url). `iat` (issued-at, seconds) is stamped in so verifyState
 * can enforce a max age. `key` is a server-only secret; `nowSec` is injected so
 * this stays pure/testable.
 */
export function signState(
  payload: Record<string, unknown>,
  key: string,
  nowSec: number,
): string {
  const body = base64url(
    Buffer.from(JSON.stringify({ ...payload, iat: nowSec }), "utf8"),
  );
  const mac = base64url(createHmac("sha256", key).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify + decode a signState() token. Returns the payload object (including
 * `iat`) when the MAC is valid AND it is at most `maxAgeSec` old, else null.
 * Uses a constant-time MAC comparison. Any malformed/expired/tampered token → null.
 */
export function verifyState(
  token: string,
  key: string,
  maxAgeSec: number,
  nowSec: number,
): Record<string, unknown> | null {
  if (!token || !key) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = base64url(createHmac("sha256", key).update(body).digest());
  const macBuf = Buffer.from(mac, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (macBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(macBuf, expBuf)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  const iat = Number(payload.iat);
  if (!Number.isFinite(iat)) return null;
  // Reject future-dated (clock abuse) and expired tokens.
  if (iat > nowSec + 60) return null;
  if (nowSec - iat > maxAgeSec) return null;
  return payload;
}

// ---------------------------------------------------------------------
// Google id_token claims (Option b) — decode + validate
// ---------------------------------------------------------------------
// The id_token is obtained directly from Google's token endpoint over TLS in
// response to our client_secret-authenticated request, so it arrives on a trusted
// channel (no signature re-verification needed — the standard token-endpoint trust
// model). We still validate aud/iss/exp and require a verified email before
// trusting the identity.

/** Decode a JWT's payload (2nd segment) to an object. Null on any malformation. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const obj = JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
    return obj && typeof obj === "object"
      ? (obj as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

export interface GoogleIdTokenCheck {
  ok: boolean;
  email?: string;
  reason?: string;
}

/**
 * Validate the security-relevant claims of a Google id_token payload: audience
 * must be our client, issuer must be Google, not expired, and the email must be
 * present AND verified. `nowSec` injected for testability. Returns the normalised
 * (lower-cased) email on success.
 */
export function validateGoogleIdToken(
  payload: Record<string, unknown> | null,
  opts: { expectedAud: string; nowSec: number; expectedNonce?: string },
): GoogleIdTokenCheck {
  if (!payload) return { ok: false, reason: "no_payload" };
  const aud = payload.aud;
  const audOk = Array.isArray(aud)
    ? aud.map(String).includes(opts.expectedAud)
    : String(aud || "") === opts.expectedAud;
  if (!opts.expectedAud || !audOk) return { ok: false, reason: "aud_mismatch" };
  if (!GOOGLE_ISSUERS.has(String(payload.iss || "")))
    return { ok: false, reason: "iss_mismatch" };
  const exp = Number(payload.exp);
  // Allow 60s of clock skew.
  if (!Number.isFinite(exp) || exp <= opts.nowSec - 60)
    return { ok: false, reason: "expired" };
  // Bind the id_token to the nonce minted at /authorize (OIDC replay / auth-code
  // injection defense: a captured victim code carries the victim-flow nonce, which
  // will not match an attacker-crafted state's nonce). When a nonce is expected it
  // MUST be present and match exactly — fail closed on an empty expected value too.
  if (opts.expectedNonce !== undefined) {
    if (
      !opts.expectedNonce ||
      String(payload.nonce || "") !== opts.expectedNonce
    )
      return { ok: false, reason: "nonce_mismatch" };
  }
  // email_verified can arrive as boolean true or the string "true".
  const ev = payload.email_verified;
  const verified = ev === true || ev === "true";
  const email = String(payload.email || "")
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, reason: "no_email" };
  if (!verified) return { ok: false, reason: "email_unverified" };
  return { ok: true, email };
}

// ---------------------------------------------------------------------
// Base URL derivation (behind Cloud Run / nginx proxy)
// ---------------------------------------------------------------------

type HeaderVal = string | string[] | undefined;
function first(v: HeaderVal): string {
  return (Array.isArray(v) ? v[0] : v) || "";
}

/**
 * Reconstruct the externally-visible origin from request headers. All metadata
 * MUST be built from the SAME base the client actually fetched it from (RFC 8414:
 * issuer == fetch origin), so we honour x-forwarded-host/proto set by the proxy
 * and fall back to Host. Defaults to https (Cloud Run terminates TLS).
 */
export function deriveBaseUrl(headers: Record<string, HeaderVal>): string {
  const host = first(headers["x-forwarded-host"]) || first(headers["host"]);
  const proto = first(headers["x-forwarded-proto"]) || "https";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------
// Client IP extraction (rate-limit key) — spoof-resistant
// ---------------------------------------------------------------------
// A directly-exposed server must NOT trust the LEFTMOST X-Forwarded-For entry:
// a caller can prepend arbitrary values, and Google's front end APPENDS the real
// client address to the RIGHT (GCP LB appends "<client>, <lb>"; direct run.app
// appends the detected client). Only the right side is added by trusted infra, so
// we key rate limits on the RIGHTMOST entry — it is never attacker-controllable.
// Worst case it collapses to a shared Google egress IP, which only makes the limit
// MORE conservative, never bypassable. (MDN X-Forwarded-For: "count from the
// right"; the leftmost value must never be used for security decisions.)
export function pickClientIp(
  xff: string | string[] | undefined,
  socketAddr?: string,
): string {
  const raw = Array.isArray(xff) ? xff.join(",") : xff || "";
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return socketAddr || "unknown";
}

// ---------------------------------------------------------------------
// Discovery metadata
// ---------------------------------------------------------------------

/** RFC 9728 protected-resource metadata, served at PRM_PATH. */
export function buildProtectedResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}${MCP_PATH}`,
    authorization_servers: [baseUrl],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://markflow.jp",
    // Human-readable resource name (RFC 9728 §2). Harmless if a client ignores it.
    resource_name: "MarkFlow Documents",
  };
}

/** RFC 8414 authorization-server metadata, served at ASM_PATH. */
export function buildAuthServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}${AUTHORIZE_PATH}`,
    token_endpoint: `${baseUrl}${TOKEN_PATH}`,
    registration_endpoint: `${baseUrl}${REGISTER_PATH}`,
    revocation_endpoint: `${baseUrl}${REVOKE_PATH}`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // Non-standard extension: some MCP clients (community-reported, unconfirmed
    // against Anthropic docs as of 2026-09) read logo_uri here to brand a custom
    // connector. Zero cost, ignored by clients that don't. Served at /mcp-icon.png.
    logo_uri: `${baseUrl}/mcp-icon.png`,
  };
}

// ---------------------------------------------------------------------
// Redirect URI validation (RFC 8252 loopback handling)
// ---------------------------------------------------------------------

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

/** Accept https:// anywhere, or http:// only for loopback (native app callback). */
export function isValidRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hostname && isLoopbackHost(u.hostname))
    return u.protocol === "http:" || u.protocol === "https:";
  return u.protocol === "https:";
}

// ---------------------------------------------------------------------
// Redirect-host allowlist (confused-deputy defense)
// ---------------------------------------------------------------------
// Accepting ANY https redirect_uri at (open, unauthenticated) DCR is what makes
// the OAuth confused-deputy / code-phishing attack possible: an attacker
// registers their own client with their own redirect + PKCE challenge, phishes an
// allowlisted user to the GENUINE proxy /authorize, and the code is delivered to
// the attacker's URL (PKCE gives no protection — the attacker authored the
// challenge). We therefore pin acceptable redirect hosts to Claude's hosted
// surfaces + loopback, per the MCP security guidance (exact/narrow redirect
// rules; never trust a self-asserted client_name).
//
//   - claude.ai / claude.com : Claude web / Desktop / mobile deliver the code to
//     https://claude.ai/api/mcp/auth_callback (claude.com is the newer host).
//   - loopback (any port)    : native clients (Claude Code) — RFC 8252.
//
// Extra hosts can be added via MCP_ALLOWED_REDIRECT_HOSTS (comma-separated) so a
// future Claude domain can be trusted without a code change.
const DEFAULT_ALLOWED_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

export function allowedRedirectHosts(extra?: string): Set<string> {
  const set = new Set(DEFAULT_ALLOWED_REDIRECT_HOSTS);
  for (const h of (extra || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)) {
    set.add(h);
  }
  return set;
}

/**
 * Strict redirect gate used by DCR: loopback (http/https, any port) for native
 * clients, or https to an allowlisted host. Rejects the "any https" case that
 * makes the confused-deputy attack possible.
 */
export function isAllowedRedirectUri(
  uri: string,
  allowedHosts: Set<string>,
): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (isLoopbackHost(host))
    return u.protocol === "http:" || u.protocol === "https:";
  return u.protocol === "https:" && allowedHosts.has(host);
}

/**
 * Match a requested redirect_uri against the client's registered set. Exact
 * string match, EXCEPT loopback URIs match port-agnostically (RFC 8252 §7.3: a
 * native client's loopback port is assigned at runtime). Scheme/host/path must
 * still match exactly.
 */
export function matchRedirectUri(
  requested: string,
  registered: string[],
): boolean {
  if (!requested) return false;
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHost(r.hostname)) return false;
  return registered.some((reg) => {
    let g: URL;
    try {
      g = new URL(reg);
    } catch {
      return false;
    }
    return (
      isLoopbackHost(g.hostname) &&
      g.protocol === r.protocol &&
      g.hostname === r.hostname &&
      g.pathname === r.pathname
    );
  });
}

// ---------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------

export interface DcrValidation {
  ok: boolean;
  error?: string;
  error_description?: string;
  redirectUris?: string[];
  clientName?: string;
  tokenEndpointAuthMethod?: string;
}

/**
 * Validate a DCR request body. Public clients only (PKCE, no client secret).
 * Every redirect_uri must pass the strict host allowlist (confused-deputy
 * defense); `allowedHosts` defaults to the built-in Claude set + loopback.
 */
export function validateDcrRequest(
  body: unknown,
  allowedHosts: Set<string> = allowedRedirectHosts(),
): DcrValidation {
  const b = (body || {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      error_description:
        "redirect_uris is required and must be a non-empty array",
    };
  }
  const redirectUris = uris.map((u) => String(u));
  for (const u of redirectUris) {
    if (!isAllowedRedirectUri(u, allowedHosts)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        error_description: `redirect_uri not allowed: ${u} (must be https to an allowed host, or http loopback)`,
      };
    }
  }
  // We only issue public-client credentials; ignore any requested confidential
  // auth method and pin token_endpoint_auth_method to "none".
  return {
    ok: true,
    redirectUris,
    clientName: typeof b.client_name === "string" ? b.client_name : undefined,
    tokenEndpointAuthMethod: "none",
  };
}

/** Shape the RFC 7591 registration response for a newly-created public client. */
export function buildDcrResponse(
  clientId: string,
  redirectUris: string[],
  clientName: string | undefined,
  createdAtSec: number,
) {
  return {
    client_id: clientId,
    client_id_issued_at: createdAtSec,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(clientName ? { client_name: clientName } : {}),
  };
}

// ---------------------------------------------------------------------
// /authorize request validation
// ---------------------------------------------------------------------

export interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
  resource: string;
}

export interface AuthorizeValidation {
  ok: boolean;
  // "fatal" errors (bad client / redirect_uri) MUST render an error page — we
  // cannot safely redirect. "redirect" errors go back to the client per RFC 6749.
  kind?: "fatal" | "redirect";
  error?: string;
  error_description?: string;
  params?: AuthorizeParams;
}

/**
 * Validate /authorize query params. `client` is the registered client (or null
 * if unknown). Returns params to carry through the login page on success.
 */
export function validateAuthorizeRequest(
  query: Record<string, string | undefined>,
  client: { redirectUris: string[] } | null,
): AuthorizeValidation {
  const clientId = query.client_id || "";
  const redirectUri = query.redirect_uri || "";
  if (!clientId || !client) {
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_client",
      error_description: "Unknown or missing client_id",
    };
  }
  if (!redirectUri || !matchRedirectUri(redirectUri, client.redirectUris)) {
    return {
      ok: false,
      kind: "fatal",
      error: "invalid_request",
      error_description: "redirect_uri does not match a registered URI",
    };
  }
  // From here, errors can be redirected back to the (validated) redirect_uri.
  const responseType = query.response_type || "";
  if (responseType !== "code") {
    return {
      ok: false,
      kind: "redirect",
      error: "unsupported_response_type",
      error_description: "Only response_type=code is supported",
    };
  }
  const codeChallenge = query.code_challenge || "";
  const codeChallengeMethod = query.code_challenge_method || "";
  if (!codeChallenge) {
    return {
      ok: false,
      kind: "redirect",
      error: "invalid_request",
      error_description: "PKCE code_challenge is required",
    };
  }
  if (codeChallengeMethod !== "S256") {
    return {
      ok: false,
      kind: "redirect",
      error: "invalid_request",
      error_description: "Only code_challenge_method=S256 is supported",
    };
  }
  return {
    ok: true,
    params: {
      responseType,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      state: query.state || "",
      scope: query.scope || MCP_SCOPE,
      resource: query.resource || "",
    },
  };
}

/** Append query params to a redirect URI, preserving any it already has. */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.searchParams.set(k, v);
  }
  return u.toString();
}

export function buildSuccessRedirect(
  redirectUri: string,
  code: string,
  state: string,
): string {
  return buildRedirect(redirectUri, { code, state });
}

export function buildErrorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string,
): string {
  return buildRedirect(redirectUri, {
    error,
    error_description: description,
    state,
  });
}

// ---------------------------------------------------------------------
// /token request validation
// ---------------------------------------------------------------------

export interface TokenValidation {
  ok: boolean;
  error?: string;
  error_description?: string;
  grantType?: "authorization_code" | "refresh_token";
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  refreshToken?: string;
  clientId?: string;
  resource?: string;
}

/** Validate/normalise a token request form (application/x-www-form-urlencoded). */
export function parseTokenRequest(
  form: Record<string, string | undefined>,
): TokenValidation {
  const grantType = form.grant_type || "";
  const clientId = form.client_id || "";
  const resource = form.resource || "";
  if (grantType === "authorization_code") {
    const code = form.code || "";
    const codeVerifier = form.code_verifier || "";
    if (!code)
      return {
        ok: false,
        error: "invalid_request",
        error_description: "code is required",
      };
    if (!codeVerifier)
      return {
        ok: false,
        error: "invalid_request",
        error_description: "code_verifier is required (PKCE)",
      };
    return {
      ok: true,
      grantType,
      code,
      codeVerifier,
      redirectUri: form.redirect_uri || "",
      clientId,
      resource,
    };
  }
  if (grantType === "refresh_token") {
    const refreshToken = form.refresh_token || "";
    if (!refreshToken)
      return {
        ok: false,
        error: "invalid_request",
        error_description: "refresh_token is required",
      };
    return { ok: true, grantType, refreshToken, clientId, resource };
  }
  return {
    ok: false,
    error: "unsupported_grant_type",
    error_description: `Unsupported grant_type: ${grantType || "(none)"}`,
  };
}

/** Shape a successful token response. */
export function buildTokenResponse(
  accessToken: string,
  refreshToken: string,
  scope: string,
) {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    scope: scope || MCP_SCOPE,
  };
}
