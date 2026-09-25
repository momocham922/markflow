// =====================================================================
// Context slots — what Refine is allowed to ask an external MCP server
// ---------------------------------------------------------------------
// Refine has exactly ONE question for the outside world, arrived at by verifying
// three real meetings by hand (2026-09-16..21) and then measuring against a live
// server (2026-09-25):
//
//   messages — what was said around the recording, by whom, and when.
//
// "Who attended" was a second slot until the measurement killed it. Two
// independent findings: a real aggregator's calendar carries no attendee list at
// all (the producer keeps only summary/start/end), and an email-based check
// cannot tell an attendee from a name that merely appears in the window — probing
// the DROM meeting returned six addresses, every one of them a sender or CC on an
// UNRELATED mail thread that happened to arrive at the same time. Announcing
// "出席者が取れます" on that evidence would be a lie, and the participants are
// obtainable from messages anyway: the invitation six minutes before the meeting
// named all three people.
//
// A server that cannot answer either of these cannot improve a set of minutes,
// so MarkFlow does not keep it. That refusal IS the guidance: users learn what
// MarkFlow wants from what passes and what does not, without a curated list of
// blessed vendors.
//
// Slots are defined by the QUESTION and the SHAPE OF THE ANSWER, never by tool
// names, so a personal aggregator, a Google Calendar server and a hand-written
// one all qualify on equal terms.
//
// =====================================================================

// A union of one, kept as a union so a second slot can be added if something
// ever proves verifiable — but a slot only earns its place by passing against a
// real server, not by sounding useful.
export type SlotId = "messages";

export interface SlotSpec {
  id: SlotId;
  /** What Refine is asking, in the user's language. Shown in the UI. */
  question: string;
  /** Fields an answer must carry to be usable. Shown when a probe fails. */
  needs: string[];
  /** A server is only kept if it fills at least one required slot. */
  required: boolean;
}

export const SLOTS: Record<SlotId, SlotSpec> = {
  messages: {
    id: "messages",
    question: "録音の前後に、誰が・いつ・何をやりとりしたか",
    needs: ["発言者", "日時", "本文"],
    required: true,
  },
};

// ---------------------------------------------------------------------
// Probe window
// ---------------------------------------------------------------------

/**
 * How far around a recording the probe looks.
 *
 * Both bounds are taken from the DROM meeting (2026-09-18, recorded 15:00 to
 * roughly 15:40), where the two facts that actually corrected the minutes sat
 * outside the recording itself: the invitation naming all three participants
 * was posted at 14:54 — six minutes BEFORE — and the report that the X
 * pre-authorisation had been filed arrived at 16:01, twenty-one minutes AFTER
 * the recording stopped. A window that only covers the recording misses both.
 */
export const PROBE_BEFORE_MS = 60 * 60 * 1000; // 1h
export const PROBE_AFTER_MS = 2 * 60 * 60 * 1000; // 2h

export interface ProbeWindow {
  sinceMs: number;
  untilMs: number;
}

/**
 * The window to probe with, from a recording's timestamp (option C): a real
 * meeting the user actually held, so a non-empty answer is real evidence that
 * the server can answer the question Refine will ask — not merely that it
 * responds without erroring.
 */
export function probeWindow(recordedAtMs: number): ProbeWindow {
  return {
    sinceMs: recordedAtMs - PROBE_BEFORE_MS,
    untilMs: recordedAtMs + PROBE_AFTER_MS,
  };
}

// ---------------------------------------------------------------------
// Probe safety
// ---------------------------------------------------------------------

