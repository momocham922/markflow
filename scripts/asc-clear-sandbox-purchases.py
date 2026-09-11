#!/usr/bin/env python3
# asc-clear-sandbox-purchases.py
# ------------------------------
# Sandbox Apple Account の購入履歴を App Store Connect API で消去する
# （= サブスクを即 Free に戻す、オンデマンドの反復テスト用ツール）。
#
# これは Sandbox Apple Account 専用。実カスタマーの購入には一切影響しない（Apple 公式）。
# 実 Apple ID の TestFlight サブスクには「購入履歴を消去」自体が存在せず、この API も
# 効かない → ストア側を Sandbox Apple Account に切り替えてから使うこと。
#   詳細: memory/ios_sandbox_revert_to_free.md
#
# アプリ側ログイン（Firebase uid）は会社 Google アカウント `9ff2wgl…` のまま。
# 消すのは Apple ストアの購入履歴だけなので、entitlement doc は次回読み取り時に
# backstop（source∈{app_store}, now-currentPeriodEnd>24h）または DID_EXPIRE で free になる。
#
# 実測確定した API 仕様（2026-09-02、live 検証済み・201 Created）:
#   POST /v2/sandboxTestersClearPurchaseHistoryRequest
#   body: {"data":{"type":"sandboxTestersClearPurchaseHistoryRequest",
#          "relationships":{"sandboxTesters":{"data":[{"type":"sandboxTesters","id":<TID>}]}}}}
#   ※ type は単数形、relationship 名は 'sandboxTesters'（複数形）、data は「配列」。
#
# 前提: PyJWT（`pip3 install pyjwt cryptography`）。鍵は ~/.appstoreconnect/private_keys/ 。
#
# 使い方:
#   ./scripts/asc-clear-sandbox-purchases.py                 # 既存 sandbox tester を一覧→全消去確認
#   ./scripts/asc-clear-sandbox-purchases.py --list          # 一覧のみ（変更なし）
#   ./scripts/asc-clear-sandbox-purchases.py --email a@b.com # メールで対象を指定して消去
#   ./scripts/asc-clear-sandbox-purchases.py --id <TID>      # tester id を直接指定して消去
#   ./scripts/asc-clear-sandbox-purchases.py --yes           # 確認プロンプトをスキップ
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

try:
    import jwt  # PyJWT
except ImportError:
    sys.exit("PyJWT が必要です: pip3 install pyjwt cryptography")

KEY_ID = "AQ996V29F4"
ISSUER = "fab7704b-d2a9-4ce6-9e58-c6a73c958c22"
P8 = "/Users/3937/.appstoreconnect/private_keys/AuthKey_AQ996V29F4.p8"
BASE = "https://api.appstoreconnect.apple.com"


def make_token():
    priv = open(P8).read()
    now = int(time.time())
    return jwt.encode(
        {"iss": ISSUER, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"},
        priv, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"},
    )


def api(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw}


def list_testers(token):
    st, d = api("GET", "/v2/sandboxTesters", token)
    if st != 200:
        sys.exit("sandboxTesters 取得失敗 HTTP %s: %s" % (st, json.dumps(d)[:400]))
    out = []
    for t in d.get("data", []):
        a = t.get("attributes") or {}
        out.append({
            "id": t.get("id"),
            "acct": a.get("acAccountName") or a.get("email"),
            "name": ("%s %s" % (a.get("firstName") or "", a.get("lastName") or "")).strip(),
            "territory": a.get("territory"),
            "rate": a.get("subscriptionRenewalRate"),
        })
    return out


def clear(token, tester_id):
    body = {"data": {"type": "sandboxTestersClearPurchaseHistoryRequest",
                     "relationships": {"sandboxTesters": {"data": [
                         {"type": "sandboxTesters", "id": tester_id}]}}}}
    return api("POST", "/v2/sandboxTestersClearPurchaseHistoryRequest", token, body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="一覧のみ（変更なし）")
    ap.add_argument("--email", help="対象 sandbox tester のメール")
    ap.add_argument("--id", dest="tid", help="対象 sandbox tester の id")
    ap.add_argument("--yes", action="store_true", help="確認プロンプトをスキップ")
    args = ap.parse_args()

    token = make_token()
    testers = list_testers(token)

    print("== Sandbox Apple Accounts (%d) ==" % len(testers))
    for t in testers:
        print("  id=%s | %s | %s | %s | %s"
              % (t["id"], t["acct"], t["name"], t["territory"], t["rate"]))
    print()

    if args.list:
        return

    if args.tid:
        targets = [t for t in testers if t["id"] == args.tid]
    elif args.email:
        targets = [t for t in testers if (t["acct"] or "").lower() == args.email.lower()]
    else:
        targets = testers  # 指定なし → 全件

    if not targets:
        sys.exit("対象が見つかりません（--email/--id を確認）")

    print("消去対象 (%d):" % len(targets))
    for t in targets:
        print("  -", t["acct"], "(", t["id"], ")")
    if not args.yes:
        ans = input("購入履歴を消去します（不可逆・実カスタマー非影響）。よろしいですか? [y/N] ")
        if ans.strip().lower() not in ("y", "yes"):
            print("中止しました。")
            return

    ok = True
    for t in targets:
        st, d = clear(token, t["id"])
        if st in (200, 201, 202, 204):
            rid = (d.get("data") or {}).get("id", "")
            print("[ok]  %s cleared (HTTP %s, request %s)" % (t["acct"], st, rid))
        else:
            ok = False
            print("[ERR] %s HTTP %s: %s" % (t["acct"], st, json.dumps(d)[:300]))
    if not ok:
        sys.exit(1)
    print("\n完了。反映に時間差あり（Apple公式）。確実にするならアプリ削除→再インストールで"
          "ローカルレシートも消す。")


if __name__ == "__main__":
    main()
