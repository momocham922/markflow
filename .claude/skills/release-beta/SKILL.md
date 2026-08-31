---
name: release-beta
description: ベータリリースの全手順を実行。静的検証→テスト→バージョンバンプ→コミット→署名ビルド→リリーススクリプト。
argument-hint: "<version> (例: 0.5.0-beta.69)"
user-invocable: true
---

# ベータリリース手順

引数で指定されたバージョンでベータリリースを実行する。全手順を省略なしで完遂すること。

## 前提条件

- `release/beta` ブランチにいること
- 変更がコミット可能な状態であること

## 手順

### Step 1: 静的検証（並列実行可）

```bash
npx tsc --noEmit
pnpm build
cd src-tauri && cargo check && cd ..
```

エラーがあれば修正してから次に進む。

### Step 2: テスト実行（全て必須）

```bash
pnpm test
npx playwright test e2e/
pnpm test:tauri
```

失敗したテストがあれば修正→再実行→全通過するまで繰り返す。スキップ禁止。

### Step 3: バージョンバンプ

```bash
./scripts/bump-version.sh $ARGUMENTS
```

### Step 4: コミット＆プッシュ

変更内容に応じた適切なコミットメッセージを作成する。

```bash
git add -A
git commit -m "<type>(<scope>): <日本語説明> (v$ARGUMENTS)"
git push
```

### Step 5: 署名付きビルド

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
APPLE_API_KEY="<APPLE_API_KEY>" \
APPLE_API_ISSUER="<APPLE_API_ISSUER>" \
APPLE_API_KEY_PATH="~/.tauri/AuthKey_<APPLE_API_KEY>.p8" \
pnpm tauri build
```

### Step 6: リリース

```bash
./scripts/release-beta.sh
```

### Step 7: 完了確認

- GitHubリリースページのURLが出力されることを確認
- `beta` タグのリリースが更新されていることを確認
- ユーザーに完了を報告
