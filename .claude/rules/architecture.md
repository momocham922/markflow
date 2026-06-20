---
description: MarkFlowのアーキテクチャ制約。Cloud-first設計、Firestore実装ルール、永続化の原則。
globs:
---

# アーキテクチャルール

## Cloud-First原則（最重要）

- **Firestoreが全データの単一真実源**。SQLiteのみの永続化は絶対禁止
- 新機能のデータ保存 → まずFirestoreスキーマを設計し、Firestore保存を実装。SQLiteはキャッシュ/オフライン用途のみ
- **画像**: Firebase Storage必須。ローカルURL挿入禁止
- **アップロード失敗時**: エラーを明示的に表示。サイレントフォールバック禁止
- この原則を無視するとプロダクトのコンセプトが崩壊する

## Firestore実装ルール

- **setDoc + merge 使用**。updateDoc 禁止（存在しないドキュメントで失敗する）
- **syncFromCloud → syncToCloud** の順序厳守
- **syncToCloud に lastSyncAt フィルターを入れてはいけない**: syncFromCloud が lastSyncAt を更新した直後に syncToCloud が走ると、全ドキュメントがフィルターされて何もアップロードされない
- **自分のドキュメントの内容同期**: syncFromCloud で既存ローカルドキュメントの content/title を更新すること。メタデータだけ更新して content を無視すると別デバイスの編集が反映されない
- **lastSyncAt はsync開始前にキャプチャ**: 完了後ではなく開始前に取得し、成功時のみ書き込む
- **削除の reconciliation**: 削除前に `fetchDocument(id)` で直接Firestoreを確認。タイミングベースの推測判定は禁止

## コンテンツ保護

- 3層防御: write-ahead snapshots, empty content guards, recovery cascade
- 非空コンテンツを空コンテンツで上書きしない（DB, store, Firestore 全レイヤー）

## Bundle ID（変更厳禁）

- macOS: `com.markflow.editor` — `tauri.conf.json` の `identifier`。変更すると `~/Library/Application Support/` のパスが変わり既存ユーザーのデータ全喪失
- iOS: `com.markflow.app` — Apple Developer Portalで登録済み。TestFlightビルド時にスクリプトで差し替え

## 重要情報の即時永続化

- 根本原因の特定、デバッグの過程、ユーザーからの指摘、技術的な発見 → 判明した時点で即座にメモリに保存
- セッション終了前ではなく、判明した時点で保存する
- 既存メモリと重複する場合は統合・更新する
