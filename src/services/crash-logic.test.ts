import { describe, it, expect } from "vitest";
import {
  environmentName,
  stripQuery,
  shouldInit,
  scrubEvent,
  type ScrubbableEvent,
} from "./crash-logic";

describe("environmentName", () => {
  it("returns beta for any version containing 'beta'", () => {
    expect(environmentName("0.6.0-beta.40")).toBe("beta");
    expect(environmentName("1.0.0-beta")).toBe("beta");
  });
  it("returns stable otherwise", () => {
    expect(environmentName("0.6.0")).toBe("stable");
    expect(environmentName("1.2.3")).toBe("stable");
    expect(environmentName("")).toBe("stable");
  });
});

describe("stripQuery", () => {
  it("drops the query string", () => {
    expect(stripQuery("https://a.b/p/doc123?token=secret")).toBe(
      "https://a.b/p/doc123",
    );
  });
  it("drops the fragment (share links put the token in #)", () => {
    expect(stripQuery("https://a.b/p/doc123#token=secret")).toBe(
      "https://a.b/p/doc123",
    );
  });
  it("cuts at whichever of ? or # comes first", () => {
    expect(stripQuery("https://a.b/p/doc#frag?q=1")).toBe("https://a.b/p/doc");
    expect(stripQuery("https://a.b/p/doc?q=1#frag")).toBe("https://a.b/p/doc");
  });
  it("leaves URLs without a query or fragment untouched", () => {
    expect(stripQuery("https://a.b/p/doc123")).toBe("https://a.b/p/doc123");
  });
  it("passes through non-strings unchanged", () => {
    expect(stripQuery(undefined)).toBe(undefined);
    expect(stripQuery(null)).toBe(null);
    expect(stripQuery(42)).toBe(42);
  });
});

describe("shouldInit", () => {
  it("requires both a DSN and consent", () => {
    expect(shouldInit("https://k@h/1", true)).toBe(true);
    expect(shouldInit("https://k@h/1", false)).toBe(false);
    expect(shouldInit("", true)).toBe(false);
    expect(shouldInit("", false)).toBe(false);
  });
});

describe("scrubEvent", () => {
  it("strips request cookies/data/headers/query_string and the URL query", () => {
    const e: ScrubbableEvent = {
      request: {
        url: "https://markflow.jp/p/doc42?token=abc",
        cookies: { session: "xyz" },
        data: { title: "private note", body: "secret content" },
        headers: { Authorization: "Bearer xxx" },
        query_string: "token=abc",
      },
    };
    const out = scrubEvent(e);
    expect(out.request?.url).toBe("https://markflow.jp/p/doc42");
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.headers).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
  });

  it("reduces the user to the id only (drops email/username/ip)", () => {
    const out = scrubEvent({
      user: {
        id: "uid-123",
        email: "someone@example.com",
        username: "someone",
        ip_address: "1.2.3.4",
      },
    });
    expect(out.user).toEqual({ id: "uid-123" });
  });

  it("empties the user object when no id is present", () => {
    const out = scrubEvent({ user: { email: "someone@example.com" } });
    expect(out.user).toEqual({});
  });

  it("strips query strings and fragments from breadcrumb URLs", () => {
    const out = scrubEvent({
      breadcrumbs: [
        { data: { url: "https://markflow.jp/p/doc9?secret=1", method: "GET" } },
        { data: { url: "https://markflow.jp/p/doc9#token=1" } },
        null,
        undefined,
        { data: {} },
      ],
    });
    expect(out.breadcrumbs?.[0]?.data?.url).toBe("https://markflow.jp/p/doc9");
    expect(out.breadcrumbs?.[1]?.data?.url).toBe("https://markflow.jp/p/doc9");
    // Non-url breadcrumb data is preserved.
    expect(out.breadcrumbs?.[0]?.data?.method).toBe("GET");
  });

  it("drops console breadcrumb message + arguments (may embed doc content)", () => {
    const out = scrubEvent({
      breadcrumbs: [
        {
          category: "console",
          level: "log",
          message: "secret document text that was console.logged",
          data: { arguments: ["secret document text"], logger: "console" },
        },
      ],
    });
    const b = out.breadcrumbs?.[0];
    expect(b?.message).toBeUndefined();
    expect(b?.data?.arguments).toBeUndefined();
    // Non-leaking metadata survives for triage.
    expect(b?.data?.logger).toBe("console");
  });

  it("redacts attribute values in DOM (ui.*) breadcrumb selectors", () => {
    const out = scrubEvent({
      breadcrumbs: [
        {
          category: "ui.click",
          message: 'button[aria-label="Delete private note"][title="x"]',
        },
      ],
    });
    expect(out.breadcrumbs?.[0]?.message).toBe("button[aria-label][title]");
  });

  it("strips query/fragment from navigation breadcrumb from/to URLs", () => {
    const out = scrubEvent({
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: "https://markflow.jp/p/a#token=1",
            to: "https://markflow.jp/p/b?secret=2",
          },
        },
      ],
    });
    expect(out.breadcrumbs?.[0]?.data?.from).toBe("https://markflow.jp/p/a");
    expect(out.breadcrumbs?.[0]?.data?.to).toBe("https://markflow.jp/p/b");
  });

  it("never throws and returns the same reference on odd input", () => {
    const e = {} as ScrubbableEvent;
    expect(scrubEvent(e)).toBe(e);
    // Frozen request would make delete throw — scrub must swallow it.
    const frozen: ScrubbableEvent = {
      request: Object.freeze({ url: "https://a.b/x?y=1", cookies: { a: 1 } }),
    };
    expect(() => scrubEvent(frozen)).not.toThrow();
  });
});
