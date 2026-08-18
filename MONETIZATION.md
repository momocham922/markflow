# MarkFlow 収益化計画（有料サブスク化）

> 確定方針（2026-08-18）: **全5プラットフォーム同時 / 自前決済 / Free・Pro・Team 3ティア / 既存勢は恒久優遇**
> この文書は実装のリファレンス。設計判断はメモリ `monetization_plan.md` にも保存済み。

> **重要な前提（2026-08-18 判明）**: 現在アクティベート済みの全ユーザー（8名 + テスト2 = 12 uid）は**全員社内スタッフ**。
> 社内ツールとして原価は無制限に許容 → 既存勢は「恒久優遇」を具体化して **`plan:"internal"`（メータリング完全バイパス）** とする。
> したがって止血（メータリング）は"緊急対応"ではなく**一般公開の前提条件**。ゲートを本番配信しても社内スタッフには一切影響しない（seed 済み・§4）。

## 実装ステータス（P0 基盤）

| 項目                                                          | 状態                                           |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `entitlements/{uid}` / `usage/**` firestore.rules（書込禁止） | ✅ 実装済（未 deploy）                         |
| ai-proxy 全6エンドポイントに entitlement+usage ゲート挿入     | ✅ 実装済（esbuild bundle 検証 OK・未 deploy） |
| 既存12スタッフを `plan:"internal"` でシード                   | ✅ **本番反映済**（12/12 確認）                |
| ai-proxy 本番デプロイ（Cloud Run）+ ライブ検証                | ⏳ 未（gated: 本番配信は要 GO）                |
| firestore.rules deploy                                        | ⏳ 未（gated）                                 |
| フロント entitlement fetch + UIゲート                         | ⏳ 未（P0残・次段）                            |

## 0. 現状（コード実測サマリ）

- 課金基盤はゼロのグリーンフィールド（`plan`/`tier`/`quota`/`entitlement`/決済SDK すべて未実装）。
- 全AI機能が [server/ai-proxy/index.ts](server/ai-proxy/index.ts) の `verifyFirebaseToken`（ログイン判定のみ）で**無制限開放＝原価出血中**。使用量メータリング・レート制限は皆無。
- 認証は Firebase Auth（Google/GitHub）。`uid`/`email` は全プラットフォーム共通で確立済み → entitlement の統合キーに使える。
- 配信は5経路。**Desktop(macOS DMG / Windows NSIS)・Web はストア外**＝Stripe自由（手数料~3%）。**iOS(App Store)・Android(Play)** はストアIAP原則必須（手数料15〜26%）。

### 出血点（止血が最優先・P0）

1件の録音会議（1時間）で以下が無制限に発生：

