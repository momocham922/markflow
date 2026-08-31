import { describe, it, expect } from "vitest";
import {
  consentRegionFor,
  consentModeFor,
  defaultConsent,
  detectRegion,
} from "./consent-region";

describe("consentRegionFor", () => {
  it("classifies EU/EEA/UK/CH as eu (case-insensitive)", () => {
    for (const cc of ["DE", "FR", "de", "gb", "CH", "NO", "IE", "is", "li"]) {
      expect(consentRegionFor(cc)).toBe("eu");
    }
  });
  it("classifies JP as jp", () => {
    expect(consentRegionFor("JP")).toBe("jp");
    expect(consentRegionFor("jp")).toBe("jp");
  });
  it("classifies US/other/empty as other", () => {
    expect(consentRegionFor("US")).toBe("other");
    expect(consentRegionFor("CA")).toBe("other");
    expect(consentRegionFor("")).toBe("other");
  });
});

describe("consentModeFor", () => {
  it("maps region → legal mode", () => {
    expect(consentModeFor("eu")).toBe("opt_in");
    expect(consentModeFor("jp")).toBe("opt_out");
    expect(consentModeFor("other")).toBe("notice");
  });
});

describe("defaultConsent", () => {
  it("defaults OFF only in the EU", () => {
    expect(defaultConsent("eu")).toBe(false);
    expect(defaultConsent("jp")).toBe(true);
    expect(defaultConsent("other")).toBe(true);
  });
});

describe("detectRegion", () => {
  it("uses an explicit EU region subtag", () => {
    expect(detectRegion({ language: "de-DE", languages: ["de-DE"] }, "")).toBe(
      "eu",
    );
    expect(detectRegion({ language: "en-GB", languages: ["en-GB"] }, "")).toBe(
      "eu",
    );
  });
  it("uses an explicit JP region subtag", () => {
    expect(detectRegion({ language: "ja-JP", languages: ["ja-JP"] }, "")).toBe(
      "jp",
    );
  });
  it("treats en-US as other", () => {
    expect(detectRegion({ language: "en-US", languages: ["en-US"] }, "")).toBe(
      "other",
    );
  });
  it("falls back to timezone when no region subtag", () => {
    expect(
      detectRegion({ language: "en", languages: ["en"] }, "Europe/Berlin"),
    ).toBe("eu");
    expect(
      detectRegion({ language: "en", languages: ["en"] }, "Asia/Tokyo"),
    ).toBe("jp");
    expect(
      detectRegion({ language: "en", languages: ["en"] }, "America/New_York"),
    ).toBe("other");
  });
  it("conservatively treats an EU base language as eu", () => {
    // No region subtag, non-Europe tz, but a clearly-EU language → opt-in safe.
    expect(detectRegion({ language: "fr", languages: ["fr"] }, "UTC")).toBe(
      "eu",
    );
    expect(detectRegion({ language: "ja", languages: ["ja"] }, "UTC")).toBe(
      "jp",
    );
  });
  it("prefers an EU region subtag found later in navigator.languages", () => {
    expect(
      detectRegion({ language: "en", languages: ["en", "fr-FR"] }, "UTC"),
    ).toBe("eu");
  });
  it("falls back to eu (strictest) when nothing is readable", () => {
    expect(detectRegion({ language: "", languages: [] }, "")).toBe("eu");
  });
  it("a non-EU subtag does NOT block an EU-timezone upgrade (GDPR-conservative)", () => {
    // en-US subtag classifies "other" but does NOT short-circuit; a Europe/* tz
    // then upgrades to eu (an EU-located user must get opt-in regardless of UI
    // language). Only an explicit EU/JP subtag returns immediately.
    expect(
      detectRegion({ language: "en-US", languages: ["en-US"] }, "Europe/Paris"),
    ).toBe("eu");
    // A non-EU subtag with a non-EU tz stays other.
    expect(
      detectRegion(
        { language: "en-US", languages: ["en-US"] },
        "America/New_York",
      ),
    ).toBe("other");
  });
});
