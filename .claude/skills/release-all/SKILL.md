---
name: release-all
description: 全プラットフォーム（macOS + Windows CI + iOS + Android）へのリリースを順次実行。
argument-hint: "<version> (例: 0.5.0-beta.69)"
user-invocable: true
---

# 全プラットフォームリリース

引数で指定されたバージョンで全プラットフォームにリリースする。

## 前提

- `/release-beta` スキルの Step 1-4（検証・テスト・バンプ・コミット）が完了済みであること
- 未完了の場合は先に `/release-beta $ARGUMENTS` を実行する

## 手順

### 1. macOS（ローカル署名ビルド + リリース）

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
APPLE_API_KEY="<APPLE_API_KEY>" \
APPLE_API_ISSUER="<APPLE_API_ISSUER>" \
APPLE_API_KEY_PATH="~/.tauri/AuthKey_<APPLE_API_KEY>.p8" \
pnpm tauri build
```

ベータの場合:

```bash
./scripts/release-beta.sh
```

stableの場合:

```bash
./scripts/release-stable.sh
```

### 2. Windows（自動）

- GitHub Actionsが `package.json` 変更を検知して自動ビルド
- 既存リリースにWindows版を追加
- 手動確認: `gh run list --workflow=release-beta.yml` でCI完了を確認

### 3. iOS TestFlight

```bash
./scripts/release-testflight.sh
```

- Bundle IDの差し替え・復元はスクリプトが自動処理
- App Store Connectへのアップロードまで完結

### 4. Android Internal Testing

```bash
ANDROID_KEYSTORE_PASS=<REDACTED: local secret store> ./scripts/release-android-internal.sh
```

- Google Play Internal Testingトラックに自動公開

## 完了確認

- macOS: GitHubリリースに `.dmg` + `.tar.gz` + `.sig` がアップロードされていること
- Windows: GitHub Actionsが成功し `.exe` + `.exe.sig` が追加されていること
- iOS: App Store Connect の TestFlight にビルドが表示されること
- Android: Google Play Console の Internal Testing にビルドが表示されること