export interface McpToolInfo {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments, as the server declares it. */
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

/**
 * Probing means CALLING a stranger's tool for real, so only tools that declare
 * themselves read-only are ever invoked. A missing annotation is not treated as
 * read-only: an unannotated `send_message` would otherwise be "tested" by
 * sending a message. Servers that annotate nothing are reported as impossible
 * to verify rather than probed anyway.
 */
export function isProbeSafe(tool: McpToolInfo): boolean {
  return tool.annotations?.readOnlyHint === true;
}

// ---------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------

/** Date+time stamps, in the shapes real servers emit. */
const TIMESTAMP_PATTERNS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/g, // 2026-09-18 14:54 / ISO
  /\d{4}年\s?\d{1,2}月\s?\d{1,2}日/g, // 2026年9月18日
  /\b\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\b/g, // 09/18 14:54
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Evidence that a row is attributed to a PERSON.
 *
 * Needed because a timestamp alone does not make something a message: the same
 * aggregator renders calendar entries as "• DROM様 / rakumo/meeting ·
 * 2026-09-18 15:00 · 場所: カレンダー", which is dated, substantial, and has no
 * speaker at all. Accepting it would promise Refine "who said what" and hand it
 * a list of meeting titles.
 *
 * A server whose rows carry no recognisable attribution is refused, and told so
 * — better than silently feeding unattributed text into a set of minutes.
 */
const AUTHOR_LABEL_RE =
  /(?:^|[\s·|])(相手|差出人|発言者|投稿者|送信者|from|sender|author)\s*[:：]/gi;
const HANDLE_RE = /(?:^|\s)@[A-Za-z0-9_.-]{2,}/g;

export interface ProbeSignals {
  /** The tool reported a failure. */
  isError: boolean;
  /** Total characters of text in the result. */
  chars: number;
  /** Distinct date+time stamps found. */
  timestamps: number;
  /** Distinct email addresses found. */
  emails: number;
  /** Non-trivial lines — a rough stand-in for "rows of an answer". */
  lines: number;
  /** Rows that name who they came from (label, @handle or address). */
  authors: number;
}

function textOf(result: unknown): { text: string; isError: boolean } {
  const r = (result ?? {}) as {
    isError?: unknown;
    content?: unknown;
    structuredContent?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  // Structured results carry the same evidence in JSON; scanning the serialised
  // form keeps one code path for both without guessing at field names.
  if (r.structuredContent && typeof r.structuredContent === "object") {
    try {
      parts.push(JSON.stringify(r.structuredContent));
    } catch {
      // circular or unserialisable — the text blocks still count
    }
  }
  return { text: parts.join("\n"), isError: r.isError === true };
}

export function extractSignals(result: unknown): ProbeSignals {
  const { text, isError } = textOf(result);
  const stamps = new Set<string>();
  for (const re of TIMESTAMP_PATTERNS) {
    for (const m of text.matchAll(re)) stamps.add(m[0].replace(/\s+/g, " "));
  }
  const emails = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 2).length;
  const authors =
    [...text.matchAll(AUTHOR_LABEL_RE)].length +
    [...text.matchAll(HANDLE_RE)].length +
    emails.size;
  return {
    isError,
    chars: text.length,
    timestamps: stamps.size,
    emails: emails.size,
    lines,
    authors,
  };
}

// ---------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------

/**
 * `pass`   — the tool answered this slot's question with usable data.
 * `empty`  — it worked but returned nothing for a window where a real meeting
 *            took place. Not proof of anything, so it does not qualify a server.
 * `unusable` — it errored, or returned something without the fields the slot
 *            needs. The reason is shown to the user verbatim.
 */
export type ProbeStatus = "pass" | "empty" | "unusable";

export interface ProbeVerdict {
  slot: SlotId;
  status: ProbeStatus;
  /** One line, shown in the UI. Written for the person reading it. */
  reason: string;
  signals: ProbeSignals;
}

/** A message row is only useful if it is dated; undated text cannot be placed. */
const MIN_MESSAGE_CHARS = 40;

export function evaluateProbe(slot: SlotId, result: unknown): ProbeVerdict {
  const signals = extractSignals(result);
  const verdict = (status: ProbeStatus, reason: string): ProbeVerdict => ({
    slot,
    status,
    reason,
    signals,
  });

  if (signals.isError)
    return verdict("unusable", "ツールがエラーを返しました。");
  if (signals.chars === 0)
    return verdict("unusable", "ツールが空の応答を返しました。");

  // Order matters: an empty window has no timestamps and no authors either, so
  // emptiness is decided FIRST — otherwise a server that simply had nothing to
  // report for this hour gets reported as broken.
  if (signals.chars < MIN_MESSAGE_CHARS)
    return verdict("empty", "この時間帯のやりとりは見つかりませんでした。");
  if (signals.timestamps === 0)
    return verdict(
      "unusable",
      "返ってきた内容に日時が含まれておらず、発言を時系列に置けません。",
    );
  if (signals.authors === 0)
    return verdict(
      "unusable",
      "返ってきた内容に発言者が含まれておらず、誰の発言か分かりません。",
    );
  return verdict(
    "pass",
    `この時間帯のやりとりを ${signals.timestamps} 件ぶんの日時付きで取得できました。`,
  );
}

// ---------------------------------------------------------------------
// Whether to keep the server at all
// ---------------------------------------------------------------------

export interface ServerDecision {
  keep: boolean;
  filled: SlotId[];
  /** Shown verbatim when a server is rejected — this is the guidance. */
  message: string;
}

/**
 * MarkFlow keeps a server only when it actually answered a required slot.
 * A connection that is saved but never used would rot in the settings screen,
 * so it is refused with the reason and with what MarkFlow can use instead.
 */
export function decideServer(verdicts: ProbeVerdict[]): ServerDecision {
  const filled = verdicts.filter((v) => v.status === "pass").map((v) => v.slot);
  const keep = filled.some((id) => SLOTS[id].required);
  if (keep) {
    const names = filled.map((id) => SLOTS[id].question);
    return {
      keep,
      filled,
      message: `このサーバから次を取得できます:\n${names.map((n) => `・${n}`).join("\n")}`,
    };
  }
  const why = verdicts.length
    ? verdicts
        .map((v) => `・${SLOTS[v.slot].question} → ${v.reason}`)
        .join("\n")
    : "・読み取り専用と明示されたツールが1つもありませんでした。";
  return {
    keep: false,
    filled,
    message:
      `このサーバは議事録の補完に使えないため追加しませんでした。\n${why}\n\n` +
      `MarkFlow が使えるのは次の情報です:\n` +
      Object.values(SLOTS)
        .map(
          (s) =>
            `・${s.question}（必要な項目: ${s.needs.join("・")}）${s.required ? "" : "※任意"}`,
        )
        .join("\n"),
  };
}
