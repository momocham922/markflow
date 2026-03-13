# MarkFlow Roadmap

## Concept
* HackMD + Obsidian + ClaudeCode + Xmind + Notion
* Not a simple note tool — a hub for business operations
* Cross-platform, seamless access to individual & team thinking
* Minimal style but feature-rich
* Advanced UX through powerful AI integration
* Polished rendering to support thought organization & visualization

## Status Legend
- DONE = implemented + security audited + build verified
- PARTIAL = partially implemented or needs runtime verification
- TODO = not started
- CONCERN = implemented but has known limitations

---

## General

| Status | Item | Notes |
|--------|------|-------|
| TODO | Version management: GitHub integration | Choice between app-native and GitHub |
| TODO | Auth: GitHub login support | Currently Google-only |
| TODO | iOS app version | Requires separate build target |
| DONE | Images: paste/drop -> local save -> asset protocol | Paste, drag-drop, local save, WebP auto-convert (Rust image crate) |
| DONE | YouTube: beautiful preview rendering, inline playback | Custom marked renderer, iframe embed, XSS-safe |
| DONE | Links: smart card rendering with OGP info | Rust fetch_ogp command, cache with race condition fix, XSS-safe |

## AI Features

| Status | Item | Notes |
|--------|------|-------|
| TODO | MCP integration | Not started |
| TODO | Nanobanana integration for image insertion | Not started |
| TODO | Google Search for AI responses | Not started |
| TODO | Multimodal input support | Not started |
| DONE | Adjustable AI panel width | Implemented |
| TODO | Output control via rules-like configuration | Not started |

## Additional Features

| Status | Item | Notes |
|--------|------|-------|
| DONE | Mind map support (Xmind-style) | Heading-based tree visualization via @xyflow/react, 4th editor view mode |
| DONE | Remote update after build distribution | Tauri updater plugin + GitHub Releases endpoint |
| DONE | Version management tied to documents | Auto-versioning + VersionHistory dialog (browse, preview, restore, delete) |
| DONE | Beautiful Mermaid diagram rendering | mermaid.run() in useEffect, theme sync, XSS-safe escaping |
| TODO | Visualization view | Folder/label structure visualization, group-level summaries |
| TODO | Real-time voice capture -> transcription -> Markdown | Not started |
| DONE | Custom theme import via structured files | JSON import/export, Tauri native save dialog, SQLite persistence |

## Collaboration & Sharing

| Status | Item | Notes |
|--------|------|-------|
| DONE | Real-time collaboration (Yjs) | y-websocket + y-codemirror.next + y-indexeddb |
| DONE | Share via link | Firestore shareLink, SharedDocView component |
| DONE | Team documents | Firestore teams, team folders, team doc sync |
| DONE | Shared doc content stability | y-indexeddb persistence, seedIfEmpty leader election, empty content guards |
| DONE | Collab content-loss edge cases | clientID leader election prevents concurrent seeding; lowest ID seeds, others wait |

## Core Editor

| Status | Item | Notes |
|--------|------|-------|
| DONE | CodeMirror markdown editor | @uiw/react-codemirror with frozen value pattern |
| DONE | Split/edit/preview modes | Three-mode toggle in toolbar |
| DONE | Formatting toolbar | Bold, italic, strikethrough, code, link, headings, lists, blockquote |
| DONE | Tag management | Add/remove tags in toolbar, tag filter in sidebar |
| DONE | Document rename (inline) | Click-to-rename in toolbar |
| DONE | Wiki-links [[title]] | Click navigation, code block protection, XSS-safe |
| DONE | Syntax highlighting in code blocks | highlight.js integration |
| DONE | Auto-versioning | 10s idle auto-save to SQLite versions table |

## Sidebar & Organization

| Status | Item | Notes |
|--------|------|-------|
| DONE | Folder tree (personal) | buildTree(), drag-drop, nested folders |
| DONE | Folder tree (team) | Reuses buildTree(), Firestore team folders |
| DONE | Folder creation validation | Rejects / and \ characters |
| DONE | Folder deletion cascade | Deletes all docs in folder and subfolders |
| DONE | Search/filter | Text search + tag filter |
| DONE | Context menu (rename, delete, move) | Right-click menu on documents |

## Export & Output

| Status | Item | Notes |
|--------|------|-------|
| DONE | Export Markdown (.md) | Tauri native save dialog |
| DONE | Export HTML | Full standalone HTML with styles, title XSS-safe |
| DONE | Print | Browser print with styled HTML, title XSS-safe |

## Security (Audit Completed)

| Status | Item | Notes |
|--------|------|-------|
| DONE | XSS: marked renderer (links) | Protocol blocking (javascript/data/vbscript), escapeHtml on href/text |
| DONE | XSS: Mermaid code blocks | escapeHtml on text content |
| DONE | XSS: OGP link cards | All remote data escaped (title, description, image, URL) |
| DONE | XSS: Wiki-links | Attribute and text escaping |
| DONE | XSS: SharedDocView | Separate renderer with protocol blocking (critical: external user content) |
| DONE | XSS: HTML export/print title | escapeHtml in title tags |
| DONE | SQL injection prevention | All queries use parameterized statements |
| DONE | Empty content protection | 3-layer defense: write-ahead snapshots, guards, recovery cascade |

## Unconfirmed Features

| Status | Item | Notes |
|--------|------|-------|
| DONE | Slack notifications | Webhook-based, SlackSettingsDialog UI for config, event type toggles |

## Bugs & Fixes (all resolved)

| Status | Item |
|--------|------|
| DONE | Folder deletion should also delete folder contents |
| DONE | Export functions not working — fix all (Tauri native save dialog) |
| DONE | Allow folder creation inside team documents |
| DONE | Label filter not functioning — fix |
| DONE | Editor text selection -> deselection causes inverted space left of line numbers |
| DONE | File name editing (double-click rename + context menu) |
| DONE | Mac window top bar double-click doesn't maximize |
| DONE | Content duplication bug (Yjs seedIfEmpty race condition) |
| DONE | Cmd+K command palette conflict (removed competing keybinding) |
| DONE | OGP cache race condition (polling fix) |
| DONE | Wiki-links rendering inside code blocks (placeholder protection) |
| DONE | Mermaid theme not syncing on theme change (useEffect dependency fix) |

## Testing Status

| Layer | Status | Notes |
|-------|--------|-------|
| Static code analysis | DONE | Full codebase audit, 11 bugs found and fixed |
| Build verification | DONE | pnpm build succeeds (4651 modules, 0 errors) |
| Unit tests (Vitest) | TODO | No test framework installed |
| Component tests | TODO | No test framework installed |
| E2E tests (Playwright) | DONE | 80 tests covering init, CRUD, editor, preview, sidebar, tags, themes, commands, mind map, version history |
| Tauri runtime tests | TODO | Requires tauri-driver |

## Reference
* Competitor analysis: https://zenn.dev/acntechjp/articles/5a8b7b334b15bc
