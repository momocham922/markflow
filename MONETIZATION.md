# MarkFlow 収益化計画（有料サブスク化）

> 確定方針（2026-08-18）: **全5プラットフォーム同時 / 自前決済 / Free・Pro・Team 3ティア / 既存勢は恒久優遇**
> この文書は実装のリファレンス。設計判断はメモリ `monetization_plan.md` にも保存済み。

> **重要な前提（2026-08-18 判明）**: 現在アクティベート済みの全ユーザー（8名 + テスト2 = 12 uid）は**全員社内スタッフ**。
> 社内ツールとして原価は無制限に許容 → 既存勢は「恒久優遇」を具体化して **`plan:"internal"`（メータリング完全バイパス）** とする。
> したがって止血（メータリング）は"緊急対応"ではなく**一般公開の前提条件**。ゲートを本番配信しても社内スタッフには一切影響しない（seed 済み・§4）。

## 実装ステータス（P0 基盤）

| 項目                                                          | 状態                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `entitlements/{uid}` / `usage/**` firestore.rules（書込禁止） | ✅ **本番 deploy 済**（live ruleset 確認）              |
| ai-proxy 全6エンドポイントに entitlement+usage ゲート挿入     | ✅ **本番 deploy 済**（rev 00035-4sf @100%）            |
| 既存12スタッフを `plan:"internal"` でシード                   | ✅ **本番反映済**（12/12 確認）                         |
| ai-proxy 本番デプロイ（Cloud Run）+ ライブ検証                | ✅ **完了**（rev 00035-4sf・timeout 900・env 検証済）   |
| オーナー view-as（`X-View-As` / `/v1/me/entitlement`）        | ✅ **本番 deploy 済**（`OWNER_UIDS` 2件・401 probe OK） |
| フロント entitlement fetch + view-as UI + quota upsell        | ✅ 実装済（tsc/build/unit 通過・アプリ配信は要 GO）     |

## 実装ステータス（P1 Stripe課金 — ダーク実装・本番デプロイ済）

> 2026-08-20: Stripeサブスク課金の全経路をコード実装し、本番 Cloud Run に**ダークデプロイ済**（`STRIPE_*` 未設定のため `/v1/billing/*` は 503 `billing_not_configured` を返す＝サイレント無効でなく明示失敗）。既存の全AI/STTエンドポイントは無影響（401 auth-required を確認・回帰なし）。**課金を実際に点灯させるにはオーナー作業（§3.5 ランブック）のみ**が残る。

