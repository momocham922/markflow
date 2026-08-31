import { describe, it, expect } from "vitest";
import {
  normalizeFeedbackKind,
  redactPII,
  sanitizeMessage,
  sanitizeError,
  normalizeForFingerprint,
  feedbackFingerprint,
  shouldNotifyFeedback,
  maskEmail,
  feedbackColor,
  feedbackKindLabel,
  buildFeedbackSlackPayload,
  MAX_MESSAGE,
  MAX_ERROR,
} from "./feedback";

describe("normalizeFeedbackKind", () => {
  it("accepts the closed set", () => {
    expect(normalizeFeedbackKind("bug")).toBe("bug");
    expect(normalizeFeedbackKind("idea")).toBe("idea");
    expect(normalizeFeedbackKind("other")).toBe("other");
  });
  it("is case/space tolerant", () => {
    expect(normalizeFeedbackKind("  BUG ")).toBe("bug");
    expect(normalizeFeedbackKind("Idea")).toBe("idea");
  });
  it("defaults unknown/garbage to other", () => {
    expect(normalizeFeedbackKind("feature")).toBe("other");
    expect(normalizeFeedbackKind(null)).toBe("other");
    expect(normalizeFeedbackKind(undefined)).toBe("other");
    expect(normalizeFeedbackKind(42)).toBe("other");
    expect(normalizeFeedbackKind({})).toBe("other");
  });
});

describe("redactPII", () => {
  it("redacts email addresses", () => {
    expect(redactPII("contact me at foo.bar+x@example.co.jp please")).toBe(
      "contact me at [email] please",
    );
  });
  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ1234";
    expect(redactPII(`token ${jwt} end`)).toBe("token [token] end");
  });
  it("redacts Bearer tokens", () => {
    expect(redactPII("Authorization: Bearer abc.def-ghi_123")).toBe(
      "Authorization: Bearer [token]",
    );
  });
  it("redacts common API-key shapes", () => {
    expect(redactPII("key AIzaSyD-1234567890abcdEFG here")).toBe(
      "key [key] here",
    );
    expect(redactPII("stripe sk_live_abcDEF123456 secret")).toBe(
      "stripe [key] secret",
    );
    expect(redactPII("gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 tok")).toBe(
      "gh [key] tok",
    );
  });
  it("redacts long digit runs (card/phone/long id)", () => {
    expect(redactPII("card 4111 1111 1111 1111 exp")).toBe("card [number] exp");
    expect(redactPII("id 1234567890123456")).toBe("id [number]");
  });
  it("leaves short numbers and normal prose intact", () => {
    expect(redactPII("crashed on line 42 after 3 clicks")).toBe(
      "crashed on line 42 after 3 clicks",
    );
    expect(redactPII("保存ボタンが効かない")).toBe("保存ボタンが効かない");
  });
  it("is null/undefined safe", () => {
    expect(redactPII(undefined as unknown as string)).toBe("");
    expect(redactPII(null as unknown as string)).toBe("");
  });
});

describe("sanitizeMessage / sanitizeError", () => {
  it("trims, redacts, and clamps message length", () => {
    const long = "a".repeat(MAX_MESSAGE + 500);
    const out = sanitizeMessage(`  ${long}  `);
    expect(out.length).toBe(MAX_MESSAGE);
  });
  it("clamps error length independently", () => {
    const long = "b".repeat(MAX_ERROR + 500);
    expect(sanitizeError(long).length).toBe(MAX_ERROR);
  });
  it("redacts inside the clamped message", () => {
    expect(sanitizeMessage("my email is a@b.com  ")).toBe(
      "my email is [email]",
    );
  });
});

describe("normalizeForFingerprint", () => {
  it("strips numbers so line-number variants group together", () => {
    expect(normalizeForFingerprint("Error at line 42")).toBe(
      normalizeForFingerprint("Error at line 9999"),
    );
  });
  it("strips uuids, hex addrs, urls, punctuation", () => {
    const a = normalizeForFingerprint(
      "crash 0xdeadbeef at https://x.test/a?b=1 id 550e8400-e29b-41d4-a716-446655440000!!!",
    );
    const b = normalizeForFingerprint("crash    at   id");
    expect(a).toBe(b);
  });
  it("keeps Japanese text", () => {
    expect(normalizeForFingerprint("保存できない！！ 123")).toBe(
      "保存できない",
    );
  });
  it("bounds length to 200", () => {
    expect(
      normalizeForFingerprint("word ".repeat(200)).length,
    ).toBeLessThanOrEqual(200);
  });
});

