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

> **2026-08-18 精緻化**: 「1回=1消費」の平坦課金を廃止し、**実COGSに比例する重み付けクレジット制**へ移行（敵対的検証で3大破綻＝執筆Pro満額赤字/音声ヘビーPro回収不能/Team共有プール鯨枯渇 を原価構造で是正）。原価は一次情報で検証済み（§1.1）。AIモデルは全て **Claude Opus 5**（Vertex `claude-opus-5` @ global）へ更新。**Opus 5 も入力$5/M・出力$25/M で 4.8 と同一単価**のため、下記クレジット経済は不変。

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

### 1.2 重み付けクレジット（1cr ≈ $0.01 実COGS）

重み = round(実単価 ÷ $0.01)。最大の出血点（執筆・音声refine・自動リサーチ）は**既定でFlashルーティング**、Opus品質は高価値操作/上位ティア/オプトインでプレミアム消費。UIは操作ごとの数字でなく単一「残量%」に集約。割引（キャッシュ90%/Batch50%/DynamicBatch75%）は**原価床に前借りせず**マージン上振れにのみ算入。

| 操作                                       | 重み  | 実原価       | 経路                                |
| ------------------------------------------ | ----- | ------------ | ----------------------------------- |
| AI執筆・ルーティン（文法/トーン/言い換え） | 1 cr  | $0.005-0.011 | Gemini Flash 既定                   |
| AI執筆・高価値（詳細化/構造化）            | 4 cr  | $0.035       | Opus 5（明示/上位ティア）           |
| 音声refine・Flash既定                      | 12 cr | $0.117       | Flash（既定）                       |
| 音声refine・Opusプレミアム                 | 35 cr | $0.35        | Opus 5（オプトイン・**隠し機能※**） |
| ライブリサーチ解析（Director）             | 9 cr  | $0.09        | Opus 5・**既定OFF+ハード上限**      |
| grounded-search                            | 3 cr  | $0.028       | Flash+検索（5,000無料枠内は$0）     |
| AI画像（NanoBanana2 1K）                   | 7 cr  | $0.067       | 執筆と別の枚数枠                    |

- **音声は二軸目の独立メーター**（分単位・課金軸が違う）: ライブ $0.016/分・バッチ $0.004/分（Dynamic Batch）。1回の音声→文書化は「音声分」と「refine cr」を同時消費。
- ※ **refine（音声の高品質整形）は現状 品質が実験段階のため『隠し機能』として提供し、将来の品質確定後に正式ゲート化**（重み 12/35cr は確定済み）。既定は Flash refine。

### 1.3 機能→ティア マッピング

| 機能                             | Free                          | Pro                                     | Team                              | Enterprise       |
| -------------------------------- | ----------------------------- | --------------------------------------- | --------------------------------- | ---------------- |
| ローカル編集・全描画・オフライン | ✅ 無制限                     | ✅                                      | ✅                                | ✅               |
| クラウド同期（Firestore）        | 2台 / 50文書 / 1GB            | ✅ 無制限（公正利用）×全PF              | ✅ プール+管理者制御              | ✅               |
| バージョン履歴                   | ローカル無制限 / クラウド7日  | クラウド30日                            | 90日〜                            | 保持ポリシー可   |
| AI執筆（チャット/8アクション）   | Flash + **Opus 5体験10回/月** | Opusフル（ルーティンFlashハイブリッド） | Opusフル（プール消費）            | committed-use    |
| 音声→文書化（含有分）            | 60分 / refine5回・Flash整形   | 1,200分・Flash refine既定               | 1,000分/席プール                  | committed-use    |
| 音声refineモデル                 | Flashのみ                     | Flash既定 +（Opusは隠し/実験）          | Flash既定 +（Opusは隠し/実験）    | —                |
| ライブリサーチ + grounded-search | 手動2-3回のみ・自動不可       | opt-in・既定OFF+支出上限+費用明示       | +管理者キャップ・プール           | +committed-use   |
| AI画像生成（別枠）               | 月2枚                         | クレジット（7cr/枚）                    | クレジット（プール）              | committed-use    |
| Web公開（markflow.jp/p/）        | ❌                            | 10ページ + PW保護                       | 無制限 + 独自ドメイン             | +高度管理        |
| リアルタイム協業（Yjs）          | ゲスト0                       | ゲスト2-3名                             | **メンバー/ゲスト無制限（中核）** | ✅               |
| カスタム語彙 / ベクトル横断検索  | ❌                            | ✅                                      | チーム共有辞書                    | ✅               |
| API/自動化（MCP・Webhook）       | 接続入口のみ                  | 個人スコープ                            | 組織連携                          | 組織連携+        |
| SSO / 監査 / ロール権限          | ❌                            | ❌                                      | SAML SSO + 監査 + ロール          | **SCIM/DPA/SLA** |
| 消費上限・予算管理               | 上限到達で停止                | 残量%メーター + top-up                  | 席別/機能別キャップ+予算アラート  | committed-use    |
| サポート                         | コミュニティ                  | 優先メール                              | SLA付き                           | 専任             |

### 1.4 各ティア（価格・枠・粗利方針）

