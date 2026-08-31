#!/usr/bin/env bash
#
# revoke-test-entitlements.sh
# ---------------------------
# E2E テスト用アカウント(test-sync-a/b)に誤って付与されていた
# `internal`(無制限・原価上限なし)エンタイトルメントを Firestore から削除する。
# これらの認証情報は CI で共有されるため、有料プランを持たせてはならない。
#
# entitlement ドキュメントはサーバ書込専用(firestore.rules)なので、Admin 権限を
# 持つ REST 経由(ga.crossmedia)で直接削除する。ドキュメント不在時 ai-proxy は
# free として扱うため、削除がそのまま「無料への降格」になる。
#
# 冪等: 既に無いドキュメントの DELETE は 200/404 いずれも成功扱い。
# 使い方:
#   DRY_RUN=1 ./scripts/revoke-test-entitlements.sh   # 確認のみ
#   ./scripts/revoke-test-entitlements.sh             # 実削除
#
set -euo pipefail

PROJECT="markflow-app-2026"
ACCOUNT="${GCLOUD_ACCOUNT:-ga.crossmedia@gmail.com}"
DB="(default)"
BASE="https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}/documents"
DRY_RUN="${DRY_RUN:-0}"

# E2E テストアカウントの uid（seed-internal-entitlements.sh から撤去済み）。
UIDS=(
  "GmlVWUd6j0QksScUCK8aPOmHS913"  # test-sync-a
  "D7OFKHqxQtTqdIQzoJP95VLkCV42"  # test-sync-b
)

echo "== revoke-test-entitlements =="
echo "  project : ${PROJECT}"
echo "  account : ${ACCOUNT}"
echo "  count   : ${#UIDS[@]} test accounts -> delete entitlement (=> free)"
echo "  dry_run : ${DRY_RUN}"
echo

TOKEN="$(gcloud auth print-access-token --account "${ACCOUNT}")"

for uid in "${UIDS[@]}"; do
  url="${BASE}/entitlements/${uid}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[dry-run] DELETE entitlements/${uid}"
    continue
  fi

  http_code="$(curl -sS -o /tmp/mf-revoke-resp.json -w '%{http_code}' \
    -X DELETE "${url}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-goog-user-project: ${PROJECT}")"

  # 404 = 既に不在(=free) も成功扱い(冪等)。
  if [[ "${http_code}" == "200" || "${http_code}" == "404" ]]; then
    echo "[ok]  entitlements/${uid} revoked (HTTP ${http_code})"
  else
    echo "[ERR] entitlements/${uid} HTTP ${http_code}"
    cat /tmp/mf-revoke-resp.json
    echo
    exit 1
  fi
done

echo
echo "Done. ${#UIDS[@]} test-account entitlements revoked."