describe("feedbackFingerprint", () => {
  it("is stable and 16 hex chars", () => {
    const fp = feedbackFingerprint("bug", "0.6.0", "save button broken");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(feedbackFingerprint("bug", "0.6.0", "save button broken")).toBe(fp);
  });
  it("groups near-identical messages (numbers differ)", () => {
    expect(feedbackFingerprint("bug", "0.6.0", "crash at line 10")).toBe(
      feedbackFingerprint("bug", "0.6.0", "crash at line 20"),
    );
  });
  it("separates different kinds", () => {
    expect(feedbackFingerprint("bug", "0.6.0", "x y z")).not.toBe(
      feedbackFingerprint("idea", "0.6.0", "x y z"),
    );
  });
  it("separates different app versions", () => {
    expect(feedbackFingerprint("bug", "0.6.0", "x y z")).not.toBe(
      feedbackFingerprint("bug", "0.7.0", "x y z"),
    );
  });
});

describe("shouldNotifyFeedback", () => {
  it("always notifies a new group", () => {
    expect(shouldNotifyFeedback(1, true)).toBe(true);
  });
  it("notifies at the 5th and 25th occurrence", () => {
    expect(shouldNotifyFeedback(5, false)).toBe(true);
    expect(shouldNotifyFeedback(25, false)).toBe(true);
  });
  it("is quiet on non-threshold counts", () => {
    expect(shouldNotifyFeedback(2, false)).toBe(false);
    expect(shouldNotifyFeedback(6, false)).toBe(false);
    expect(shouldNotifyFeedback(26, false)).toBe(false);
  });
});

describe("maskEmail", () => {
  it("masks the local part, keeps the domain", () => {
    expect(maskEmail("ryouhei@gmail.com")).toBe("ry***@gmail.com");
  });
  it("handles very short local parts", () => {
    expect(maskEmail("a@b.com")).toBe("a***@b.com");
  });
  it("degrades gracefully on non-emails", () => {
    expect(maskEmail("notanemail")).toBe("[email]");
    expect(maskEmail("")).toBe("");
  });
});

describe("feedbackColor", () => {
  it("maps kind → color band", () => {
    expect(feedbackColor("bug", 1)).toBe("danger");
    expect(feedbackColor("idea", 1)).toBe("good");
    expect(feedbackColor("other", 1)).toBe("warning");
  });
  it("escalates a hot group (>=25) to danger regardless of kind", () => {
    expect(feedbackColor("idea", 25)).toBe("danger");
    expect(feedbackColor("other", 30)).toBe("danger");
  });
});

describe("feedbackKindLabel", () => {
  it("localizes each kind", () => {
    expect(feedbackKindLabel("bug")).toBe("バグ報告");
    expect(feedbackKindLabel("idea")).toBe("要望・アイデア");
    expect(feedbackKindLabel("other")).toBe("その他");
  });
});

describe("buildFeedbackSlackPayload", () => {
  const base = {
    kind: "bug" as const,
    count: 1,
    isNew: true,
    message: "save button broken",
    plan: "pro",
    appVersion: "0.6.0",
    platform: "macos",
    email: "ryouhei@gmail.com",
    fingerprint: "abc123def4567890",
  };

  it("carries the color band and no emoji", () => {
    const p = buildFeedbackSlackPayload(base) as any;
    expect(p.attachments[0].color).toBe("danger");
    const json = JSON.stringify(p);
    // no emoji shortcodes / pictographs in the payload
    expect(json).not.toMatch(/:[a-z_]+:/);
  });

  it("masks the reporter email", () => {
    const json = JSON.stringify(buildFeedbackSlackPayload(base));
    expect(json).toContain("ry***@gmail.com");
    expect(json).not.toContain("ryouhei@gmail.com");
  });

  it("titles new vs repeat groups", () => {
    const fresh = buildFeedbackSlackPayload(base) as any;
    expect(fresh.attachments[0].blocks[0].text.text).toContain("新規");
    const repeat = buildFeedbackSlackPayload({
      ...base,
      isNew: false,
      count: 5,
    }) as any;
    expect(repeat.attachments[0].blocks[0].text.text).toContain("5件目");
  });

  it("truncates a long excerpt", () => {
    const p = buildFeedbackSlackPayload({
      ...base,
      message: "x".repeat(900),
    }) as any;
    expect(p.attachments[0].blocks[1].text.text.endsWith("…")).toBe(true);
  });

  it("falls back to a placeholder for an empty body", () => {
    const p = buildFeedbackSlackPayload({ ...base, message: "" }) as any;
    expect(p.attachments[0].blocks[1].text.text).toBe("(本文なし)");
  });
});