| ティア         | 価格          | クレジット/月                       | 音声/月              | 目標粗利                                                                |
| -------------- | ------------- | ----------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| **Free**       | ¥0            | 200 cr                              | 60分（refine5回）    | 獲得コスト（実COGS ≈ $1-2）                                             |
| **Pro**        | ¥1,280/月     | 1,500 cr                            | 1,200分（20h）       | 中央値利用で55-65%（満額≈break-even、超過はtop-up/Voice Boosterで回収） |
| **Team**       | ¥1,980/席・月 | 3,000 cr/席（**席横断共有プール**） | 1,000分/席（プール） | 50-60%（プール平準化+席別上限）                                         |
| **Enterprise** | 見積          | committed-use                       | committed-use        | 高（価格弾力性の低いガバナンス機能で裏付け）                            |

- **Free**: 毎月リセット・繰越なし。Opus 5体験10回/月で品質差を必ず試させ転換動機化。成長すると音声・自動リサーチ・公開・同時編集の壁でPro転換。
- **Pro**: ルーティン執筆をFlashハイブリッド化し実消費を枠1,500crの約60%へ抑制（40%ヘッドルーム）。自動リサーチ既定OFF+セッション単位ハード支出上限+「約¥X」明示確認で原価爆弾を物理停止。
- **Team**: 席別/機能別ハードキャップ+管理者予算アラート&キャップで「鯨2名が5名を飢餓」破綻を防止。SAML SSO+監査はTeam同梱、SCIM/DPA/専任SLAはEnterpriseへ分離（法人のサプライズ請求嫌悪を排除）。
- **Enterprise（新設）**: 消費者3ティアは維持しつつ上位に見積制を接ぎ木。committed-useで予測可能請求。

### 1.5 アドオン・Top-up

- **Voice Booster ¥1,500/月 = +1,800分 + refine枠拡張**（**確定：ヘビー音声は第4ティアでなくアドオンで収容**）。内部は Flash + Dynamic Batch で原価固定し「無制限に見える定額」を実現（Granola/Otter の無制限訴求に横付け）。
- **Top-up**: クレジット ¥1,000=300cr（¥3.3/cr・粗利≈55%・90日繰越）／音声パック ¥1,200=300分。Teamはプールへ追加（席数割引）+ committed-use。
- 高COGS操作（Opus refine 35 / リサーチ 9 / grounded 3）は含有を薄くし従量精算比率を上げる。満額でも top-up/Voice Booster で回収する構造でサイレント赤字ゼロ。

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
- **アドオン: Voice Booster ¥1,500/月（確定）** — ヘビー音声を独立ティアでなくアドオンで収容（+1,800分+refine枠拡張・内部Flash+Batchで原価固定）。
- top-up（クレジット追加購入）を全ティアに用意。Team はプールへ追加 + committed-use。

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

- [x] `firestore.rules`: `entitlements`/`usage` 追加ルール → **本番 deploy 済**（live ruleset に entitlements/usage ブロック確認）
- [x] ai-proxy: entitlement+usage ゲート + view-as → **Cloud Run 本番デプロイ済**（rev 00035-4sf @100%・timeout 900・`INTERNAL_UIDS`(12)/`OWNER_UIDS`(2) env 設定・401 probe 検証）
- [ ] Cloud Run 新エンドポイント: Stripe Webhook / App Store Notifications v2 / Play RTDN(Pub/Sub subscription)
- [ ] Pub/Sub トピック + サブスク作成（Play RTDN 用）+ IAM
- [ ] GCP: Play Developer API 有効化 + サービスアカウント権限（既存 `play-api-key.json` 拡張 or 新規）
- [ ] App Store Connect: App Store Server API キー + Notifications v2 URL 登録
- [ ] Stripe: 本番キー（Secret Manager必須・.env禁止）・Webhook署名シークレット
- [ ] 環境変数: Cloud Run env + ビルド埋め込み（`VITE_*`）両方

## 7. 未確定・要検証（実装前リサーチ）

**確定済み（2026-08-18）**: Voice=アドオン方式 / 買い切り志向=年割強化（Lifetime不採用） / refine=隠し機能→将来正式化 / AIモデル=全て Claude Opus 5。

**要検証（ローンチ前 or ローンチ後テレメトリ）:**

- **中央値利用率 30-40% の前提**（粗利55-65%の土台・現状 unverified）→ ローンチ後テレメトリで確定するまで粗利を「確定」としない。
- **音声refineの実トークン数**（重み 12/35cr は input30k/output8k 推定ベース）→ 実プロンプトのトークンカウントで再較正。
- **Flash refine の構造化品質が商用許容水準か**（refine隠し機能の正式化条件）→ ローンチ前に品質評価データセットで検証。
- **grounding 重み3の妥当性**（Gemini3は1リクエストで複数検索が発火しうる＝検索クエリ単位課金のため過小計上リスク）。
- Free の Opus 5体験10回/月が転換促進か共食いか → A/Bテスト。
- Team席課金 ¥1,980/席の受容性、Enterprise を即時立ち上げか段階導入か（SCIM/DPA/SLA需要確度）。
- Voice Booster ¥1,500 の価格妥当性。
- モバイルIAP二重価格（Pro iOS ¥1,600）の UI 提示方法（Web価格併記 or PF別出し分け）。
- 既存 internal スタッフ12名の無制限バイパスをローンチ後も恒久継続するか。
- Tauri IAPコミュニティプラグインの保守状況・StoreKit2/Play Billing v8対応度（実測）。
- 日本 User Choice Billing 採用可否（非ゲーム・手数料4%減）。
- 新モデル（Opus後継/Gemini後継/NanoBanana Lite $0.034）登場時のクレジット重み再較正。
