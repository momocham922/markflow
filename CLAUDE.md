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

## Roadmap
See `ROADMAP.md` for product vision, planned features, known bugs, and priorities.

## Release & Update System

### Version Management
- **Three version files must ALWAYS be in sync**: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- Use `./scripts/bump-version.sh X.Y.Z` to update all 3 atomically
- **ALWAYS bump version** for any code change — same version won't trigger auto-updater
- **Signing key**: `~/.tauri/markflow.key` (empty password)

### Update Channels
Two channels: **stable** and **beta**. Users toggle in StatusBar (FlaskConical icon).

| Channel | Endpoint | GitHub release |
|---------|----------|----------------|
| stable  | `releases/latest/download/latest.json` | Latest non-prerelease |
| beta    | `releases/download/beta/beta.json` | `beta` tag (prerelease) |

- Rust commands `check_for_update(channel)` / `install_update(channel)` in `src-tauri/src/lib.rs`
- Channel setting stored in SQLite: `update_channel = "stable" | "beta"`
- v0.2.31 and earlier have NO beta toggle — they only check stable. Beta testers must manually install DMG first.

### Release Flow

#### Verification (before ANY release)
```bash
npx tsc --noEmit          # zero type errors
pnpm build                # frontend build succeeds
cargo check               # Rust compiles (in src-tauri/)
npx playwright test e2e/  # E2E tests pass
```

#### Beta Release
```bash
./scripts/bump-version.sh 0.3.0-beta.1
git add -A && git commit && git push
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build
./scripts/release-beta.sh
```
- Creates/replaces the `beta` tag release on GitHub as a prerelease
- Uploads DMG, .tar.gz, .sig, and beta.json
- Beta channel users receive update automatically
- New beta testers: share DMG directly for first install

#### Stable Release
```bash
./scripts/bump-version.sh 0.3.0
git add -A && git commit && git push
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build
./scripts/release-stable.sh
```
- Creates a versioned tag release (e.g., `v0.3.0`) on GitHub
- Uploads DMG, .tar.gz, .sig, and latest.json
- ALL users receive update automatically

#### Rollback
- **Beta**: Delete the `beta` release on GitHub → beta users won't see the update
- **Stable**: Cannot un-release (users may have already updated). Fix forward with a new patch version.

### Build Artifacts
All at `src-tauri/target/release/bundle/`:
- `dmg/MarkFlow_{VERSION}_aarch64.dmg` — installer
- `macos/MarkFlow.app.tar.gz` — updater payload
- `macos/MarkFlow.app.tar.gz.sig` — update signature

### Testing
- **Playwright E2E** (`e2e/`): Runs against `pnpm dev` (frontend only, no Tauri plugins)
  - `npx playwright test e2e/` or `pnpm test:e2e`
- **Tauri E2E** (`e2e-tauri/`): Real Tauri app tests via Docker + tauri-driver + WebDriverIO
  - `pnpm test:tauri` (builds Docker image, runs tests inside container)
  - Only works on Linux (WebKitGTK) — Docker container handles this on macOS
- **Unit tests**: `pnpm test` (Vitest)

## Collaboration Architecture (Yjs)
Shared documents use the Google Docs/Notion pattern:
1. **Y.Doc** = single source of truth for shared document content
2. **y-indexeddb** = client-side Y.Doc persistence (offline, instant load)
3. **y-websocket** = real-time peer sync
4. **SQLite** = one-time seed only; after first sync, Y.Doc owns content

Editor.tsx: shared docs show "Syncing document..." until yCollab is ready,
then mount CodeMirror in uncontrolled mode (no value prop transition).