| 機能             | 呼び出し回数/セッション          | モデル/API             | 出典                                                                     |
| ---------------- | -------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| ライブSTT        | 約144回（上限4hで約576回）       | chirp_3                | [use-voice-input.ts:5-6](src/hooks/use-voice-input.ts#L5)                |
| 自動リサーチ解析 | 約80回                           | Claude Opus 4.8        | [use-research-pipeline.ts:12-13](src/hooks/use-research-pipeline.ts#L12) |
| grounded検索     | 最大約240回                      | Gemini + Google Search | [index.ts:843](server/ai-proxy/index.ts#L843)                            |
| 自動Structure    | 最大60回 / **max_tokens=64,000** | Claude Opus 4.8        | [VoicePanel.tsx:433](src/components/editor/VoicePanel.tsx#L433)          |
| Refine           | 全長を再STT + Opus 64K整形       | BatchRecognize + Opus  | [VoicePanel.tsx:625](src/components/editor/VoicePanel.tsx#L625)          |

→ **収益化の前提として、これらは必ずメーター化＋上限が必要。** Free枠を設ける以上、無制限提供はマージン崩壊。

---

## 1. ティア設計（Free / Pro / Team）

無料で開放して獲得フックにするもの＝**限界コスト≒0のコモディティ**（エディタ本体・Markdown/プレビュー・Mermaid/OGP/Wikiリンク・マインドマップ/キャンバス/可視化・オフライン・エクスポート・テーマ・MCP/Slack）。

### 機能→ティア マッピング

| 機能                             | Free                    | Pro                          | Team          |
| -------------------------------- | ----------------------- | ---------------------------- | ------------- |
| ローカル編集・全描画・オフライン | ✅ 無制限               | ✅                           | ✅            |
| クラウド同期（Firestore）        | デバイス2台 / 直近N文書 | ✅ 無制限×全4PF              | ✅ 無制限     |
| バージョン履歴                   | ローカルのみ・短期      | クラウド30日                 | 90日          |
| AI執筆（チャット/8アクション）   | 月20回 お試し           | ✅ 月次クレジット + top-up   | ✅ 共有プール |
| 音声→文書化（STT+Opus）          | 月30分 お試し           | ✅ 月X時間 + 従量            | ✅ 共有プール |
| ライブリサーチ                   | 少量お試し（要opt-in）  | ✅ 月次クレジット            | ✅            |
| AI画像生成                       | 月数枚                  | ✅ 月次クレジット            | ✅            |
| Web公開（markflow.jp/p/）        | ❌                      | ✅（数上限・パスワード保護） | ✅            |
| リアルタイム協業（Yjs）          | ❌                      | 限定（自分の文書に招待）     | ✅ 中核       |
| チームフォルダ / 権限 / SSO      | ❌                      | ❌                           | ✅            |
| 優先サポート                     | —                       | ✅                           | ✅            |

### AIクレジット制（COGS防衛の要）

- 高COGS機能（Opusチャット・音声・リサーチ・画像・Web検索）は**定額使い放題にしない**。
- **統一クレジット通貨**＋**音声は分数**で別メーター。超過は購入（top-up）に誘導（Notion `$10/1,000クレジット`、Mem `無料25チャット/月`、Craft `月次クレジット` を範に）。
- クレジット消費レート例（要チューニング。実COGSから算出＝measure-then-derive）：
  - AIチャット/アクション 1回 = 1クレジット（web検索有効時は+）
  - 画像生成 1枚 = N クレジット
  - リサーチ解析ラウンド = M クレジット
  - 音声は「文字起こし分数」で独立カウント（ライブ＋Refineの二重パスを合算）

---

## 2. 価格

| ティア   | 月額                      | 年額（実質/月） | グローバル     |
| -------- | ------------------------- | --------------- | -------------- |
| Free     | ¥0                        | —               | $0             |
| **Pro**  | ¥1,280                    | ¥11,760（¥980） | $8 / 年$72     |
| **Team** | ¥1,980/席（提案・要検証） | ¥19,800/席      | $14/席（提案） |

- ポジショニング＝**AIノート群($10-20)の割安版**（執筆エディタ群$3-6とAIノート群の中間の空白帯）。
- **二重価格**：iOS/AndroidのIAPはApple/Google手数料(15〜26%)を吸収するため割高に（例 モバイル¥1,600/月 vs Web¥1,280/月）。ただし**モバイルアプリ内からWeb価格へ誘導するのはNG**（米国外anti-steering）。案内はメール等アプリ外で。
- 学割40%・複数デバイス/ファミリー割を併設（Obsidian/Ulysses/Craft踏襲）。
- top-up（クレジット追加購入）を全ティアに用意。

---

## 3. 決済アーキテクチャ（自前）

### 3.1 データモデル（Firestore）

```
entitlements/{uid}          # 真実源。クライアント書込禁止（Admin SDK/Webhookのみ）
  plan: "free" | "pro" | "team" | "internal"   # internal = 社内スタッフ・無制限
  status: "active" | "grace" | "on_hold" | "canceled" | "expired"
  source: "stripe" | "app_store" | "play" | "founder"
  currentPeriodEnd: <ts>
  earlySupporter: bool       # 恒久優遇フラグ
  teamId?: <id>
  updatedAt: <ts>

usage/{uid}/months/{yyyy-mm} # 使用量カウンタ。サーバ専用書込（実装済のカウンタ名）
  aiCalls: number            # chat + research analyze + grounded-search
  sttCalls: number           # ライブSTTチャンク数
  batchMin: number           # BatchRecognize 累積分数
  images: number             # 画像生成枚数
  plan: string               # 消費時点のプラン（監査用）
  period: "yyyy-mm"
  updatedAt: <ts>

teams/{teamId}               # 既存のチーム構造を拡張
  seats: number
  members: [...]
  sharedCreditPool: number
```

- **firestore.rules**: `entitlements/{uid}` と `usage/{uid}/months/{ym}` は `allow read: if owner; allow write: if false;`（現状 `users`/`user_settings` は本人書込可なので真実源にできない — ここに `plan` を置くと自己付与でPro化される）。**実装済**（[firestore.rules](firebase/firestore.rules)）。
- **オフライン**: entitlement を SQLite にミラー（読取専用キャッシュ）。実効判定は必ずサーバ側。
- **カウンタは launch placeholder**: 現状は「回数ベース」の粗いメーター（`aiCalls`/`sttCalls`/`images` は1回=1、`batchMin` は分数）。一般公開前に実COGSから分/トークンベースへ精緻化（measure-then-derive）。

### 3.2 実効ゲート（ai-proxy）

- [server/ai-proxy/index.ts](server/ai-proxy/index.ts) の `verifyFirebaseToken` 直後に**entitlement + usage 照合レイヤー**を挿入。**実装済**（`loadEntitlement`/`guard` 関数 + 全6エンドポイント配線）。
  - `guard(res, uid, feature, cost)`: `entitlements/{uid}` を読み（60秒キャッシュ）、`plan==="internal"` は完全バイパス。それ以外は当月 `usage` をトランザクションで **check + increment** し、超過なら **429 quota_exceeded** を返す。
  - フェイルセーフ: entitlement 読取失敗時は `free`（無制限ではない）へ、メータリング tx 失敗時は fail-open（プロダクトを止めない）。いずれも `console.error` で明示ログ（サイレント禁止）。env `INTERNAL_UIDS`（カンマ区切り）でスタッフ uid の追加保険。
  - エンドポイント→feature 対応: transcribe→`sttCalls` / batch-transcribe→`batchMin`（分数） / image→`images` / analyze・grounded・chat→`aiCalls`。
  - 超過は **429 Too Many Requests**（`{error:"quota_exceeded", feature, plan, limit, used}`）で明示的失敗。決済必須系は将来 402 併用可。
- 前例: `batch-transcribe` が uid で GCS パスを検証し403を返す（[index.ts:361-366](server/ai-proxy/index.ts#L361)）＝同位置・同思想。
- クライアントゲートは**回避可能**（`VITE_AI_PROXY_URL`・IDトークンはdevtoolsで取得可）。UIゲートはUX用、実効ゲートは必ずサーバ側 = 二重防御（storage.rules audio制限 + proxy再検証と同じモデル）。

### 3.3 決済レール別（統合キー = Firebase UID）

**A. Stripe（macOS / Windows / Web）**

- Cloud Run で Checkout Session 生成（`client_reference_id = uid`）→ Tauri はシステムブラウザで開く（opener/shellプラグイン）→ カスタムURLスキーム `markflow://` でディープリンク復帰。
- Webhook（`checkout.session.completed`, `customer.subscription.updated/deleted`）→ Cloud Run → Admin SDK → `entitlements/{uid}` 更新。冪等化（event id）・署名検証必須。
- 解約/カード更新は Stripe Customer Portal へリダイレクト。
- **解約≠失効**：`current_period_end` まで有効。

**B. StoreKit 2（iOS）**

- Tauri IAPブリッジ（コミュニティ製 `spicavi/tauri-plugin-purchases` or `Choochmeque/tauri-plugin-iap`、**要保守状況の実測検証**。無ければ objc2 で自前ブリッジ）。
- 購入 → 署名済み JWS トランザクション → Cloud Run → **App Store Server API v2** で検証（verifyReceipt/通知v1はdeprecated）。
- **App Store Server Notifications v2**（Webhook）→ `entitlements/{uid}` 更新。`appAccountToken = uid` で名寄せ。
- Small Business Program（<$1M で15%）を初年度から申請（毎年）。サブスク2年目以降は自動15%。

**C. Play Billing（Android）**

- Tauri Kotlinブリッジ（`tauri-plugin-iap` 等）。**Billing Library v8必須（2026-08-31〜、v9推奨）**。購入は3日以内にacknowledge必須（未確認は自動返金）。
- purchaseToken → Cloud Run → **Play Developer API `purchases.subscriptionsv2.get`** で検証。`obfuscatedAccountId = uid`。
- **RTDN（Pub/Sub）** → Cloud Run → `entitlements/{uid}` 更新。`SUBSCRIPTION_STATE_ACTIVE`/`_IN_GRACE_PERIOD` は付与、`_ON_HOLD`/`_EXPIRED`/revoke は剥奪。
- 日本は User Choice Billing（非ゲーム対象・手数料4%減＝実効約11%）の検討余地。

### 3.4 Multiplatformの合法性

- Web/desktopのStripe購入 → モバイルはログインで解錠は **Apple 3.1.3(b) / Google consumption-only で合法**。ただし同一Proを iOS IAP / Play Billing でも並置提供する（3.1.3bの条件）。
- **NG**: モバイルアプリ内からStripe決済へ誘導（米国以外はanti-steering違反）。

---

## 4. 既存ユーザーの恒久優遇（＝社内スタッフ・internal）

- **現状のアクティベート済み12 uid は全員社内スタッフ**（8名 + テスト2）。外部顧客の Founders ではない → 原価無制限を許容し **`plan:"internal"`（メータリング完全バイパス）** を付与。
- **seed 済み（本番反映確認）**: [scripts/seed-internal-entitlements.sh](scripts/seed-internal-entitlements.sh) が `entitlements/{uid}` に `plan:"internal", status:"active", source:"founder", earlySupporter:true` を冪等 PATCH（`--account ga.crossmedia@gmail.com`・REST）。12/12 反映確認済み。
- これにより**ゲートを本番配信しても社内スタッフには影響ゼロ**（配信前に whitelist 完了 = blast radius ゼロ）。
- **将来 外部の一般公開時**: 新規ユーザーには Free/Pro/Team を適用。もし外部ベータ勢（＝社外の早期ユーザー）が生じたら、その時は `earlySupporter` + fair-use 上限付きの優遇（恒久“無制限”は原価的に不可）を別途設計。現段階では該当なし。
- シード済み uid 一覧（監査用）はスクリプト内コメント参照。将来スタッフ追加時は同スクリプトに uid を足して再実行（冪等）。

---

## 5. 実装ロードマップ

> ローンチは全5PF同時。ただし内部ビルド順は依存関係に従い、最後に収束して同時ローンチ。

### P0 — 止血 + entitlement基盤（収益化の土台）

1. ✅ `entitlements/{uid}` / `usage/{uid}/months/{ym}` スキーマ + **firestore.rules（クライアント書込禁止）**（実装済・deploy 待ち）
2. ✅ ai-proxy に entitlement+usage 照合レイヤー（`verifyFirebaseToken` 直後）→ 429（実装済・deploy 待ち）
3. ✅ 全6AIエンドポイントに使用量メータリング（sttCalls / batchMin / images / aiCalls）
4. ✅ 既存12スタッフを `plan:"internal"` でシード（本番反映済）
5. ⏳ **deploy**: firestore.rules + ai-proxy を本番反映 → リビジョン確認 + curl ライブ検証（gated: 要 GO）
6. ⏳ クライアント: entitlement をログイン時 fetch（`auth-store` へ）+ SQLiteミラー
7. ⏳ UIゲート: [AiPanel.tsx](src/components/ai-panel/AiPanel.tsx) の `if(!user)` ウォール隣に upsell、VoicePanel/ResearchSheet 同型

### P1 — Stripe（Desktop + Web）

6. Cloud Run: Checkout Session 生成 + Webhook（署名検証・冪等）+ Customer Portal
7. Tauri: システムブラウザ起動 + `markflow://` ディープリンク復帰
8. クレジット残数UI + top-up 購入導線

### P2 — モバイルIAP（iOS + Android）

9. iOS: StoreKit2ブリッジ + App Store Server API v2検証 + Notifications v2受信
10. Android: Play Billingブリッジ(v8+) + subscriptionsv2検証 + RTDN(Pub/Sub)受信
11. ストア横断名寄せ（uid統合）テスト・sandbox検証

### P3 — Team + Founders + ローンチ

12. Team: 席課金・共有クレジットプール・チーム権限/SSO（既存 team 構造拡張）
13. Founders: 既存ユーザースナップショット → 恒久フラグ付与
14. 価格表・課金設定UI・請求管理（StatusBar 等）
15. 全PF同時ローンチ

---

## 6. インフラ連動チェック（`.claude/rules/infra-sync.md` 準拠）

コード変更と**同一リリースで完結**させる：

- [x] `firestore.rules`: `entitlements`/`usage` 追加ルール（実装済）→ **deploy 未**（`firebase deploy --only firestore:rules --project markflow-app-2026`）
- [x] ai-proxy: entitlement+usage ゲート（実装済・esbuild bundle OK）→ **Cloud Run 再デプロイ 未** + リビジョン100%確認 + curl でライブ検証（INTERNAL_UIDS env も併せ設定）
- [ ] Cloud Run 新エンドポイント: Stripe Webhook / App Store Notifications v2 / Play RTDN(Pub/Sub subscription)
- [ ] Pub/Sub トピック + サブスク作成（Play RTDN 用）+ IAM
- [ ] GCP: Play Developer API 有効化 + サービスアカウント権限（既存 `play-api-key.json` 拡張 or 新規）
- [ ] App Store Connect: App Store Server API キー + Notifications v2 URL 登録
- [ ] Stripe: 本番キー（Secret Manager必須・.env禁止）・Webhook署名シークレット
- [ ] 環境変数: Cloud Run env + ビルド埋め込み（`VITE_*`）両方

## 7. 未確定・要検証（実装前リサーチ）

- Tauri IAPコミュニティプラグインの保守状況・StoreKit2/Play Billing v8対応度（実測）
- Team席課金の価格（¥1,980/席は提案値。競合Notion Business ¥3,150等と要照合）
- クレジット消費レート（実COGSから measure-then-derive）
- 日本 User Choice Billing 採用可否（非ゲーム・手数料4%減）
- Founders の fair-use 上限値
