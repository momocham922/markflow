---
description: コード変更後のリリース品質プロセス。テスト省略・リリース漏れ・推測リリースを防止する。
globs:
---

# リリース品質ルール

## コード変更後の手順（省略・分割禁止）

1. `npx tsc --noEmit` — 型エラーゼロ
2. `pnpm build` — フロントエンドビルド成功
3. `cargo check`（src-tauri/ 内、Rust変更時）
4. `pnpm test` — Vitest全通過
5. `npx playwright test e2e/` — Playwright E2E全通過
6. `pnpm test:tauri` — Tauri E2E全通過（Docker必須）
7. **インフラ連動チェック** — `.claude/rules/infra-sync.md` に従い漏れを確認
8. `./scripts/bump-version.sh X.Y.Z(-beta.N)`
9. `git add + commit + push`
10. `pnpm tauri build`（署名環境変数付き）
11. `./scripts/release-beta.sh` or `./scripts/release-stable.sh`
12. リリース完了を確認してからユーザーに報告

## 禁止事項

- **テスト省略**: 「後でやる」「次から気をつける」は禁止。環境問題（Docker未起動等）は自分で解決して再実行
- **リリース未完遂**: ビルドだけしてリリーススクリプト未実行は「未完了」。ユーザーにとって完了＝手元にアップデートが届くこと
- **推測リリース**: エラー内容を確認せず推測で修正を連打するな。再現→根本原因特定→修正→実機検証の順守。beta.85-92の教訓: 8回リリースしても直らなかったのはコードではなくFirestoreルールが原因だった
- **インフラ漏れ**: コード変更に連動するインフラ変更（Storage rules, Cloud Runデプロイ, IAM権限）を同一リリースで完結させない限りリリース禁止。詳細は `.claude/rules/infra-sync.md`
- **検証未完了での完了報告**: 全ページ・全機能の正常動作を確認するまで作業を続ける

## バージョン管理

- `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` の3ファイル同期必須
- `./scripts/bump-version.sh` を使用。手動編集禁止
- 同一バージョンでのコード変更再リリース禁止（auto-updaterが反応しない）

## コミット形式

`<type>(<scope>): <日本語説明>` — Co-Authored-Byフッター不要

## ベータファースト戦略

- 大型機能は必ず `release/beta` ブランチ経由。mainに直接入れない
- stable: `releases/latest/download/latest.json` — 全ユーザー
- beta: `releases/download/beta/beta.json` — StatusBarトグルでopt-in
