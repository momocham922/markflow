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

### Step 5: 署名付きビルド（macOS）

**`MARKFLOW_UPDATE_BASE` と `VITE_BILLING_ENABLED` は必須**（両方欠けると欠陥ビルドになる）:

- `MARKFLOW_UPDATE_BASE=https://markflow.jp/updates` — 自社ドメイン更新配信への移行ビルド（決定①）。**これを付けないと macOS クライアントが GitHub をポーリングし続け、移行が巻き戻る**（beta.16 で実際に欠落ビルドを踏んだ）。バイナリに `option_env!` でコンパイル時焼き込み。
- `VITE_BILLING_ENABLED=true` — ベータ限定で課金UI点灯（Stripeテストモード）。stable は絶対に付けない。

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/markflow.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
MARKFLOW_UPDATE_BASE="https://markflow.jp/updates" \
VITE_BILLING_ENABLED=true \
pnpm tauri build
```

ビルド後、更新エンドポイントが焼き込まれたか実測検証（GitHub URL=0件・自社URL≥1件）:

```bash
strings src-tauri/target/release/markflow | grep -c "github.com/momocham922/markflow/releases"  # → 0
strings src-tauri/target/release/markflow | grep -c "markflow.jp/updates"                        # → ≥1
```

### Step 6: リリース（dual-publish 必須）

**GitHub と GCS の両方に配信する。片方だけは未完了**（旧クライアントは GitHub、移行ビルドは markflow.jp/updates をポーリングするため両方要る）:

```bash
./scripts/release-beta.sh            # GitHub beta タグ（旧クライアント向け）
./scripts/release-updates-gcs.sh beta  # GCS 自社ドメイン（移行ビルド向け・WindowsはGitHubからミラー）
```

Windows CI（`package.json` push で発火）が beta.16 exe を GitHub beta にアップロード後に `release-updates-gcs.sh` を実行すると、GCS beta.json に windows-x86_64 も含まれる。

### Step 7: 完了確認（両チャネル実測）

```bash
curl -sL https://github.com/momocham922/markflow/releases/download/beta/beta.json | jq '{version,platforms:(.platforms|keys)}'
curl -sL https://markflow.jp/updates/beta.json                                    | jq '{version,platforms:(.platforms|keys)}'
```

- 両方 version=当該beta・darwin-aarch64/windows-x86_64 の両プラットフォームが揃うこと
- 自社ドメインの成果物（`/updates/beta/*.tar.gz` `*_x64-setup.exe`）が 200 で到達すること
- iOS（TestFlight）/ Android（Play）配信済みなら合わせてユーザーに完了報告
