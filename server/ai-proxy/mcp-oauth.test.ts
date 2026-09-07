import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  base64url,
  sha256base64url,
  hashToken,
  newOpaqueToken,
  verifyPkceS256,
  pickClientIp,
  deriveBaseUrl,
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
  isValidRedirectUri,
  isAllowedRedirectUri,
  allowedRedirectHosts,
  matchRedirectUri,
  validateDcrRequest,
  buildDcrResponse,
  validateAuthorizeRequest,
  buildSuccessRedirect,
  buildErrorRedirect,
  parseTokenRequest,
  buildTokenResponse,
  ACCESS_TTL_SEC,
  MCP_PATH,
  MCP_SCOPE,
} from "./mcp-oauth";

describe("crypto helpers", () => {
  it("sha256base64url matches a known PKCE vector (RFC 7636 appendix B)", () => {
    // verifier + expected challenge from RFC 7636.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(sha256base64url(verifier)).toBe(expected);
  });
  it("verifyPkceS256 accepts a matching pair and rejects mismatches", () => {
    const verifier = base64url(randomBytes(32)); // 43 chars
    const challenge = sha256base64url(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(verifier, "wrong")).toBe(false);
    expect(verifyPkceS256("", challenge)).toBe(false);
  });
  it("verifyPkceS256 rejects out-of-spec verifier length", () => {
    const short = "abc";
    expect(verifyPkceS256(short, sha256base64url(short))).toBe(false);
    const long = "a".repeat(129);
    expect(verifyPkceS256(long, sha256base64url(long))).toBe(false);
  });
  it("hashToken is stable, hex, and never returns the raw secret", () => {
    const t = "super-secret-token";
    expect(hashToken(t)).toBe(createHash("sha256").update(t).digest("hex"));
    expect(hashToken(t)).not.toContain(t);
  });
  it("newOpaqueToken yields 43-char url-safe unique strings", () => {
    const a = newOpaqueToken();
    const b = newOpaqueToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("base64url has no padding or url-unsafe chars", () => {
    expect(base64url(Buffer.from([255, 255, 255]))).not.toMatch(/[+/=]/);
  });
});

describe("pickClientIp", () => {
  it("takes the RIGHTMOST XFF entry (the one trusted infra appended)", () => {
    // A caller can prepend spoofed IPs on the left; Google's LB appends the
    // real client IP to the right. Rate-limit keys must use the rightmost.
    expect(pickClientIp("1.1.1.1, 2.2.2.2, 3.3.3.3")).toBe("3.3.3.3");
    expect(pickClientIp("9.9.9.9")).toBe("9.9.9.9");
  });
  it("ignores an attacker-prepended spoof", () => {
    // Attacker sets XFF: "127.0.0.1" hoping to look like loopback / dodge caps;
    // the real edge appends the true client after it.
    expect(pickClientIp("127.0.0.1, 203.0.113.7")).toBe("203.0.113.7");
  });
  it("handles array-valued headers by joining then taking the rightmost", () => {
    expect(pickClientIp(["1.1.1.1, 2.2.2.2", "3.3.3.3"])).toBe("3.3.3.3");
  });
  it("trims whitespace and skips empty segments", () => {
    expect(pickClientIp("  1.1.1.1 ,  , 2.2.2.2  ")).toBe("2.2.2.2");
  });
  it("falls back to the socket address when XFF is absent", () => {
    expect(pickClientIp(undefined, "10.0.0.5")).toBe("10.0.0.5");
    expect(pickClientIp("", "10.0.0.5")).toBe("10.0.0.5");
  });
  it("returns 'unknown' when nothing is available", () => {
    expect(pickClientIp(undefined)).toBe("unknown");
    expect(pickClientIp("   ")).toBe("unknown");
  });
});

describe("deriveBaseUrl", () => {
  it("prefers x-forwarded-host/proto, defaults proto to https", () => {
    expect(
      deriveBaseUrl({
        host: "internal:8080",
        "x-forwarded-host": "markflow.jp",
        "x-forwarded-proto": "https",
      }),
    ).toBe("https://markflow.jp");
    expect(deriveBaseUrl({ host: "svc-abc-an.a.run.app" })).toBe(
      "https://svc-abc-an.a.run.app",
    );
  });
});

describe("discovery metadata", () => {
  const base = "https://svc-abc-an.a.run.app";
  it("PRM points at the MCP resource + this AS", () => {
    const prm = buildProtectedResourceMetadata(base);
    expect(prm.resource).toBe(`${base}${MCP_PATH}`);
    expect(prm.authorization_servers).toEqual([base]);
    expect(prm.scopes_supported).toContain(MCP_SCOPE);
  });
  it("AS metadata advertises S256-only PKCE + public client auth", () => {
    const asm = buildAuthServerMetadata(base);
    expect(asm.issuer).toBe(base);
    expect(asm.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(asm.token_endpoint).toBe(`${base}/oauth/token`);
    expect(asm.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asm.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(asm.grant_types_supported).toContain("refresh_token");
  });
});

describe("redirect uri validation", () => {
  it("accepts https anywhere and http loopback only", () => {
    expect(isValidRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(
      true,
    );
    expect(isValidRedirectUri("http://localhost:1234/cb")).toBe(true);
    expect(isValidRedirectUri("http://127.0.0.1:55555/cb")).toBe(true);
    expect(isValidRedirectUri("http://evil.com/cb")).toBe(false);
    expect(isValidRedirectUri("ftp://x/cb")).toBe(false);
    expect(isValidRedirectUri("not a url")).toBe(false);
  });
  it("allowlist accepts only Claude hosts + loopback, rejects other https", () => {
    const hosts = allowedRedirectHosts();
    // Confused-deputy fix: an arbitrary https redirect is NO LONGER accepted.
    expect(isAllowedRedirectUri("https://evil.com/cb", hosts)).toBe(false);
    expect(
      isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", hosts),
    ).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/cb", hosts)).toBe(true);
    // impostor subdomain must not match
    expect(isAllowedRedirectUri("https://claude.ai.evil.com/cb", hosts)).toBe(
      false,
    );
    // loopback (any port) always allowed for native clients
    expect(isAllowedRedirectUri("http://127.0.0.1:49999/cb", hosts)).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:1234/cb", hosts)).toBe(true);
    // non-loopback http rejected
    expect(isAllowedRedirectUri("http://evil.com/cb", hosts)).toBe(false);
  });
  it("allowedRedirectHosts merges extra hosts from config", () => {
    const hosts = allowedRedirectHosts("Example.COM, foo.test");
    expect(isAllowedRedirectUri("https://example.com/cb", hosts)).toBe(true);
    expect(isAllowedRedirectUri("https://foo.test/cb", hosts)).toBe(true);
    expect(isAllowedRedirectUri("https://bar.test/cb", hosts)).toBe(false);
  });
  it("matchRedirectUri is exact for https, port-agnostic for loopback", () => {
    const reg = [
      "https://claude.ai/api/mcp/auth_callback",
      "http://127.0.0.1:8080/cb",
    ];
    expect(
      matchRedirectUri("https://claude.ai/api/mcp/auth_callback", reg),
    ).toBe(true);
    expect(matchRedirectUri("https://claude.ai/api/mcp/other", reg)).toBe(
      false,
    );
    // loopback: different port still matches (RFC 8252)
    expect(matchRedirectUri("http://127.0.0.1:49999/cb", reg)).toBe(true);
    // loopback: different path does NOT match
    expect(matchRedirectUri("http://127.0.0.1:49999/evil", reg)).toBe(false);
    // non-loopback impostor never matches on port rule
    expect(
      matchRedirectUri("https://claude.ai.evil.com/api/mcp/auth_callback", reg),
    ).toBe(false);
  });
});

describe("DCR", () => {
  it("requires a non-empty redirect_uris array", () => {
    expect(validateDcrRequest({}).ok).toBe(false);
    expect(validateDcrRequest({ redirect_uris: [] }).ok).toBe(false);
  });
  it("rejects a disallowed redirect_uri (http non-loopback)", () => {
    const v = validateDcrRequest({ redirect_uris: ["http://evil.com/cb"] });
    expect(v.ok).toBe(false);
    expect(v.error).toBe("invalid_redirect_uri");
  });
  it("rejects an arbitrary https redirect_uri (confused-deputy fix)", () => {
    const v = validateDcrRequest({ redirect_uris: ["https://evil.com/cb"] });
    expect(v.ok).toBe(false);
    expect(v.error).toBe("invalid_redirect_uri");
  });
  it("accepts a valid public client and pins auth method to none", () => {
    const v = validateDcrRequest({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
      token_endpoint_auth_method: "client_secret_post", // requested confidential — ignored
    });
    expect(v.ok).toBe(true);
    expect(v.tokenEndpointAuthMethod).toBe("none");
    expect(v.redirectUris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });
  it("buildDcrResponse omits any client_secret", () => {
    const r = buildDcrResponse(
      "cid123",
      ["https://claude.ai/api/mcp/auth_callback"],
      "Claude",
      1000,
    );
    expect(r).not.toHaveProperty("client_secret");
    expect(r.client_id).toBe("cid123");
    expect(r.token_endpoint_auth_method).toBe("none");
  });
});

describe("validateAuthorizeRequest", () => {
  const client = { redirectUris: ["https://claude.ai/api/mcp/auth_callback"] };
  const good = {
    response_type: "code",
    client_id: "cid",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: "abc",
    code_challenge_method: "S256",
    state: "xyz",
    resource: "https://svc/mcp",
  };
  it("fatals on unknown client (cannot redirect)", () => {
    const v = validateAuthorizeRequest(good, null);
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("fatal");
  });
  it("fatals on mismatched redirect_uri", () => {
    const v = validateAuthorizeRequest(
      { ...good, redirect_uri: "https://claude.ai/evil" },
      client,
    );
    expect(v.kind).toBe("fatal");
  });
  it("redirect-errors on non-code response_type", () => {
    const v = validateAuthorizeRequest(
      { ...good, response_type: "token" },
      client,
    );
    expect(v.kind).toBe("redirect");
    expect(v.error).toBe("unsupported_response_type");
  });
  it("requires S256 PKCE", () => {
    expect(
      validateAuthorizeRequest({ ...good, code_challenge: "" }, client).error,
    ).toBe("invalid_request");
    expect(
      validateAuthorizeRequest(
        { ...good, code_challenge_method: "plain" },
        client,
      ).error,
    ).toBe("invalid_request");
  });
  it("passes a valid request and carries params", () => {
    const v = validateAuthorizeRequest(good, client);
    expect(v.ok).toBe(true);
    expect(v.params?.codeChallenge).toBe("abc");
    expect(v.params?.state).toBe("xyz");
    expect(v.params?.scope).toBe(MCP_SCOPE);
  });
});

describe("redirect builders", () => {
  it("success redirect carries code + state", () => {
    const u = new URL(
      buildSuccessRedirect("https://claude.ai/cb", "CODE", "STATE"),
    );
    expect(u.searchParams.get("code")).toBe("CODE");
    expect(u.searchParams.get("state")).toBe("STATE");
  });
  it("error redirect carries error + state", () => {
    const u = new URL(
      buildErrorRedirect(
        "https://claude.ai/cb",
        "access_denied",
        "no",
        "STATE",
      ),
    );
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("STATE");
  });
});

describe("parseTokenRequest", () => {
  it("validates authorization_code grant", () => {
    const v = parseTokenRequest({
      grant_type: "authorization_code",
      code: "C",
      code_verifier: "V",
      redirect_uri: "https://x/cb",
      client_id: "cid",
    });
    expect(v.ok).toBe(true);
    expect(v.grantType).toBe("authorization_code");
    expect(v.code).toBe("C");
    expect(v.codeVerifier).toBe("V");
  });
  it("requires code + code_verifier", () => {
    expect(
      parseTokenRequest({
        grant_type: "authorization_code",
        code_verifier: "V",
      }).ok,
    ).toBe(false);
    expect(
      parseTokenRequest({ grant_type: "authorization_code", code: "C" }).ok,
    ).toBe(false);
  });
  it("validates refresh_token grant", () => {
    const v = parseTokenRequest({
      grant_type: "refresh_token",
      refresh_token: "R",
    });
    expect(v.ok).toBe(true);
    expect(v.refreshToken).toBe("R");
  });
  it("rejects unsupported grant types", () => {
    expect(parseTokenRequest({ grant_type: "password" }).error).toBe(
      "unsupported_grant_type",
    );
    expect(parseTokenRequest({}).error).toBe("unsupported_grant_type");
  });
});

describe("buildTokenResponse", () => {
  it("returns a bearer token with expiry + refresh + scope", () => {
    const r = buildTokenResponse("AT", "RT", "mcp");
    expect(r.token_type).toBe("Bearer");
    expect(r.access_token).toBe("AT");
    expect(r.refresh_token).toBe("RT");
    expect(r.expires_in).toBe(ACCESS_TTL_SEC);
    expect(r.scope).toBe("mcp");
  });
});
