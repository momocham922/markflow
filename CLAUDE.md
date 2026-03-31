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

#### 全プラットフォーム同時リリース手順
1. `./scripts/bump-version.sh X.Y.Z-beta.N`
2. `git add -A && git commit && git push`
3. **macOS版**: `pnpm tauri build` → `./scripts/release-beta.sh`
4. **iOS版**: `./scripts/release-testflight.sh`
5. **Windows版**: Windowsマシンで `git pull` → `.\scripts\build-windows.ps1` → `.\scripts\release-windows-beta.ps1`
6. **macOS → iOS → Windows の順で実行**

### Windows Release

#### 初回セットアップ（Windowsマシンで1回だけ）
```powershell
# 1. 必須ツール
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
npm install -g pnpm
winget install Microsoft.VisualStudio.2022.BuildTools
#    → インストーラで「C++ によるデスクトップ開発」にチェック
winget install GitHub.cli
gh auth login

# 2. 署名キーをmacOSからコピー
mkdir $env:USERPROFILE\.tauri
scp mac:~/.tauri/markflow.key $env:USERPROFILE\.tauri\markflow.key
```

#### Beta Release（Windowsマシンで実行）
```powershell
git pull
.\scripts\build-windows.ps1            # ビルド + 署名
.\scripts\release-windows-beta.ps1     # 既存betaリリースにWindows版を追加
```

#### Stable Release（Windowsマシンで実行）
```powershell
git pull
.\scripts\build-windows.ps1            # ビルド + 署名
.\scripts\release-windows-stable.ps1   # 既存stableリリースにWindows版を追加
```

#### 仕組み
- macOS側で先にGitHub Releaseを作成 → Windows側が既存リリースのJSONをダウンロード → `windows-x86_64` プラットフォームを追加してアップロード
- テストユーザーへの初回配布: `.exe` インストーラーを共有（ダブルクリックでインストール）
- 以降のアップデート: アプリが自動でチェック → 自動更新（macOS版と同じ）

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
