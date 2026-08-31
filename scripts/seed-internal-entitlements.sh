#!/usr/bin/env bash
#
# seed-internal-entitlements.sh
# -----------------------------
# 既存の社内スタッフ全員を Firestore `entitlements/{uid}` に plan="internal"
# （メータリング完全バイパス＝原価無制限）としてシードする。
#
# 目的: 課金ゲート(ai-proxy)を本番配信する「前」に社内スタッフをホワイトリスト
#       化し、ゲート有効化の影響範囲(blast radius)をゼロにする。
#       entitlement ドキュメントはサーバ書込専用(firestore.rules)なので、
#       ここでは Admin 権限を持つ REST 経由(ga.crossmedia)で直接書き込む。
#
# 冪等: updateMask 付き PATCH（既存フィールドを消さずに指定フィールドのみ更新）。
# 安全: DRY_RUN=1 で送信内容だけ表示して実書込みしない。
#
# 使い方:
#   DRY_RUN=1 ./scripts/seed-internal-entitlements.sh   # 確認のみ
#   ./scripts/seed-internal-entitlements.sh             # 実書込み
#
set -euo pipefail

PROJECT="markflow-app-2026"
# markflow-app-2026 への権限を持つのは ga.crossmedia のみ（アクティブ非依存で明示固定）
ACCOUNT="${GCLOUD_ACCOUNT:-ga.crossmedia@gmail.com}"
DB="(default)"
BASE="https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}/documents"
DRY_RUN="${DRY_RUN:-0}"

# アクティベート済みの社内スタッフ uid（実スタッフ8名分の10 uid + テスト2）。
# 個人名は本ファイルに書かない（PII をリポジトリに載せない方針）。uid↔氏名の
# 対応表はプロジェクト外の非公開メモに保持する。REST には uid のみ使用。
# 実スタッフ以外の override が必要なときは scripts/internal-uids.local（gitignore
# 済み・1 行 1 uid・# 以降コメント可）を置けばそちらを優先して読む。
UIDS=(
  "BqYnuaZy3GQ2jWDcpeEitfxFR173"  # staff-01 (owner / personal)
  "9ff2wglT9QRmAyLqjrYJgPxIVb73"  # staff-01 (owner / corp)
  "A0lwZ2pMv7TPPpJuLJKXcOSLJwf1"  # staff-02
  "CsNoefEnZLVz3i1eoOBkciKj6uw2"  # staff-03 (corp)
  "DC7LviMTDZMO5hVcUMkwQnGD4nG3"  # staff-04
  "95ubzl1zg2N9BgqTuaTM1p38PXr2"  # staff-05 (corp)
  "F59z29niiRa15YyGzayMIzH5hK63"  # staff-06
  "ZeBRcujqF0NTuqT2Lbz2oMIrCZJ3"  # staff-07
  "WkG0ditPu2NOIUGwgLsVRw4S0sf1"  # staff-08 (corp)
  "RHyQXRfPouf9dHI9nI9D4Q652ER2"  # staff-08 (personal)
  # NOTE: the E2E test accounts (test-sync-a/b) were removed from this list —
  # they must NEVER hold `internal` (unlimited, cost-uncapped) entitlements, since
  # their credentials are shared for CI. Any internal entitlement already written
  # for those uids must be revoked in Firestore (see revoke-test-entitlements).
)

# Optional untracked override: one uid per line (# comments allowed). Lets staff
# be added/rotated without editing this tracked file (keeps future PII out of git).
# bash 3.2 safe (macOS default bash has no mapfile) — read line by line.
LOCAL_UIDS_FILE="$(dirname "$0")/internal-uids.local"
if [ -f "$LOCAL_UIDS_FILE" ]; then
  OVERRIDE=()
  while IFS= read -r token; do
    [ -n "$token" ] && OVERRIDE+=("$token")
  done < <(sed 's/#.*//' "$LOCAL_UIDS_FILE" | grep -oE '[A-Za-z0-9]+')
  if [ "${#OVERRIDE[@]}" -gt 0 ]; then
    UIDS=("${OVERRIDE[@]}")
    echo "  (using ${#UIDS[@]} uids from internal-uids.local override)"
  fi
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== seed-internal-entitlements =="
echo "  project : ${PROJECT}"
echo "  account : ${ACCOUNT}"
echo "  count   : ${#UIDS[@]} users -> plan=internal (unlimited)"
echo "  dry_run : ${DRY_RUN}"
echo

TOKEN="$(gcloud auth print-access-token --account "${ACCOUNT}")"

for uid in "${UIDS[@]}"; do
  # merge PATCH: plan / status / source / earlySupporter / note / updatedAt
  url="${BASE}/entitlements/${uid}?updateMask.fieldPaths=plan&updateMask.fieldPaths=status&updateMask.fieldPaths=source&updateMask.fieldPaths=earlySupporter&updateMask.fieldPaths=note&updateMask.fieldPaths=updatedAt"
  body="$(cat <<JSON
{
  "fields": {
    "plan":           { "stringValue": "internal" },
    "status":         { "stringValue": "active" },
    "source":         { "stringValue": "founder" },
    "earlySupporter": { "booleanValue": true },
    "note":           { "stringValue": "internal staff / early supporter — seeded ${NOW}" },
    "updatedAt":      { "timestampValue": "${NOW}" }
  }
}
JSON
)"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[dry-run] PATCH entitlements/${uid} -> plan=internal"
    continue
  fi

  http_code="$(curl -sS -o /tmp/mf-seed-resp.json -w '%{http_code}' \
    -X PATCH "${url}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -H "x-goog-user-project: ${PROJECT}" \
    -d "${body}")"

  if [[ "${http_code}" == "200" ]]; then
    echo "[ok]  entitlements/${uid} -> internal"
  else
    echo "[ERR] entitlements/${uid} HTTP ${http_code}"
    cat /tmp/mf-seed-resp.json
    echo
    exit 1
  fi
done

echo
echo "Done. ${#UIDS[@]} internal entitlements seeded."