| 項目                                                                     | 状態                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| billing.ts 純ロジック（price↔plan/status写像/順序保証/書込判断）         | ✅ 実装 + 単体テスト（vitest 176 通過）                             |
| metering.ts 抽出（reserve→reconcile/refund を純ロジック化）              | ✅ 実装 + 単体テスト                                                |
| ai-proxy `/v1/billing/{checkout,portal,webhook}` 配線                    | ✅ **本番 deploy 済**（rev 00041-jss @100%・503 dark 確認）         |
| Webhook 冪等（event.id・成功後マーク）+ 署名検証 + サブスク再取得        | ✅ 実装（stripeEvents/{id} で dedupe・process-before-ACK）          |
| 同一秒タイのタイブレーク / checkout 二重契約 409 / revoke フェイルセーフ | ✅ 実装（billing.test.ts で網羅）                                   |
| firestore.rules: stripeEvents / stripeCustomers（クライアント全拒否）    | ✅ **本番 deploy 済**（ruleset 4a946e82 が cloud.firestore に反映） |
| hosting: Checkout 戻りページ（markflow://billing/success\|cancel）       | ✅ コミット済（`markflow-site` 再デプロイは GO 時）                 |
| クライアント課金UI（PaywallDialog・UserMenu・StatusBar）                 | ✅ 実装済・`VITE_BILLING_ENABLED` で既定 OFF ゲート（配信は要 GO）  |
| Stripe アカウント/商品/価格・Secret 登録・env 点灯                       | ⏳ **オーナー作業（§3.5）**                                         |

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
| 自動リサーチ解析 | 約80回                           | Claude Opus 5          | [use-research-pipeline.ts:12-13](src/hooks/use-research-pipeline.ts#L12) |
| grounded検索     | 最大約240回                      | Gemini + Google Search | [index.ts:843](server/ai-proxy/index.ts#L843)                            |
| 自動Structure    | 最大60回 / **max_tokens=64,000** | Claude Opus 5          | [VoicePanel.tsx:433](src/components/editor/VoicePanel.tsx#L433)          |
| Refine           | 全長を再STT + Opus 64K整形       | BatchRecognize + Opus  | [VoicePanel.tsx:625](src/components/editor/VoicePanel.tsx#L625)          |

→ **収益化の前提として、これらは必ずメーター化＋上限が必要。** Free枠を設ける以上、無制限提供はマージン崩壊。

---

## 1. ティア設計（Free / Pro / Team / Enterprise）

> **2026-08-21 確定（フラット回数制に統一）**: クレジット制（重み付けcr）は**不採用**。実装済みのサーバ実効ゲート（[server/ai-proxy/gating.ts](server/ai-proxy/gating.ts) `PLAN_LIMITS`）＝**機能別・月間の平坦な回数上限**を唯一の課金モデルとする。理由: (1) 既にサーバ側で回数メーターが本番稼働（`aiCalls`/`sttCalls`/`batchMin`/`images`）しており真実源はこれ、(2) UI（[PaywallDialog.tsx](src/components/PaywallDialog.tsx)）も「月2,000回」等の回数表記で配線済み、(3) crの内部換算はユーザーに不透明で残量把握が難しい。残量メーターは**回数 X/Y**（例: AIリクエスト 1,340/2,000）で表示する。原価分析（§1.1）は上限値を実COGSに合わせて較正するための参照として維持する。AIモデルは **Claude Opus 5**（Vertex `claude-opus-5` @ global、入力$5/M・出力$25/M）。

無料で開放して獲得フックにするもの＝**限界コスト≒0のコモディティ**（エディタ本体・Markdown/プレビュー・Mermaid/OGP/Wikiリンク・マインドマップ/キャンバス/可視化・オフライン・エクスポート・テーマ・MCP/Slack）。

### 1.1 検証済み実単価（一次情報・2026-08 WebSearch）

| 項目                    | 単価                                                           | 確度               | 出典                                    |
| ----------------------- | -------------------------------------------------------------- | ------------------ | --------------------------------------- |
| Claude Opus 5           | $5/M 入力・$25/M 出力                                          | 実測               | platform.claude.com/pricing             |
| STT chirp_3 ライブ      | $0.016/分                                                      | 実測               | cloud.google.com/speech-to-text/pricing |
| STT Dynamic Batch       | ~$0.004/分（75%減・要opt-in）                                  | 実測（適用は推定） | 同上                                    |
| NanoBanana2 画像 1K     | $0.067/枚（Batch 50%off=$0.034）                               | 実測               | ai.google.dev pricing                   |
| Google Search grounding | 月5,000無料→$14/1,000クエリ（Gemini3は**検索クエリ単位**課金） | 実測               | ai.google.dev pricing                   |
| Gemini 3.x Flash        | $1.5/M・$9/M                                                   | 推定               | ai.google.dev pricing                   |

### 1.2 課金モデル＝機能別・月間の平坦な回数上限（実装＝真実源）

課金の単位は**機能ごとに独立した「月間◯回」**。サーバ（[gating.ts](server/ai-proxy/gating.ts) `PLAN_LIMITS`）が唯一の実効上限で、`-1` は無制限、`internal` は完全バイパス。当月使用量は `usage/{poolKey}/months/{yyyy-mm}` に加算され、JST 月初にリセット。

| メーター（feature） | 数える対象                                          | Free | Pro   | Team（／席） | 単位  |
| ------------------- | --------------------------------------------------- | ---- | ----- | ------------ | ----- |
| `aiCalls`           | AIチャット + ライブリサーチ解析 + grounded-search   | 30   | 2,000 | 4,000        | 回/月 |
| `sttCalls`          | ライブSTTチャンク（会議中のリアルタイム文字起こし） | 100  | 6,000 | 12,000       | 回/月 |
| `batchMin`          | BatchRecognize（refine／一括文字起こし）の実測分数  | 60   | 3,000 | 6,000        | 分/月 |
| `images`            | AI画像生成（NanoBanana2）                           | 2    | 500   | 1,000        | 枚/月 |

- **これらの数値は起点のプレースホルダ**（[gating.ts:19-22](server/ai-proxy/gating.ts#L19)）。一般公開前に §1.1 の実COGSから較正する（measure-then-derive）。変更は `PLAN_LIMITS` のみを編集すれば全PF・全ゲート・残量メーターに即反映される（単一ソース）。
- **Team はプール共有**: `usage/{teamId}` の単一カウンタに全メンバーの消費が乗り、上限は `base × 席数`（[checkQuota](server/ai-proxy/gating.ts#L126) `seats`）。オーナーは自席を消費せず常にアクセス可。
- **`batchMin` だけは分数**（回数でなく実測分）。他3つは「1操作=1回」。上限超過は **429 `quota_exceeded`**（`{feature, plan, limit, used}`）で明示失敗。
- **音声→文書化の1セッション**は `sttCalls`（ライブ中のチャンク）と `batchMin`（refine時の再STT分数）を別軸で消費する。
- refine（高品質整形）は品質が実験段階のため既定 Flash・UI上は控えめに提供（隠し機能）。課金上は `batchMin` に集約され、専用の追加メーターは設けない。

### 1.3 機能→ティア マッピング

| 機能                             | Free                         | Pro                               | Team                              | Enterprise       |
| -------------------------------- | ---------------------------- | --------------------------------- | --------------------------------- | ---------------- |
| ローカル編集・全描画・オフライン | ✅ 無制限                    | ✅                                | ✅                                | ✅               |
| クラウド同期（Firestore）        | 2台 / 50文書 / 1GB           | ✅ 無制限（公正利用）×全PF        | ✅ プール+管理者制御              | ✅               |
| バージョン履歴                   | ローカル無制限 / クラウド7日 | クラウド30日                      | 90日〜                            | 保持ポリシー可   |
| AI執筆（`aiCalls`回）            | 30回/月（Opus 5）            | 2,000回/月                        | 4,000回/月・席（プール）          | committed-use    |
| 音声→文書化（`batchMin`分）      | 60分・Flash整形              | 3,000分・Flash refine既定         | 6,000分/席プール                  | committed-use    |
| 音声refineモデル                 | Flashのみ                    | Flash既定 +（Opusは隠し/実験）    | Flash既定 +（Opusは隠し/実験）    | —                |
| ライブリサーチ + grounded-search | 手動2-3回のみ・自動不可      | opt-in・既定OFF+支出上限+費用明示 | +管理者キャップ・プール           | +committed-use   |
| AI画像生成（別枠 `images`）      | 月2枚                        | 月500枚                           | 月1,000枚/席（プール）            | committed-use    |
| Web公開（markflow.jp/p/）        | ❌                           | 10ページ + PW保護                 | 無制限 + 独自ドメイン             | +高度管理        |
| リアルタイム協業（Yjs）          | ゲスト0                      | ゲスト2-3名                       | **メンバー/ゲスト無制限（中核）** | ✅               |
| カスタム語彙 / ベクトル横断検索  | ❌                           | ✅                                | チーム共有辞書                    | ✅               |
| API/自動化（MCP・Webhook）       | 接続入口のみ                 | 個人スコープ                      | 組織連携                          | 組織連携+        |
| SSO / 監査 / ロール権限          | ❌                           | ❌                                | SAML SSO + 監査 + ロール          | **SCIM/DPA/SLA** |
| 消費上限・予算管理               | 上限到達で停止               | 機能別 回数メーター（X/Y）        | 席別/機能別キャップ+予算アラート  | committed-use    |
| サポート                         | コミュニティ                 | 優先メール                        | SLA付き                           | 専任             |

### 1.4 各ティア（価格・枠・粗利方針）

> 枠は全て `PLAN_LIMITS`（[gating.ts](server/ai-proxy/gating.ts)）由来の**月間回数/分数**。この表は編集しない — 数値変更は `PLAN_LIMITS` を編集し、当表とメーターUIは自動的に追従する（単一ソース）。

| ティア         | 価格          | `aiCalls`/月  | `sttCalls`/月 | `batchMin`/月  | `images`/月   | 目標粗利                                     |
| -------------- | ------------- | ------------- | ------------- | -------------- | ------------- | -------------------------------------------- |
| **Free**       | ¥0            | 30            | 100           | 60分           | 2枚           | 獲得コスト（実COGS ≈ $1-2）                  |
| **Pro**        | ¥1,280/月     | 2,000         | 6,000         | 3,000分（50h） | 500枚         | 中央値利用で55-65%（満額≈break-even）        |
| **Team**       | ¥1,980/席・月 | 4,000/席      | 12,000/席     | 6,000分/席     | 1,000枚/席    | 50-60%（プール平準化+席別上限）              |
| **Enterprise** | 見積          | committed-use | committed-use | committed-use  | committed-use | 高（価格弾力性の低いガバナンス機能で裏付け） |

- **Free**: 毎月 JST 月初リセット・繰越なし。Opus 5 の品質を体験させ、`aiCalls`/音声/公開/同時編集の壁でPro転換を促す。
- **Pro**: ルーティン執筆を Flash ハイブリッド化して実消費を枠の約60%へ抑制（ヘッドルーム確保）。自動リサーチは既定OFF+opt-in で原価爆弾を物理停止。上限超過は 429 で明示停止（サイレント赤字ゼロ）。
- **Team**: `usage/{teamId}` プール共有で上限 = `base × 席数`。席別/機能別ハードキャップ+管理者予算アラートで「鯨2名が5名を飢餓」破綻を防止。SAML SSO+監査はTeam同梱、SCIM/DPA/専任SLAはEnterpriseへ分離。
- **Enterprise（新設）**: 消費者3ティアは維持しつつ上位に見積制を接ぎ木。committed-useで予測可能請求。

### 1.5 上限超過時の扱い（アドオン・Top-up は将来検討）

- 現行モデルでは**上限に達したら 429 `quota_exceeded` で明示停止**（サイレント課金・自動従量なし）。ユーザーは翌月リセットまで待つか上位プランへアップグレードする。
- **Voice Booster / Top-up（クレジット追加購入・音声パック）は将来の拡張候補**（未実装・未確定）。導入する場合も課金単位はクレジットでなく**該当メーターの回数/分数の追加枠**として `PLAN_LIMITS` の上に加算する設計にする（クレジット制は不採用のため二重の単位系を作らない）。
- ヘビー音声（`batchMin` 常時上限張り付き）ユーザーは、専用アドオンを設けるか Team/Enterprise の committed-use へ誘導するかをローンチ後テレメトリで判断する。

---

## 2. 価格

| ティア         | 月額                      | 年額（実質/月）        | グローバル     |
| -------------- | ------------------------- | ---------------------- | -------------- |
| Free           | ¥0                        | —                      | $0             |
| **Pro**        | ¥1,280                    | ¥11,760（¥980 / -23%） | $8 / 年$72     |
| **Team**       | ¥1,980/席（提案・要検証） | ¥19,800/席             | $14/席（提案） |
| **Enterprise** | 見積                      | 見積（年間コミット）   | 見積           |

- ポジショニング＝**AIノート群($10-20)の割安版**（執筆エディタ群$3-6とAIノート群の中間の空白帯）。
- **二重価格**：iOS/AndroidのIAPはApple/Google手数料(15〜26%)を吸収するため割高に（例 モバイル¥1,600/月 vs Web¥1,280/月・Team ¥2,400/席）。ただし**モバイルアプリ内からWeb価格へ誘導するのはNG**（米国外anti-steering）。案内はメール等アプリ外で。
- **年割強化＝買い切り志向層の受け皿（確定方針）**: 買い切り志向（Typora/Bear/Superwhisper Lifetime 等）には Lifetime を用意せず、**年割の割安感（Pro 年¥11,760＝実質¥980/月・月比 -23%）で対抗**。長期割の追加拡充も検討。
- 学割40%・複数デバイス/ファミリー割を併設（Obsidian/Ulysses/Craft踏襲）。
- **アドオン/Top-up は将来検討（未実装）**: ヘビー音声向けの追加枠は、導入する場合も**該当メーター（`batchMin` 等）の回数/分数を上乗せする方式**とし、クレジット制は採らない（§1.5）。

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
  seats: number              # 席数。プール上限 = base × seats
  members: [...]             # 席割当。usage/{teamId} を全メンバーで共有消費
```

- **firestore.rules**: `entitlements/{uid}` と `usage/{uid}/months/{ym}` は `allow read: if owner; allow write: if false;`（現状 `users`/`user_settings` は本人書込可なので真実源にできない — ここに `plan` を置くと自己付与でPro化される）。**実装済**（[firestore.rules](firebase/firestore.rules)）。
- **オフライン**: entitlement を SQLite にミラー（読取専用キャッシュ）。実効判定は必ずサーバ側。
- **カウンタ＝課金モデルそのもの**（フラット回数制）: `aiCalls`/`sttCalls`/`images` は1操作=1回、`batchMin` のみ実測分数。上限値（`PLAN_LIMITS`）は launch placeholder で、一般公開前に §1.1 実COGSから較正（measure-then-derive）。単位（回数/分数）は変えない。

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

### 3.5 Stripe 本番有効化ランブック（オーナー作業・GO 時のみ）

> コード・インフラ基盤は全てデプロイ済（rev 00041-jss・ダーク）。以下は**課金を点灯させる最終手順**。順序厳守。各手順の値は次の手順で使うので都度控える。GCP 操作は必ず `--account ga.crossmedia@gmail.com`。**手順を端折らない**。

**前提**: Stripe 本番アカウント作成済み・日本の事業者情報/銀行口座登録済み・本番モードが有効化済み。

**手順 1 — 商品と価格を作成**（Stripe Dashboard → 「商品カタログ」→「商品を追加」）

1. 商品名「MarkFlow Pro」を作成 →「価格を追加」で 2 つ作る:
   - 月額: 金額 `¥1,280` / 請求期間「月次」/ 通貨 JPY → 保存 → price ID（`price_...`）を控える＝**PRO_MONTHLY**
   - 年額: 金額 `¥11,760` / 請求期間「年次」→ price ID を控える＝**PRO_YEARLY**
2. 商品名「MarkFlow Team」を作成 →「価格を追加」:
   - 月額: `¥1,980`（席課金は当面「数量」で運用）→ price ID＝**TEAM_MONTHLY**
   - 年額: `¥19,800` → price ID＝**TEAM_YEARLY**
   - ※ Team を今回出さないなら TEAM の 2 つは空のままで可（コードは空 price を無視＝そのプランの checkout が 400 になるだけ）。

**手順 2 — カスタマーポータルを有効化**（Dashboard → 「設定」→「Billing」→「カスタマーポータル」）

1. 「有効化」をオン。
2. 許可する操作:「サブスクリプションのキャンセル」「支払い方法の更新」（プラン変更は任意）にチェック。
3. ビジネス情報（規約 URL・プライバシー URL）を入力して保存。

**手順 3 — API シークレットキーを取得**（Dashboard 右上が「本番環境」であることを確認 →「開発者」→「API キー」）

1. 「シークレットキー」の「本番環境キーを表示」→ `sk_live_...` をコピー＝**STRIPE_SECRET_KEY**。

**手順 4 — Webhook エンドポイントを登録**（「開発者」→「Webhook」→「エンドポイントを追加」）

1. エンドポイント URL に正確に貼る:
   `https://markflow-ai-proxy-636447248627.asia-northeast1.run.app/v1/billing/webhook`
2. 「バージョン」ドロップダウンを開き **`2026-07-29.dahlia`** を選ぶ（コードの `STRIPE_API_VERSION` と一致必須。ズレると item 単位の請求期間 JSON 形が合わず `current_period_end` が取れない）。
3. 「イベントを選択」で次の 4 つを 1 つずつ追加:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. 「エンドポイントを追加」→ 作成後の画面で「署名シークレット」を表示 → `whsec_...` をコピー＝**STRIPE_WEBHOOK_SECRET**。

**手順 5 — Secret Manager にシークレットを登録**（機密は Secret Manager のみ・.env 禁止）

```bash
ACC=ga.crossmedia@gmail.com; PROJ=markflow-app-2026
printf '%s' 'sk_live_XXXX'  | gcloud secrets create stripe-secret-key    --project $PROJ --account $ACC --replication-policy=automatic --data-file=- 2>/dev/null \
  || printf '%s' 'sk_live_XXXX'  | gcloud secrets versions add stripe-secret-key    --project $PROJ --account $ACC --data-file=-
printf '%s' 'whsec_XXXX'    | gcloud secrets create stripe-webhook-secret --project $PROJ --account $ACC --replication-policy=automatic --data-file=- 2>/dev/null \
  || printf '%s' 'whsec_XXXX'    | gcloud secrets versions add stripe-webhook-secret --project $PROJ --account $ACC --data-file=-
# Cloud Run ランタイム SA に accessor 付与（636447248627-compute）
for S in stripe-secret-key stripe-webhook-secret; do
  gcloud secrets add-iam-policy-binding $S --project $PROJ --account $ACC \
    --member=serviceAccount:636447248627-compute@developer.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor; done
```

**手順 6 — Cloud Run に env / secret を注入して点灯**（`--update-*` でマージ。既存 `INTERNAL_UIDS`/`OWNER_UIDS`/`CLAUDE_MODEL`/`GCP_*` を絶対に消さない。`--timeout 900` 厳守）

```bash
gcloud run deploy markflow-ai-proxy --source server/ai-proxy \
  --project markflow-app-2026 --region asia-northeast1 --account ga.crossmedia@gmail.com \
  --allow-unauthenticated --memory 512Mi --timeout 900 --min-instances 0 --max-instances 3 \
  --update-secrets=STRIPE_SECRET_KEY=stripe-secret-key:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook-secret:latest \
  --update-env-vars=STRIPE_PRICE_PRO_MONTHLY=price_XXX,STRIPE_PRICE_PRO_YEARLY=price_XXX,STRIPE_PRICE_TEAM_MONTHLY=price_XXX,STRIPE_PRICE_TEAM_YEARLY=price_XXX,NONAI_GATES_ENABLED=1
# URL は既定で markflow.jp/checkout/success|cancel・/account を使用。変える場合のみ
#   CHECKOUT_SUCCESS_URL / CHECKOUT_CANCEL_URL / PORTAL_RETURN_URL を追加（success には ?session_id={CHECKOUT_SESSION_ID} を残す）。
```

> **`NONAI_GATES_ENABLED=1` の意味**（§3.6 参照）: 非AIゲートのサーバ側実効化（現状は Web 公開ページの配信ゲート `/p/`）を点灯するマスタースイッチ。既定 OFF。`billingConfigured()` と**分離**しているのは、本番 Cloud Run に既に **TEST モードの Stripe キーが載っている**ため（`billingConfigured()===true`）。もし配信ゲートを `billingConfigured()` に紐づけると **GO 前に公開ページを 402 で止めてしまう**。クライアント側の `VITE_BILLING_ENABLED`（ビルド時 OFF・手順 8）と対になり、両方 GO 時に同時点灯する。

**手順 7 — hosting（Checkout 戻りページ）をデプロイ**

- `markflow-site`（nginx）に `hosting/checkout/success` `hosting/checkout/cancel` を含めて再デプロイ（nginx ルートは追加済み）。`PORTAL_RETURN_URL` の既定 `markflow.jp/account` が未整備なら、暫定で `https://markflow.jp/` に変更するか `/account` ページを用意。

**手順 8 — クライアント配信**（billing UI を解禁）

- `VITE_BILLING_ENABLED=1` を付けて 4PF ビルド → `./scripts/bump-version.sh` → 各 release スクリプト（§ CLAUDE.md リリースフロー）。モバイルは anti-steering 遵守（Stripe/Web 価格へ誘導しない）。

**手順 9 — 検証（点灯確認）**

```bash
BASE=https://markflow-ai-proxy-636447248627.asia-northeast1.run.app
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/billing/webhook -d '{}'   # 503→400(署名不正)に変われば点灯
```

- Stripe Dashboard の Webhook 画面「テスト送信」で `checkout.session.completed` を送り 2xx を確認。
- テスト実購入（少額 price でも可）→ `entitlements/{uid}` が `plan:"pro", status:"active", source:"stripe"` になることを Firestore で確認 → アプリ側で Pro 反映を確認。
- 解約 → `customer.subscription.deleted` 受信で `status` 遷移（`current_period_end` まで有効）を確認。

---

### 3.6 非AIゲートの実装ステータス（AI/STT 以外の有料機能ゲート）

> AI/STT/画像は ai-proxy のメータリングで実効ゲート済み（§3.2・429 `quota_exceeded`）。ここでは**それ以外**の有料機能ゲート（§1.3 マッピング）の実装状況を正直に記録する。クライアント側ゲートは `VITE_BILLING_ENABLED`（ビルド時・既定 OFF）、サーバ側の非AIゲートは `NONAI_GATES_ENABLED`（Cloud Run env・既定 OFF）で二重に暗転しており、**GO まで完全に不活性**。

| 有料機能                     | ゲート層              | 状態      | 実装 / 保留理由                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web 公開（Pro+）             | クライアント + サーバ | ✅ 実装済 | クライアント: [App.tsx](src/App.tsx) `handlePublish` で free を弾き paywall（`BILLING_ENABLED`）。サーバ: publish は Storage 直書きのため配信時が唯一の実効点 → [/p/ ハンドラ](server/ai-proxy/index.ts) が所有者 free の公開ページを 402 で拒否（`NONAI_GATES_ENABLED`・所有者 internal/Pro は透過・lookup 失敗は fail-open） |
| 共同編集ゲスト（Pro+）       | クライアント          | ✅ 実装済 | [ShareDialog.tsx](src/components/ShareDialog.tsx) `handleInvite` で `collaboratorLimit(plan)`（free:0 / pro:3 / team+internal:∞）超過を弾き paywall（`BILLING_ENABLED`）。ヘルパは [entitlement-store.ts](src/stores/entitlement-store.ts)                                                                                     |
| 共同編集ゲスト（サーバ強制） | firestore.rules       | ⏳ 保留   | 招待数の上限をルールで fail-closed にすると**既存の共有ドキュメントの編集経路**を壊すリスク（コア編集パスに人数カウント制約を課す）。GO 後にサーバ側（Cloud Function もしくは招待時の proxy 経由バリデーション）で安全に実装する。現状クライアントゲートのみ                                                                   |
| カスタム語彙（Team）         | —                     | ⏳ 保留   | 現状は STT hints の**自動生成**のみで、ユーザー管理機能として未製品化。機能自体を作ってからゲートする                                                                                                                                                                                                                          |
| ベクトル検索（Pro+）         | —                     | ⏳ 未実装 | 機能自体が未存在（[project_vector_search_plan](.claude/…)）。実装時にゲートを同梱                                                                                                                                                                                                                                              |
| クラウド同期上限             | —                     | ⏳ 保留   | デバイス数/ドキュメント数/容量のメータリング基盤が未整備。導入時に usage スキーマを拡張してゲート                                                                                                                                                                                                                              |
| バージョン履歴保持           | —                     | ⏳ 保留   | クラウド保持の刈り込みジョブが未整備。保持期間差別化は保持基盤の実装とセット                                                                                                                                                                                                                                                   |

**保留分の共通方針**: fail-closed をコア編集/同期パスに軽率に入れて既存データ利用を壊すより、①機能の製品化 ②メータリング基盤 ③安全なサーバ実効点、が揃ってからゲートを同梱する（サイレント破壊 > 一時的な取りこぼしの回避）。GO の可否は「Web 公開＋共同編集ゲスト（クライアント）」で最初の非AI課金導線として十分成立する。

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

1. ✅ `entitlements/{uid}` / `usage/{uid}/months/{ym}` スキーマ + **firestore.rules（クライアント書込禁止）**（本番 deploy 済）
2. ✅ ai-proxy に entitlement+usage 照合レイヤー（`verifyFirebaseToken` 直後）→ 429（本番 deploy 済・rev 00035-4sf）
3. ✅ 全6AIエンドポイントに使用量メータリング（sttCalls / batchMin / images / aiCalls）
4. ✅ 既存12スタッフを `plan:"internal"` でシード（本番反映済）
5. ✅ **deploy 完了**: firestore.rules（live 確認）+ ai-proxy（rev 00035-4sf @100%・timeout 900・`OWNER_UIDS`/`INTERNAL_UIDS` env 検証）+ 401 probe でライブ検証
6. ✅ クライアント: entitlement をログイン時 fetch（`auth-store` → `/v1/me/entitlement`）。UIの単一ソース＝サーバ endpoint（Firestore 直読みしない）
7. ✅ UIゲート/upsell: 429 `quota_exceeded` を全AI呼び出しで捕捉 → App レベルの赤バナー（upsell）+ StatusBar プラン表示
8. ✅ **オーナー view-as**: `X-View-As` を全8 ai-proxy 呼び出しに注入（[ai-proxy.ts](src/services/ai-proxy.ts)）。StatusBar にオーナー限定スイッチャ（内部/Free/Pro/Team）+ App にプレビュー用琥珀バナー（利用量リセット/元に戻す）。`isOwner` はサーバ `OWNER_UIDS` 由来で三田遼平のみ
9. ⏳ SQLiteミラー（オフライン時のプラン表示）— 任意の後続改善（現状はオンライン endpoint 依存でフェイルソフト）
10. ⏳ アプリ本番配信（version bump + release scripts）— **gated: 要 GO**（テスターへの outward-facing）

### P1 — Stripe（Desktop + Web）— コード完了・ダークデプロイ済（点灯は §3.5 ランブック）

6. ✅ Cloud Run: Checkout Session 生成 + Webhook（署名検証・冪等・process-before-ACK）+ Customer Portal（rev 00041-jss @100%・`STRIPE_*` 未設定で 503 dark）
7. ✅ Tauri: システムブラウザ起動（checkout URL を opener で開く）+ `markflow://billing/success|cancel` ディープリンク復帰 + hosting 戻りページ
8. ✅ 課金UI: PaywallDialog + UserMenu「プランを管理」+ StatusBar プラン表示（`VITE_BILLING_ENABLED` 既定 OFF）
9. ⏳ **オーナー点灯作業（§3.5）**: Stripe 商品/価格・Secret・env・hosting 再デプロイ・クライアント配信
10. ⏳ 回数メーターUI（機能別 X/Y 残量表示・上限接近アラート）— 課金の可視化（後続）

### P2 — モバイルIAP（iOS + Android）

9. iOS: StoreKit2ブリッジ + App Store Server API v2検証 + Notifications v2受信
10. Android: Play Billingブリッジ(v8+) + subscriptionsv2検証 + RTDN(Pub/Sub)受信
11. ストア横断名寄せ（uid統合）テスト・sandbox検証

### P3 — Team + Founders + ローンチ

12. Team: 席課金・共有回数プール（`usage/{teamId}`）・チーム権限/SSO（既存 team 構造拡張）
13. Founders: 既存ユーザースナップショット → 恒久フラグ付与
14. 価格表・課金設定UI・請求管理（StatusBar 等）
15. 全PF同時ローンチ

---

## 6. インフラ連動チェック（`.claude/rules/infra-sync.md` 準拠）

コード変更と**同一リリースで完結**させる：

- [x] `firestore.rules`: `entitlements`/`usage` 追加ルール → **本番 deploy 済**（live ruleset に entitlements/usage ブロック確認）
- [x] ai-proxy: entitlement+usage ゲート + view-as → **Cloud Run 本番デプロイ済**（rev 00035-4sf @100%・timeout 900・`INTERNAL_UIDS`(12)/`OWNER_UIDS`(2) env 設定・401 probe 検証）
- [x] Cloud Run 新エンドポイント: Stripe `/v1/billing/{checkout,portal,webhook}` → **本番 deploy 済（rev 00041-jss・ダーク 503）**
- [x] `firestore.rules`: `stripeEvents`/`stripeCustomers`（クライアント全拒否・Admin SDK のみ）→ **本番 deploy 済（ruleset 4a946e82）**
- [ ] Cloud Run 新エンドポイント（モバイル）: App Store Notifications v2 / Play RTDN(Pub/Sub subscription)
- [ ] Pub/Sub トピック + サブスク作成（Play RTDN 用）+ IAM
- [ ] GCP: Play Developer API 有効化 + サービスアカウント権限（既存 `play-api-key.json` 拡張 or 新規）
- [ ] App Store Connect: App Store Server API キー + Notifications v2 URL 登録
- [ ] **Stripe 点灯（§3.5）**: 本番キー/Webhook シークレット（Secret Manager）・price ID env・Webhook 登録（`2026-07-29.dahlia`）→ **オーナー作業で完結**
- [ ] 環境変数: Cloud Run env（`STRIPE_PRICE_*`）+ ビルド埋め込み（`VITE_BILLING_ENABLED`）両方

## 7. 未確定・要検証（実装前リサーチ）

**確定済み**: 課金モデル=フラット回数制（`PLAN_LIMITS`・2026-08-21） / 買い切り志向=年割強化（Lifetime不採用） / refine=隠し機能→将来正式化 / AIモデル=全て Claude Opus 5。

**要検証（ローンチ前 or ローンチ後テレメトリ）:**

- **`PLAN_LIMITS` の上限値較正**（現状 placeholder）→ §1.1 実COGS と中央値利用率のテレメトリから、各メーターの回数/分数を粗利55-65%へ合わせ込む。
- **中央値利用率 30-40% の前提**（粗利の土台・現状 unverified）→ ローンチ後テレメトリで確定するまで粗利を「確定」としない。
- **`aiCalls` の混在コスト**（1 call の実コストが chat/analyze/grounded で大きく異なる。grounded は Gemini3 が1リクエストで複数検索を発火しうる）→ 高COGS操作の実測トークン/検索クエリ数で、上限を保守的に設定するか feature を分割するか判断。
- **Flash refine の構造化品質が商用許容水準か**（refine隠し機能の正式化条件）→ ローンチ前に品質評価データセットで検証。
- Free 枠（`aiCalls` 30回等）が転換促進か共食いか → A/Bテスト。
- Team席課金 ¥1,980/席の受容性、Enterprise を即時立ち上げか段階導入か（SCIM/DPA/SLA需要確度）。
- ヘビー音声向けアドオン/Top-up（回数上乗せ方式）の要否・価格（§1.5）。
- モバイルIAP二重価格（Pro iOS ¥1,600）の UI 提示方法（Web価格併記 or PF別出し分け）。
- 既存 internal スタッフ12名の無制限バイパスをローンチ後も恒久継続するか。
- Tauri IAPコミュニティプラグインの保守状況・StoreKit2/Play Billing v8対応度（実測）。
- 日本 User Choice Billing 採用可否（非ゲーム・手数料4%減）。
- 新モデル（Opus後継/Gemini後継/NanoBanana Lite $0.034）登場時の `PLAN_LIMITS` 再較正。

---

## 8. 公開リポ是正（配信移設 + OAuth ローテ）— 順序厳守ランブック

> GitHub が **public** リポである問題の是正。フリーミアム化と同時に完成させる。**外向き/不可逆手順はオーナー GO 待ち**。コード側は実装済み（working tree・未 commit）。

### 8.1 更新配信の脱 GitHub（決定①）— privatize の前提

auto-updater が公開 GitHub Releases URL に依存しているため、**単純な非公開化は全ユーザーの自動更新を破壊する**。先に配信を markflow.jp/updates（GCS backed）へ移設する。

- **実装済（コード）**: [lib.rs](src-tauri/src/lib.rs) の更新エンドポイントを `option_env!("MARKFLOW_UPDATE_BASE")` で切替（既定=GitHub＝working tree はそのまま出荷可）。[nginx.conf](hosting/nginx.conf) に `/updates/` reverse-proxy 追加（markflow-site 再デプロイまで不活性）。[release-updates-gcs.sh](scripts/release-updates-gcs.sh) で manifest（markflow.jp URL）+ 成果物を GCS へ publish。
- **オーナー手順（GO 時・順序厳守）**:
  1. バケット作成 + 公開読取: `gsutil mb -p markflow-app-2026 -l asia-northeast1 gs://markflow-updates` → `gsutil iam ch allUsers:roles/storage.objectViewer gs://markflow-updates`（`--account ga.crossmedia@gmail.com`）
  2. `markflow-site` 再デプロイ（`/updates/` route を live 化）
  3. 移行ビルド: `MARKFLOW_UPDATE_BASE=https://markflow.jp/updates` + 署名 env 付きで `pnpm tauri build`
  4. **dual-publish**: `./scripts/release-beta.sh`（GitHub＝旧クライアント）**と** `./scripts/release-updates-gcs.sh beta`（GCS＝移行ビルド）を両方
  5. 移行ビルドが markflow.jp から更新取得することを実機検証 → 移行期間を置く（未更新ユーザーは privatize 後 DMG 手配布で救済）
  6. **GitHub リポ非公開化**（→ 8.3）。以降 GCS-only（tauri.conf.json:67 も markflow.jp へ更新）
- **禁止**: 移設・移行リリース前に privatize するな（順序違反＝自動更新の全破壊）。

### 8.2 OAuth シークレット ローテ（決定②）— サーバ移設後

- **実装済（コード + デプロイ）**: トークン交換を ai-proxy `/v1/auth/oauth/exchange` へ移設し、クライアントから `client_secret` を撤去（Secret Manager 化・rev 00046-df9 デプロイ済）。
- **オーナー手順（GO 時）**: 移設済みの**新クライアントを配布した後**に、GCP/GitHub コンソールで旧シークレットを Reset/Regenerate（旧バンドル内の漏洩値を無効化）。順序: 新ビルド配布 → ローテ（逆順にすると配布前の旧クライアントが即死）。

### 8.3 GitHub 非公開化 + 履歴（決定①の締め）

- **前提**: 8.1 完了（配信移設済み）+ 8.2 の新クライアント配布済み。
- リポを Private 化（オーナー操作）。CI（Windows ビルド）は private でも動くが成果物取得元を調整。
- **git 履歴の残留 PII/シークレット**: 過去 commit に漏洩 OAuth secret（ローテで無効化＝本質是正）と社内スタッフ uid↔氏名（commit be05cd7）が残る。privatize で実効遮断されるため履歴 purge は任意・後続（`git filter-repo`）。working tree は既にサニタイズ済（[seed-internal-entitlements.sh](scripts/seed-internal-entitlements.sh) から氏名撤去・uid↔氏名は非公開ロスター管理・`scripts/internal-uids.local` override は gitignore 済）。

### 8.4 完了済みセキュリティ・ハイジーン（working tree）

- `.gitignore` 強化（`.env` 系 / 署名 material `*.keystore|*.jks|*.p8|*.p12|*.pem` / ビルドキャッシュ / ローカル状態 / `scripts/internal-uids.local`）+ `git rm --cached`（.env / tsbuildinfo / .firebase cache / scheduled_tasks.lock）
- `build.gradle.kts` の keystore パスワードのハードコード削除（`ANDROID_KEYSTORE_PASS` 必須・未設定は署名 config を空にしてビルド失敗＝サイレント排除）
- ドキュメント/SKILL から実シークレット・API KeyID・実パスをプレースホルダ化
- seed スクリプトから社内スタッフ氏名（PII）を撤去（uid + `staff-NN` ラベルのみ）
