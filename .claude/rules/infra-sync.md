---
description: コード変更時にインフラ（Firebase rules・Cloud Runデプロイ・IAM権限）の連動変更を漏らさないための強制ルール。
globs:
---

# インフラ連動ルール（Infrastructure Sync）

## 原則: コードが動く環境を整えるまでがコード変更

ローカルビルド成功は完了ではない。変更が実際にユーザーの手元で動く状態にするまでが1つの作業単位。
以下のチェックを変更内容に応じて**自動的に**実行する。「忘れた」は許容されない。

## GCP アカウント（最優先・アクティブ依存禁止）

- **markflow-app-2026 の gcloud/gsutil/logging/Cloud Run/Firestore/Speech-to-Text 操作は必ず `--account ga.crossmedia@gmail.com` を明示する。**
- 複数プロジェクトを別窓で並行運用しておりアクティブアカウントは頻繁にドリフトする。アクティブアカウント前提のコマンドを書くな。
- 権限を持つのは `ga.crossmedia@gmail.com` のみ。`ryouhei.mita922@gmail.com`（git identity）・`zaburou2005@gmail.com` 等は PERMISSION_DENIED。
- アクセストークンは `gcloud auth print-access-token --account ga.crossmedia@gmail.com`。
- `PERMISSION_DENIED` が出たら **まず `--account` を疑う**。アカウントが違うだけで止まるな（正しいアカウントで即やり直す）。

## トリガー別の必須アクション

### 1. Firebase Storage の新パス追加

**トリガー**: Rust/フロントエンドで Firebase Storage への新しいパス（`images/`, `audio/`, etc.）にアップロードするコードを書いた場合

**必須アクション**:

1. `firebase/storage.rules` にそのパスの read/write ルールが存在するか確認
2. なければ追加し `npx firebase deploy --only storage --project markflow-app-2026` を実行
3. そのパスを GCP サービスが読む場合（例: Speech-to-Text の BatchRecognize）、サービスエージェントに IAM 権限を付与

**検証**: テスト用ファイルをアップロードして 200 が返ることを確認

**教訓**: beta.90 — `audio/` パスの Storage rules が未定義で upload_voice_archive が 403 即失敗。エラートーストが 10 秒で消えユーザーが気づけなかった。

### 2. Firestore の新コレクション追加

**トリガー**: フロントエンド/バックエンドで Firestore の新しいコレクションやサブコレクションに read/write するコードを書いた場合

**必須アクション**:

1. `firebase/firestore.rules` にそのコレクションのルールが存在するか確認
2. なければ追加し `npx firebase deploy --only firestore:rules --project markflow-app-2026` を実行

**教訓**: beta.85-92 — Firestore rules の resource==null 問題で 8 回リリースしても直らなかった。

### 3. AI プロキシ（server/ai-proxy/）の変更

**トリガー**: `server/ai-proxy/index.ts` を変更した場合（エンドポイント追加・修正・環境変数追加等）

**必須アクション**:

1. Cloud Run に再デプロイ:
   ```bash
   cd server/ai-proxy && gcloud run deploy markflow-ai-proxy \
     --source . --project markflow-app-2026 --region asia-northeast1 \
     --allow-unauthenticated --memory 512Mi --timeout 600 \
     --min-instances 0 --max-instances 3
   ```
2. 新リビジョンがトラフィック 100% であることを確認:
   ```bash
   gcloud run services describe markflow-ai-proxy --project markflow-app-2026 \
     --region asia-northeast1 --format="value(status.traffic[0].revisionName)"
   ```
3. 変更したエンドポイントに curl でリクエストを送り、期待するレスポンス（認証エラー含む）を確認

**教訓**: beta.86-90 — batch-transcribe エンドポイントをコードに追加したが Cloud Run に再デプロイせず 404。4 リリース分気づかなかった。

### 4. GCP サービス連携の追加

**トリガー**: 新しい GCP API/サービス（Speech-to-Text, Vision, etc.）と連携するコードを書いた場合

**必須アクション**:

1. API が有効か確認: `gcloud services list --enabled --project markflow-app-2026 --filter="name:<service>"`
2. サービスエージェントが必要な場合は作成: `gcloud beta services identity create --service=<api>.googleapis.com --project=markflow-app-2026`
3. サービスエージェントに必要な IAM 権限を付与（例: Storage バケットへの objectViewer）
4. Cloud Run のサービスアカウント（`636447248627-compute@developer.gserviceaccount.com`）にも必要な権限があるか確認

## チェックリスト（リリース前に実行）

コード変更のたびに以下を**機械的に**チェックする:

| 変更ファイル                        | 確認事項                                           |
| ----------------------------------- | -------------------------------------------------- |
| `server/ai-proxy/*`                 | Cloud Run 再デプロイ済みか？                       |
| Firebase Storage パスを含む Rust/TS | `storage.rules` にルールがあるか？                 |
| Firestore コレクション名を含む TS   | `firestore.rules` にルールがあるか？               |
| GCP API 呼び出しを含むコード        | API 有効化・サービスエージェント・IAM 確認済みか？ |
| 環境変数の追加                      | Cloud Run の env / `.env` の両方に設定済みか？     |

## 禁止事項

- **「コードに書いたから動くはず」**: インフラ側の設定を確認せずにリリースすることは禁止
- **インフラ変更の後回し**: 「次のリリースで」は禁止。コード変更と同一リリースで完結させる
- **サイレント失敗の放置**: エラートーストが自動消失するUIで重大なインフラエラーを見逃さない。エラーログを必ず確認
