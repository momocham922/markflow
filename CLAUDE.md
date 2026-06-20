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

| Channel | Endpoint                               | GitHub release          |
| ------- | -------------------------------------- | ----------------------- |
| stable  | `releases/latest/download/latest.json` | Latest non-prerelease   |
| beta    | `releases/download/beta/beta.json`     | `beta` tag (prerelease) |

- Rust commands `check_for_update(channel)` / `install_update(channel)` in `src-tauri/src/lib.rs`
- Channel setting stored in SQLite: `update_channel = "stable" | "beta"`
- v0.2.31 and earlier have NO beta toggle — they only check stable. Beta testers must manually install DMG first.

### Release Flow

> **検証手順・品質ルールの詳細は `.claude/rules/release-and-quality.md` を参照**

#### Standard: Beta-first release strategy

大きな機能変更は必ずベータ経由で段階的にリリースする。

1. **mainでは大型機能のmergeをrevert**して、ベータトグル等の基盤だけをstable配信
2. **`release/beta`ブランチ**にrevert前の全機能入りコードを保持
3. stable配信後、ベータONのユーザーだけが大型機能を受け取る
4. ベータテストで問題なければ、mainに機能をマージして次のstable版に昇格

```
main (0.2.32 stable)        = ベータトグル + バグ修正のみ
release/beta (0.3.0-beta.1) = 全機能入り（ベータ配信用）
```

#### Stable Release

```bash
./scripts/bump-version.sh X.Y.Z
git add -A && git commit && git push
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build
./scripts/release-stable.sh
```

- Creates a versioned tag release (e.g., `v0.2.32`) on GitHub
- ALL users receive update automatically

#### Beta Release

`release/beta`ブランチから実行する。

```bash
git checkout release/beta
./scripts/bump-version.sh X.Y.Z-beta.N
git add -A && git commit
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build
./scripts/release-beta.sh
```

- Creates/replaces the `beta` tag release on GitHub as a prerelease
- Beta channel users receive update automatically

#### Beta → Stable 昇格

ベータで問題なければ:

1. mainに機能をマージ（revertのrevert、またはrelease/betaからmerge）
2. stableバージョンにバンプ（例: 0.3.0）
3. `./scripts/release-stable.sh`で全ユーザーに配信

#### Rollback

- **Beta**: `gh release delete beta` → ベータユーザーにアップデートが届かなくなる
- **Stable**: fix forwardで新パッチバージョンをリリース

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

#### 全プラットフォームリリース手順（4プラットフォーム）

1. `./scripts/bump-version.sh X.Y.Z-beta.N`
2. `git add -A && git commit && git push`
3. **macOS**: ローカルで署名ビルド → `./scripts/release-beta.sh`（または `release-stable.sh`）
4. **Windows**: GitHub Actionsが `package.json` 変更を検知して自動ビルド → 既存リリースにWindows版を追加
5. **iOS**: ローカルで `./scripts/release-testflight.sh`
6. **Android**: `ANDROID_KEYSTORE_PASS=markflow2026 ./scripts/release-android-internal.sh`

```bash
# Beta リリース一括実行例（macOS + iOS + Android をローカルで実行、Windowsは自動）
./scripts/bump-version.sh X.Y.Z-beta.N
git add -A && git commit && git push
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  APPLE_API_KEY="AQ996V29F4" \
  APPLE_API_ISSUER="fab7704b-d2a9-4ce6-9e58-c6a73c958c22" \
  APPLE_API_KEY_PATH="/Users/3937/.tauri/AuthKey_AQ996V29F4.p8" \
  pnpm tauri build
./scripts/release-beta.sh
./scripts/release-testflight.sh
ANDROID_KEYSTORE_PASS=markflow2026 ./scripts/release-android-internal.sh
```

- Beta CI: `release/beta` pushで `.github/workflows/release-beta.yml` 発火（Windowsのみ）
- Stable CI: `main` pushで `.github/workflows/release-stable.yml` 発火（Windowsのみ）
- macOSはApple署名証明書がCI未登録のため、ローカルビルド
- 手動実行（workflow_dispatch）も可能

### Android 注意事項

- リリース署名: `~/.android/markflow-release.keystore`（alias: `markflow`）
- Play Console自動アップロード: `~/.android/play-api-key.json`（サービスアカウント: `play-upload@markflow-app-2026.iam.gserviceaccount.com`）
- Internal Testingトラックに自動公開
- `build.gradle.kts` にリリース署名設定済み（`ANDROID_KEYSTORE_PASS` 環境変数）

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

## Enforcement Rules

品質・アーキテクチャの制約ルールは `.claude/rules/` に定義:

- `.claude/rules/release-and-quality.md` — リリース手順・テスト・品質プロセス
- `.claude/rules/architecture.md` — Cloud-first設計・Firestore実装・バージョン管理

リリーススキル（`/release-beta`, `/release-all`）は `.claude/skills/` に定義。
