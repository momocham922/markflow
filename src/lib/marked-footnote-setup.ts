import { marked } from "marked";
import markedFootnote from "marked-footnote";

// `marked` is a module-level singleton shared by the live preview (Editor.tsx)
// and the publish path (html-publish.ts). `marked.use()` is additive, so the
// footnote extension must be registered exactly once or it runs twice. This
// guard lets both call sites ask for it without double-registering.
let registered = false;

/**
 * Register GitHub-style footnote support ([^1] markers + a trailing
 * <section class="footnotes">) on the shared `marked` instance, once.
 * Refine now cites web-research supplements as footnotes rather than dumping
 * them into a trailing appendix (see server/ai-proxy/refine.ts rule 7).
 */
export function ensureMarkedFootnote(): void {
  if (registered) return;
  registered = true;
  marked.use(markedFootnote());
}
