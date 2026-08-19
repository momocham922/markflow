/**
 * Sanitize custom-theme CSS variables before they are interpolated into a
 * <style> block.
 *
 * An imported theme JSON (ThemeCustomizer) is untrusted input. Without filtering,
 * a crafted value like `red; } body { display:none } .x{color:red` or one
 * containing `</style><script>…` would break out of the single declaration and
 * inject arbitrary CSS — or HTML/script in the published static page. This is a
 * CSS-injection vector, so every value must be constrained to a single, inert
 * declaration.
 *
 * Allowlist:
 *  - key must be a CSS custom property: `--[A-Za-z0-9-]+`
 *  - value must not contain characters that let it escape one declaration:
 *    `; { } < > @`, CSS comments, or `</style>`.
 *  - value must not contain a backslash. CSS escapes (`\75rl(...)` → `url(...)`)
 *    would otherwise smuggle a resource-fetching function past a substring check,
 *    so we reject `\` outright rather than trying to decode it.
 *  - every `(` must belong to an allowlisted, non-fetching function. This blocks
 *    `url()`, `image()`, `image-set()`, `-webkit-image-set()`, `cross-fade()`,
 *    `element()`, `paint()`, `src()` etc. — anything that can pull an external
 *    resource and leak a viewer's IP from the published page or live preview —
 *    while still allowing `oklch()/rgb()/rgba()/hsl()/calc()/var()/gradients`.
 *    Commas / spaces / quotes / `#` / `%` are kept so color functions and
 *    font-family stacks still work.
 */
const THEME_VAR_KEY_RE = /^--[A-Za-z0-9-]+$/;
// Structural escape characters + comment/style-close markers. Backslash is
// rejected separately so escape sequences can't reconstruct a blocked token.
const THEME_VAR_UNSAFE_RE = /[;{}<>@\\]|\/\*|\*\/|<\/style/i;

// CSS functions that CANNOT fetch an external resource. Any `(` in a value must
// be preceded by one of these (case-insensitive); otherwise the value is dropped.
const SAFE_CSS_FUNCTIONS = new Set([
  // color
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "oklch",
  "oklab",
  "lab",
  "lch",
  "color",
  "color-mix",
  // math
  "calc",
  "clamp",
  "min",
  "max",
  "abs",
  "round",
  "mod",
  "rem",
  // custom-prop / env
  "var",
  "env",
  // gradients (paint only, no network)
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "repeating-conic-gradient",
]);

const FN_BEFORE_PAREN_RE = /(-?[A-Za-z][A-Za-z0-9-]*)?\(/g;

/** True if every `(` in the value is introduced by an allowlisted safe function. */
function hasOnlySafeFunctions(value: string): boolean {
  let totalParens = 0;
  for (const ch of value) if (ch === "(") totalParens++;
  if (totalParens === 0) return true;

  let safeParens = 0;
  FN_BEFORE_PAREN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_BEFORE_PAREN_RE.exec(value)) !== null) {
    const fn = m[1];
    if (fn && SAFE_CSS_FUNCTIONS.has(fn.toLowerCase())) safeParens++;
  }
  // A bare `(` (no function name) or any unlisted function leaves a shortfall.
  return safeParens === totalParens;
}

export function sanitizeThemeVars(
  vars: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== "object") return out;
  for (const [k, v] of Object.entries(vars)) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    if (!THEME_VAR_KEY_RE.test(k)) continue;
    if (THEME_VAR_UNSAFE_RE.test(v)) continue;
    if (!hasOnlySafeFunctions(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Build the `  --k: v;` declaration lines for a <style> block, sanitized. */
export function buildThemeVarLines(
  vars: Record<string, unknown> | null | undefined,
): string {
  return Object.entries(sanitizeThemeVars(vars))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
}

/** True if every entry of an object is a string keyed by a valid CSS custom property. */
export function isValidThemeVarMap(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
    if (!THEME_VAR_KEY_RE.test(k)) return false;
  }
  return true;
}
