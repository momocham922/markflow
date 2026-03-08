# MarkFlow

Cross-platform Markdown editor built with Tauri v2 + React 19 + TypeScript.

## Development

```bash
pnpm install
pnpm tauri dev    # Start dev server with Tauri window
pnpm dev          # Frontend only dev server (port 1420)
pnpm build        # Build frontend
pnpm tauri build  # Full production build
```

## Tech Stack
- **Desktop shell**: Tauri v2 (Rust)
- **Frontend**: React 19 + TypeScript + Vite
- **Styling**: Tailwind CSS v4 + shadcn/ui
- **Editor**: CodeMirror via `@uiw/react-codemirror` (migrated from Tiptap)
- **State**: Zustand (`app-store.ts`, `auth-store.ts`, `editor-store.ts`)
- **Local DB**: SQLite via `@tauri-apps/plugin-sql`
- **Cloud**: Firebase Firestore
- **Collaboration**: Yjs + y-websocket + y-codemirror.next + y-indexeddb

## Project Structure
- `src/` - React frontend
- `src-tauri/` - Rust Tauri backend
- `src/components/editor/` - Editor components (CodeMirror)
- `src/components/sidebar/` - File sidebar
- `src/stores/` - Zustand state stores
- `src/hooks/use-collaboration.ts` - Yjs real-time collaboration hook
- `src/services/database.ts` - SQLite operations
- `src/services/firebase.ts` - Firestore operations
- `src/styles/` - Global CSS

## Collaboration Architecture (Yjs)
Shared documents use the Google Docs/Notion pattern:
1. **Y.Doc** = single source of truth for shared document content
2. **y-indexeddb** = client-side Y.Doc persistence (offline, instant load)
3. **y-websocket** = real-time peer sync
4. **SQLite** = one-time seed only; after first sync, Y.Doc owns content

Editor.tsx: shared docs show "Syncing document..." until yCollab is ready,
then mount CodeMirror in uncontrolled mode (no value prop transition).

## Ongoing Work: Collab Content-Loss Fix

### Problem
Shared document content disappearing due to stale Yjs WS server data.

### Completed Fixes
- Non-shared docs: fully protected (Yjs only enabled when `isShared === true`)
- Empty content guards in `app-store`, `auth-store`, `Editor.tsx`
- y-indexeddb added for Y.Doc client persistence
- First-time migration logic: if IndexedDB is empty, trust local SQLite over WS server
- Editor: shared docs wait for yCollab before mounting CodeMirror
- `is_shared` column added to SQLite (migration v5) for persistence

### Still TODO
1. Restart app to apply `is_shared` DB migration → verify shared marks & Live indicator return
2. Test collaborative editing from another machine/user
3. Review `tryFinalize` logic: currently always prefers local on first-use; may need to respect peer edits when peers are present
4. Commit all changes (22 files modified, uncommitted)

### Key Files Changed
- `src/hooks/use-collaboration.ts` — full rewrite (y-indexeddb, migration logic)
- `src/components/editor/Editor.tsx` — loading state for shared docs, collab indicators
- `src/stores/app-store.ts` — empty content protection, isShared loading from DB
- `src/stores/auth-store.ts` — empty content sync skip
- `src/services/database.ts` — is_shared column, upsert update
