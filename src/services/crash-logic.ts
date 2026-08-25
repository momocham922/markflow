// =====================================================================
// Pure, dependency-free crash-report helpers.
// ---------------------------------------------------------------------
// Kept firebase/sentry-free (like services/consent-region.ts) so the
// privacy-critical scrubbing can be unit-tested in vitest without booting
// Firebase / Tauri. crash.ts wires these into the Sentry SDK.
// =====================================================================

export function environmentName(version: string): "beta" | "stable" {
  return (version || "").includes("beta") ? "beta" : "stable";
}

/**
 * Drop the query string AND the fragment from a URL. Both can carry secrets:
 * query strings hold doc ids / tokens, and share links put the access token in
 * the `#fragment` (e.g. `/p/abc#token=...`). Cut at whichever comes first.
 */
export function stripQuery(url: unknown): unknown {
  if (typeof url !== "string") return url;
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

/** Crash reporting only runs with a DSN compiled in AND user consent. */
export function shouldInit(dsn: string, consent: boolean): boolean {
  return !!dsn && consent;
}

// Structural subset of a Sentry event we scrub. Loose on purpose so it survives
// SDK type churn — crash.ts casts its Sentry event through this shape.
export interface ScrubbableEvent {
  request?: {
    url?: string;
    cookies?: unknown;
    data?: unknown;
    headers?: unknown;
    query_string?: unknown;
  };
  user?: ({ id?: string } & Record<string, unknown>) | null;
  breadcrumbs?: Array<
    | ({
        category?: string;
        message?: string;
        data?: {
          url?: unknown;
          from?: unknown;
          to?: unknown;
          arguments?: unknown;
        } & Record<string, unknown>;
      } & Record<string, unknown>)
    | null
    | undefined
  >;
  [k: string]: unknown;
}

/**
 * Remove anything that could carry document content, auth tokens or PII before
 * an event leaves the device: request cookies/body/headers/query, all user
 * fields except the Firebase uid, and — for every breadcrumb — logged console
 * values, DOM selector attribute values, and query/fragment on any URL.
 *
 * This is defense-in-depth: crash.ts ALSO disables console/dom/history
 * breadcrumbs at the SDK source. If that source guard ever regresses (SDK
 * upgrade, a new integration, hand-added breadcrumbs) this loop still strips
 * the leak-prone fields. Never throws — a scrub failure must not silently drop
 * the event.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  try {
    if (event.request) {
      delete event.request.cookies;
      delete event.request.data;
      delete event.request.headers;
      event.request.url = stripQuery(event.request.url) as string | undefined;
      if (event.request.query_string) delete event.request.query_string;
    }
    if (event.user) {
      event.user = event.user.id ? { id: event.user.id } : {};
    }
    if (Array.isArray(event.breadcrumbs)) {
      for (const b of event.breadcrumbs) {
        if (!b) continue;
        const category = typeof b.category === "string" ? b.category : "";
        // console.* breadcrumbs capture logged values verbatim — a stray
        // console.log(docContent) would ship the document. Drop the rendered
        // message and the raw arguments outright.
        if (category === "console") {
          delete b.message;
          if (b.data) delete b.data.arguments;
        }
        // DOM (ui.click / ui.input) breadcrumbs store a CSS-selector path that
        // can embed attribute VALUES (aria-label/title/alt/…) which are often
        // user text. Redact the values, keep the attribute names for triage.
        if (category.startsWith("ui.") && typeof b.message === "string") {
          b.message = b.message.replace(
            /\[(aria-label|title|alt|name|value|placeholder)="[^"]*"\]/g,
            "[$1]",
          );
        }
        if (b.data) {
          if (typeof b.data.url === "string") {
            b.data.url = stripQuery(b.data.url) as string;
          }
          // navigation breadcrumbs store from/to URLs — same token/fragment
          // risk as request.url.
          if (typeof b.data.from === "string") {
            b.data.from = stripQuery(b.data.from) as string;
          }
          if (typeof b.data.to === "string") {
            b.data.to = stripQuery(b.data.to) as string;
          }
        }
      }
    }
  } catch {
    /* never drop the event on scrub failure */
  }
  return event;
}
