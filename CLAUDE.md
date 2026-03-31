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

### iOS TestFlight Release (CRITICAL — 特殊フロー)

#### Bundle ID問題
- **macOS**: `com.markflow.editor` — `tauri.conf.json` の `identifier`。**絶対に変更禁止**（変更すると `~/Library/Application Support/` のパスが変わり既存ユーザーのデータが全て消失する）
- **iOS (App Store Connect)**: `com.markflow.app` — Apple Developer Portalで登録済み
- Tauriは `tauri.conf.json` の `identifier` を両プラットフォームに適用するため、分離不可
- **解決策**: `release-testflight.sh` がビルド前に identifier を一時的に差し替え、ビルド後に自動復元する

#### TestFlight ビルドコマンド
```bash
./scripts/bump-version.sh 0.3.0-beta.N    # version + iOS build番号を更新
git add -A && git commit && git push
./scripts/release-testflight.sh            # 1コマンドで完結
```

スクリプト内部処理:
1. `tauri.conf.json` の identifier を `com.markflow.app` に一時変更
2. `pnpm tauri ios build` 実行
3. xcarchive内の CFBundleVersion を整数に修正（Tauriが `0.3.0.N` 形式で上書きするため）
4. `xcodebuild -exportArchive` で App Store Connect にアップロード
5. identifier を `com.markflow.editor` に復元（`trap EXIT` で失敗時も保証）

#### TestFlight 設定
- App Store Connect アプリ名: `Markflow - Markdown Editor`（「MarkFlow」は他者に取られている）
- CFBundleVersion: 整数連番（1, 2, 3...）。`project.yml` で管理、`bump-version.sh` が自動インクリメント
- CFBundleShortVersionString: セマンティックバージョン（プレリリースタグ不可、例: `0.3.0`）
- ExportOptions.plist: `app-store-connect` + `automatic` signing
- `ITSAppUsesNonExemptEncryption: false` が Info.plist に必須

#### 全プラットフォームリリース手順
1. `./scripts/bump-version.sh X.Y.Z-beta.N`
2. `git add -A && git commit && git push`
3. **macOS**: ローカルで署名ビルド → `./scripts/release-beta.sh`
4. **Windows**: GitHub Actionsが `package.json` 変更を検知して自動ビルド → 既存リリースにWindows版を追加
5. **iOS**: ローカルで `./scripts/release-testflight.sh`

- Beta CI: `release/beta` pushで `.github/workflows/release-beta.yml` 発火（Windowsのみ）
- Stable CI: `main` pushで `.github/workflows/release-stable.yml` 発火（Windowsのみ）
- macOSはApple署名証明書がCI未登録のため、ローカルビルド
- 手動実行（workflow_dispatch）も可能

### Windows 注意事項
- MSIバンドラーはプレリリース版 (beta.X) に非対応 → `--bundles nsis` 必須
- 成果物: `.exe` + `.exe.sig`（`.nsis.zip` は生成されない）
- テストユーザーへの初回配布: `.exe` インストーラーを共有（ダブルクリックでインストール）
- 以降のアップデート: アプリが自動でチェック → 自動更新（macOS版と同じ）
- `TAURI_SIGNING_PRIVATE_KEY` はGitHub Secretsに登録済み

### Build Artifacts
All at `src-tauri/target/release/bundle/`:
- `dmg/MarkFlow_{VERSION}_aarch64.dmg` — macOS installer
- `macos/MarkFlow.app.tar.gz` — macOS updater payload
- `macos/MarkFlow.app.tar.gz.sig` — macOS update signature
- `nsis/MarkFlow_{VERSION}_x64-setup.exe` — Windows installer & updater payload
- `nsis/MarkFlow_{VERSION}_x64-setup.exe.sig` — Windows update signature

### Testing
- **Playwright E2E** (`e2e/`): Runs against `pnpm dev` (frontend only, no Tauri plugins)
  - `npx playwright test e2e/` or `pnpm test:e2e`
- **Tauri E2E** (`e2e-tauri/`): Real Tauri app tests via Docker + tauri-driver + WebDriverIO
  - `pnpm test:tauri` (builds Docker image, runs tests inside container)
  - Only works on Linux (WebKitGTK) — Docker container handles this on macOS
- **Unit tests**: `pnpm test` (Vitest)

## Cloud Sync Design Rules (auth-store.ts)
- **syncFromCloud → syncToCloud** の順で毎回実行（起動時、60秒周期、オンライン復帰時）
- **syncToCloud に lastSyncAt フィルターを入れてはいけない**: syncFromCloud が `lastSyncAt = Date.now()` を書いた直後に syncToCloud が走ると、全ドキュメントの `updatedAt < lastSyncAt` で何もアップロードされなくなる
- **自分のドキュメントも内容同期必須**: syncFromCloud で既存ローカルドキュメントの content/title を cloud の updatedAt > local の updatedAt なら更新すること（メタデータだけ更新して content を無視すると別デバイスの編集が反映されない）
- **削除の reconciliation**: syncFromCloud が reconciliation でローカル削除済みドキュメントを除去した後に syncToCloud が走るので、削除済みドキュメントの再アップロードは起きない
