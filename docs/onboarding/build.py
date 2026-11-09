#!/usr/bin/env python3
"""MarkFlow 取扱説明書（Android・Windows）を HTML に組む。

画面の写真は capture.mjs が pnpm dev から撮った実物（img/*.png）。
引出線・枠・番号は、撮影時に取ったボタンの座標（img/boxes.json）から計算して SVG で重ねる。
OS やストアの画面（SmartScreen・インストーラ）は、文言だけ一次情報（NSIS の言語ファイル・
tauri-bundler の installer.nsi）から取った線画で描き、「画面は一例」と書く。
出力: manual.html（render.mjs で PDF にする）
"""
import json
import os
from html import escape

HERE = os.path.dirname(os.path.abspath(__file__))
BOX = json.load(open(os.path.join(HERE, "img", "boxes.json")))

INK = "#2C3137"
SUB = "#5B636B"
RULE = "#C9CDD2"
ACC = "#C8461E"  # 押す所・注意の色（1色だけ）
FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif'
MONO = 'Menlo,"SF Mono",monospace'

PT = 0.3528  # 1pt = 0.3528mm


def num_badge(cx, cy, r, n, fs):
    return (
        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{INK}"/>'
        f'<text x="{cx:.1f}" y="{cy + fs * 0.36:.1f}" font-size="{fs:.1f}" font-weight="600" '
        f'fill="#fff" text-anchor="middle" font-family="{FONT}">{n}</text>'
    )


def shot(img, vw, vh, crop, width_mm, callouts, pad=(0, 0, 0, 0), extra="", label_pt=8.6):
    """実画面の写真に、枠・引出線・番号・ラベルを重ねた SVG。

    crop=(x, y, w, h) は写真の CSS px。pad=(上, 右, 下, 左) はラベル用の余白（CSS px）。
    callouts: dict(box=(x,y,w,h) or key, n=番号, to=(ラベルの点 x,y), text=ラベル, anchor=start|end)
    """
    cx, cy, cw, ch = crop
    pt, pr, pb, pl = pad
    vbx, vby, vbw, vbh = cx - pl, cy - pt, cw + pl + pr, ch + pt + pb
    mm_per_u = width_mm / vbw
    fs = label_pt * PT / mm_per_u  # ラベルの字の大きさ（単位）
    sw = 0.55 / mm_per_u  # 枠の線 0.55mm
    lw = 0.3 / mm_per_u  # 引出線 0.3mm
    r = fs * 0.78
    clip = f"c{abs(hash((img, crop))) % 10**8}"
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vbx} {vby} {vbw} {vbh}" '
        f'width="{width_mm}mm" height="{width_mm * vbh / vbw:.2f}mm" font-family="{FONT}">',
        f'<defs><clipPath id="{clip}"><rect x="{cx}" y="{cy}" width="{cw}" height="{ch}"/></clipPath></defs>',
        f'<image href="img/{img}" x="0" y="0" width="{vw}" height="{vh}" clip-path="url(#{clip})" preserveAspectRatio="none"/>',
        f'<rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" fill="none" stroke="{RULE}" stroke-width="{lw:.2f}"/>',
    ]
    for c in callouts:
        b = c["box"]
        if isinstance(b, str):
            d = BOX[b]
            b = (d["x"], d["y"], d["width"], d["height"])
        m = c.get("margin", 3)
        bx, by, bw, bh = b[0] - m, b[1] - m, b[2] + 2 * m, b[3] + 2 * m
        dash = ' stroke-dasharray="%.1f %.1f"' % (sw * 3, sw * 2) if c.get("dashed") else ""
        out.append(
            f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="{sw:.1f}" '
            f'fill="none" stroke="{ACC}" stroke-width="{sw:.2f}"{dash}/>'
        )
        tx, ty = c["to"]
        # 引出線は枠の一番近い辺の中点から
        ex = min(max(tx, bx), bx + bw)
        ey = min(max(ty, by), by + bh)
        if bx < tx < bx + bw:
            ey = by if ty < by else by + bh
        elif by < ty < by + bh:
            ex = bx if tx < bx else bx + bw
        out.append(
            f'<line x1="{ex:.1f}" y1="{ey:.1f}" x2="{tx:.1f}" y2="{ty:.1f}" stroke="{ACC}" stroke-width="{lw:.2f}"/>'
        )
        anchor = c.get("anchor", "start")
        out.append(num_badge(tx, ty, r, c["n"], fs * 0.92))
        if c.get("text"):
            gap = r + fs * 0.35
            lx = tx + gap if anchor == "start" else tx - gap
            lines = c["text"].split("\n")
            for i, line in enumerate(lines):
                yy = ty + fs * 0.36 + (i - (len(lines) - 1) / 2) * fs * 1.3
                out.append(
                    f'<text x="{lx:.1f}" y="{yy:.1f}" font-size="{fs:.1f}" font-weight="600" fill="{INK}" '
                    f'text-anchor="{anchor}" paint-order="stroke" stroke="#fff" stroke-width="{fs * 0.28:.1f}">{escape(line)}</text>'
                )
    out.append(extra)
    out.append("</svg>")
    return "".join(out)


# ---------- 線画（OS・ストアの画面の一例）----------


def win_frame(x, y, w, h, title):
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#fff" stroke="{INK}" stroke-width="1.2"/>'
        f'<rect x="{x}" y="{y}" width="{w}" height="22" fill="#F1F3F5" stroke="{INK}" stroke-width="1.2"/>'
        f'<text x="{x + 10}" y="{y + 15.5}" font-size="12" fill="{INK}">{escape(title)}</text>'
        f'<text x="{x + w - 14}" y="{y + 15.5}" font-size="12" fill="{SUB}" text-anchor="middle">✕</text>'
    )


def btn(x, y, w, label, hot=False):
    s = (
        f'<rect x="{x}" y="{y}" width="{w}" height="22" fill="#fff" stroke="{SUB}" stroke-width="1"/>'
        f'<text x="{x + w / 2}" y="{y + 15}" font-size="12" fill="{INK}" text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif">{escape(label)}</text>'
    )
    if hot:
        s += f'<rect x="{x - 4}" y="{y - 4}" width="{w + 8}" height="30" fill="none" stroke="{ACC}" stroke-width="2.2" rx="2"/>'
    return s


def greybars(x, y, widths, gap=9):
    return "".join(
        f'<rect x="{x}" y="{y + i * gap}" width="{w}" height="4" fill="#D5D9DD"/>' for i, w in enumerate(widths)
    )


def badge_at(x, y, n):
    return num_badge(x, y, 10, n, 12)


def fig_smartscreen():
    W, H = 640, 250
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="170mm" height="{170 * H / W:.1f}mm" font-family="{FONT}">']
    # 1枚目: 詳細情報
    x0 = 10
    s.append(f'<rect x="{x0}" y="10" width="290" height="200" fill="#1F5FA8"/>')
    s.append(f'<text x="{x0 + 16}" y="46" font-size="15" font-weight="600" fill="#fff">Windows によって PC が</text>')
    s.append(f'<text x="{x0 + 16}" y="66" font-size="15" font-weight="600" fill="#fff">保護されました</text>')
    s.append("".join(f'<rect x="{x0 + 16}" y="{82 + i * 10}" width="{w}" height="4" fill="#9DB8DA"/>' for i, w in enumerate([240, 210, 120])))
    s.append(f'<text x="{x0 + 16}" y="132" font-size="12" fill="#fff" text-decoration="underline">詳細情報</text>')
    s.append(f'<rect x="{x0 + 10}" y="117" width="62" height="22" fill="none" stroke="{ACC}" stroke-width="2.4" rx="2"/>')
    s.append(f'<rect x="{x0 + 196}" y="172" width="80" height="24" fill="none" stroke="#fff" stroke-width="1"/>')
    s.append(f'<text x="{x0 + 236}" y="188" font-size="12" fill="#fff" text-anchor="middle">実行しない</text>')
    s.append(badge_at(x0 + 92, 128, 1))
    s.append(f'<text x="{x0 + 108}" y="132" font-size="12" font-weight="600" fill="#fff">ここを押す</text>')
    # 矢印
    s.append(f'<path d="M312 110 L330 110" stroke="{INK}" stroke-width="1.6"/><path d="M330 104 L340 110 L330 116 Z" fill="{INK}"/>')
    # 2枚目: 実行
    x1 = 346
    s.append(f'<rect x="{x1}" y="10" width="290" height="200" fill="#1F5FA8"/>')
    s.append(f'<text x="{x1 + 16}" y="46" font-size="15" font-weight="600" fill="#fff">Windows によって PC が</text>')
    s.append(f'<text x="{x1 + 16}" y="66" font-size="15" font-weight="600" fill="#fff">保護されました</text>')
    s.append("".join(f'<rect x="{x1 + 16}" y="{82 + i * 10}" width="{w}" height="4" fill="#9DB8DA"/>' for i, w in enumerate([240, 210, 120, 190, 150])))
    s.append(f'<rect x="{x1 + 110}" y="172" width="80" height="24" fill="none" stroke="#fff" stroke-width="1"/>')
    s.append(f'<text x="{x1 + 150}" y="188" font-size="12" fill="#fff" text-anchor="middle">実行</text>')
    s.append(f'<rect x="{x1 + 104}" y="166" width="92" height="36" fill="none" stroke="{ACC}" stroke-width="2.4" rx="2"/>')
    s.append(f'<rect x="{x1 + 196}" y="172" width="80" height="24" fill="none" stroke="#fff" stroke-width="1"/>')
    s.append(f'<text x="{x1 + 236}" y="188" font-size="12" fill="#fff" text-anchor="middle">実行しない</text>')
    s.append(badge_at(x1 + 88, 184, 2))
    s.append(f'<text x="10" y="236" font-size="12" fill="{SUB}">画面は一例です。会社の設定によっては【実行】が出ません（6ページ「故障かな？と思ったら」）。</text>')
    s.append("</svg>")
    return "".join(s)


def fig_nsis():
    W, H = 660, 236
    w, h = 206, 190
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="170mm" height="{170 * H / W:.1f}mm" font-family="Segoe UI,Helvetica,Arial,sans-serif">']
    xs = [6, 227, 448]
    titles = ["Welcome to\nMarkFlow Setup", "Choose Install\nLocation", "Completing\nMarkFlow Setup"]
    for i, x in enumerate(xs):
        s.append(win_frame(x, 6, w, h, "MarkFlow Setup"))
        for j, line in enumerate(titles[i].split("\n")):
            s.append(f'<text x="{x + 12}" y="{50 + j * 17}" font-size="14" font-weight="700" fill="{INK}">{escape(line)}</text>')
    # 1: Welcome
    x = xs[0]
    s.append(greybars(x + 12, 84, [170, 150, 160, 90]))
    s.append(btn(x + 74, 164, 60, "Next >", hot=True) + btn(x + 140, 164, 56, "Cancel"))
    s.append(num_badge(x + 52, 175, 10, 1, 12))
    # 2: Directory
    x = xs[1]
    s.append(greybars(x + 12, 84, [170, 140]))
    s.append(f'<rect x="{x + 12}" y="108" width="182" height="18" fill="#fff" stroke="{SUB}" stroke-width="1"/>')
    s.append(greybars(x + 18, 115, [120]))
    s.append(btn(x + 8, 164, 56, "< Back") + btn(x + 70, 164, 62, "Install", hot=True) + btn(x + 140, 164, 56, "Cancel"))
    s.append(num_badge(x + 101, 146, 10, 2, 12))
    # 3: Finish
    x = xs[2]
    s.append(greybars(x + 12, 82, [160, 120]))
    for j, lab in enumerate(["Run MarkFlow", "Create desktop shortcut"]):
        yy = 112 + j * 20
        s.append(f'<rect x="{x + 12}" y="{yy}" width="11" height="11" fill="#fff" stroke="{INK}" stroke-width="1"/>')
        s.append(f'<path d="M{x + 14} {yy + 6} L{x + 17} {yy + 9} L{x + 22} {yy + 2}" stroke="{INK}" stroke-width="1.5" fill="none"/>')
        s.append(f'<text x="{x + 30}" y="{yy + 10}" font-size="12" fill="{INK}">{lab}</text>')
    s.append(btn(x + 74, 164, 60, "Finish", hot=True) + btn(x + 140, 164, 56, "Cancel"))
    s.append(num_badge(x + 52, 175, 10, 3, 12))
    for x in xs[:2]:
        s.append(f'<path d="M{x + w + 3} 100 L{x + w + 12} 100" stroke="{INK}" stroke-width="1.6"/><path d="M{x + w + 12} 95 L{x + w + 18} 100 L{x + w + 12} 105 Z" fill="{INK}"/>')
    s.append(f'<text x="6" y="226" font-size="12" fill="{SUB}" font-family={json.dumps(FONT)}>画面は一例です（インストーラは英語で表示されます）。②が【Next &gt;】のときは、それを押して進みます。</text>')
    s.append("</svg>")
    return "".join(s)


# ---------- 全体の流れ（取扱説明書の味の線画）----------


def icon(kind, cx, cy):
    st = f'stroke="{INK}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"'
    if kind == "phone":
        return f'<rect x="{cx - 13}" y="{cy - 22}" width="26" height="44" rx="4" {st}/><line x1="{cx - 5}" y1="{cy + 16}" x2="{cx + 5}" y2="{cy + 16}" {st}/>'
    if kind == "pc":
        return (
            f'<rect x="{cx - 24}" y="{cy - 20}" width="48" height="31" rx="2" {st}/>'
            f'<path d="M{cx - 8} {cy + 11} L{cx - 10} {cy + 20} L{cx + 10} {cy + 20} L{cx + 8} {cy + 11}" {st}/>'
        )
    if kind == "key":
        return f'<circle cx="{cx - 10}" cy="{cy}" r="9" {st}/><path d="M{cx - 1} {cy} L{cx + 22} {cy} M{cx + 14} {cy} L{cx + 14} {cy + 7} M{cx + 20} {cy} L{cx + 20} {cy + 6}" {st}/>'
    if kind == "mic":
        return (
            f'<rect x="{cx - 8}" y="{cy - 22}" width="16" height="27" rx="8" {st}/>'
            f'<path d="M{cx - 15} {cy - 4} Q{cx - 15} {cy + 13} {cx} {cy + 13} Q{cx + 15} {cy + 13} {cx + 15} {cy - 4} M{cx} {cy + 13} L{cx} {cy + 21} M{cx - 8} {cy + 21} L{cx + 8} {cy + 21}" {st}/>'
        )
    return ""


def fig_sysaudio():
    W, H = 640, 132
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="150mm" height="{150 * H / W:.1f}mm" font-family="{FONT}">']
    y = 52
    s.append(f'<rect x="2" y="{y - 12}" width="{W - 4}" height="56" fill="#fff" stroke="{RULE}" stroke-width="1.2"/>')
    # Record
    s.append(f'<rect x="14" y="{y}" width="92" height="32" rx="6" fill="{INK}"/>')
    s.append(f'<rect x="28" y="{y + 7}" width="8" height="12" rx="4" fill="none" stroke="#fff" stroke-width="1.6"/>')
    s.append(f'<path d="M25 {y + 15} Q25 {y + 23} 32 {y + 23} Q39 {y + 23} 39 {y + 15} M32 {y + 23} L32 {y + 27}" fill="none" stroke="#fff" stroke-width="1.6"/>')
    s.append(f'<text x="44" y="{y + 21}" font-size="14" fill="#fff">Record</text>')
    # システム音声のボタン（Monitor のアイコン）
    mx = 268
    s.append(f'<rect x="{mx - 7}" y="{y + 1}" width="44" height="30" rx="5" fill="none" stroke="{ACC}" stroke-width="2.6"/>')
    s.append(f'<rect x="{mx + 3}" y="{y + 8}" width="24" height="15" rx="2" fill="none" stroke="{INK}" stroke-width="1.8"/>')
    s.append(f'<path d="M{mx + 10} {y + 27} L{mx + 20} {y + 27} M{mx + 15} {y + 23} L{mx + 15} {y + 27}" stroke="{INK}" stroke-width="1.8"/>')
    # マイクの選択・間隔・Structure・ゴミ箱
    s.append(f'<rect x="324" y="{y + 3}" width="104" height="26" rx="5" fill="#fff" stroke="{SUB}" stroke-width="1"/>')
    s.append(f'<text x="334" y="{y + 21}" font-size="13" fill="{INK}" font-family="{MONO}">Default mic</text>')
    s.append(f'<rect x="436" y="{y + 3}" width="62" height="26" rx="5" fill="#fff" stroke="{SUB}" stroke-width="1"/>')
    s.append(f'<text x="446" y="{y + 21}" font-size="13" fill="{INK}">5min</text>')
    s.append(f'<rect x="506" y="{y}" width="86" height="32" rx="6" fill="#fff" stroke="{RULE}" stroke-width="1.2"/>')
    s.append(f'<text x="549" y="{y + 21}" font-size="13" fill="{SUB}" text-anchor="middle">Structure</text>')
    s.append(f'<path d="M604 {y + 10} L620 {y + 10} M607 {y + 10} L608 {y + 26} L616 {y + 26} L617 {y + 10}" stroke="{SUB}" stroke-width="1.4" fill="none"/>')
    # 番号とラベル
    s.append(f'<line x1="{mx + 15}" y1="{y + 1}" x2="{mx + 15}" y2="22" stroke="{ACC}" stroke-width="1.2"/>')
    s.append(num_badge(mx + 15, 18, 11, 3, 13))
    s.append(f'<text x="{mx + 32}" y="23" font-size="14" font-weight="600" fill="{INK}">PC の音も録るボタン（画面の形）</text>')
    s.append(f'<text x="4" y="{H - 6}" font-size="13" fill="{SUB}">画面は一例です（デスクトップ版のアプリだけに出るボタンです）。</text>')
    s.append("</svg>")
    return "".join(s)


def fig_overview():
    W, H = 694, 178
    steps = [
        ("phone", "スマホに入れる", "Android・約5分", "2"),
        ("pc", "PC に入れる", "Windows・約5分", "3"),
        ("key", "ログインする", "会社の Google アカウント", "4"),
        ("mic", "会議を録って", "議事録にする", "5"),
    ]
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="174mm" height="{174 * H / W:.1f}mm" font-family="{FONT}">']
    bw, gap = 150, 26
    for i, (ic, t1, t2, page) in enumerate(steps):
        x = 4 + i * (bw + gap)
        s.append(f'<rect x="{x}" y="10" width="{bw}" height="150" fill="#fff" stroke="{INK}" stroke-width="1.6"/>')
        s.append(f'<rect x="{x}" y="10" width="34" height="30" fill="{INK}"/>')
        s.append(f'<text x="{x + 17}" y="31" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">{i + 1}</text>')
        s.append(icon(ic, x + bw / 2, 72))
        s.append(f'<text x="{x + bw / 2}" y="122" font-size="15" font-weight="600" fill="{INK}" text-anchor="middle">{t1}</text>')
        s.append(f'<text x="{x + bw / 2}" y="142" font-size="12" fill="{SUB}" text-anchor="middle">{t2}</text>')
        s.append(f'<text x="{x + bw - 8}" y="31" font-size="12" fill="{SUB}" text-anchor="end">{page} ページ</text>')
        if i < 3:
            ax = x + bw + 4
            s.append(f'<path d="M{ax} 85 L{ax + 12} 85" stroke="{INK}" stroke-width="1.8"/><path d="M{ax + 12} 79 L{ax + 19} 85 L{ax + 12} 91 Z" fill="{INK}"/>')
    s.append("</svg>")
    return "".join(s)


def warn_mark(kind="注意"):
    # 三角の注意マーク（絵文字は使わない）
    return (
        f'<svg class="mark" viewBox="0 0 24 22" width="5.2mm" height="4.8mm"><path d="M12 1.5 L23 20.5 L1 20.5 Z" fill="{ACC}"/>'
        f'<rect x="10.8" y="7.5" width="2.4" height="7.5" fill="#fff"/><rect x="10.8" y="16.4" width="2.4" height="2.4" fill="#fff"/></svg>'
    )


# ---------- 図（実画面＋引出線）----------
B = {k: (v["x"], v["y"], v["width"], v["height"]) for k, v in BOX.items() if isinstance(v, dict)}

SPR = 44  # スマホの図の右の余白（番号を置く）


def _cy(k):
    x, y, w, h = B[k]
    return y + h / 2


def _cx(k):
    x, y, w, h = B[k]
    return x + w / 2


F_SP_HOME = shot(
    "sp-home.png", 390, 844, (0, 0, 390, 844), 56,
    [
        dict(box="sp.ok", n=1, to=(390 + SPR / 2, _cy("sp.ok"))),
        dict(box="sp.signin", n=2, to=(390 + SPR / 2, _cy("sp.signin") + 34)),
    ],
    pad=(0, SPR, 0, 0),
)
F_SP_OAUTH = shot(
    "sp-oauth.png", 390, 844, (0, 296, 390, 300), 56,
    [dict(box="sp.return", n=3, to=(390 + SPR / 2, _cy("sp.return")), margin=4)],
    pad=(0, SPR, 0, 0),
)
# 5 ページ：スマホは上のツールバーと下の録音バーだけ切り出す
F_SP_TOOL = shot(
    "sp-editor.png", 390, 844, (0, 103, 390, 58), 64,
    [dict(box="sp.voice", n=1, to=(_cx("sp.voice"), 161 + 26), text="マイクのボタン", anchor="start")],
    pad=(0, 0, 50, 0),
)
F_SP_BAR = shot(
    "sp-voice.png", 390, 844, (0, 760, 390, 56), 64,
    [
        dict(box="sp.record", n=3, to=(_cx("sp.record"), 760 - 24), text="Record", anchor="start"),
        dict(box="sp.interval", n=2, to=(_cx("sp.interval"), 816 + 24), text="手動 → 5min", anchor="start"),
    ],
    pad=(48, 0, 48, 0),
)
F_PC_HOME = shot(
    "pc-home.png", 1280, 800, (0, 0, 1280, 800), 166,
    [
        dict(box="pc.ok", n=1, to=(1280 + 27, _cy("pc.ok"))),
        dict(box="pc.signin", n=2, to=(1280 + 27, _cy("pc.signin"))),
    ],
    pad=(0, 54, 0, 0),
)
F_PC_OAUTH = shot("pc-oauth.png", 1000, 560, (250, 200, 500, 140), 80, [])

# 5 ページ：PC は上（＋と Voice）と下の録音バー（録音前・録音中）を切り出す
F_PC_TOP = shot(
    "pc-editor.png", 1280, 800, (0, 0, 1280, 240), 174,
    [
        dict(box="pc.plus", n=1, to=(330, 205), text="新しいドキュメント", anchor="start", margin=5),
        dict(box="pc.voice", n=2, to=(_cx("pc.voice"), -24), text="Voice", anchor="end"),
    ],
    pad=(48, 0, 0, 0),
)
F_PC_BAR = shot(
    "pc-voice.png", 1280, 800, (240, 714, 1040, 66), 174,
    [
        dict(box="pc.record", n=5, to=(_cx("pc.record"), 714 - 24), text="Record（録音を始める）", anchor="start"),
        dict(box="pc.interval", n=4, to=(_cx("pc.interval"), 714 - 24), text="Manual → 5min に変える", anchor="end"),
    ],
    pad=(48, 0, 0, 0),
)
F_PC_STOP = shot(
    "pc-recording.png", 1280, 800, (240, 696, 1040, 84), 174,
    [
        dict(box="pc.stop", n=8, to=(_cx("pc.stop"), 696 - 24), text="Stop（録音を止める）", anchor="start"),
        dict(box="pc.countdown", n=6, to=(_cx("pc.countdown"), 696 - 24), text="次にまとめるまでの残り", anchor="end", margin=2),
        dict(box="pc.recstructure", n=7, to=(_cx("pc.recstructure"), 780 + 24), text="Structure（いますぐまとめる）", anchor="end"),
    ],
    pad=(48, 0, 48, 0),
)
F_PC_SHARE = shot(
    "pc-editor.png", 1280, 800, (900, 0, 380, 120), 80,
    [dict(box="pc.share", n=1, to=(_cx("pc.share"), 120 + 26))],
    pad=(0, 0, 50, 0),
)


def steps(items):
    out = ['<ol class="steps">']
    for it in items:
        if isinstance(it, tuple):
            main, note = it
        else:
            main, note = it, None
        out.append(f"<li><p>{main}</p>")
        if note:
            out.append(f'<p class="note">{note}</p>')
        out.append("</li>")
    out.append("</ol>")
    return "".join(out)


def steps_from(start, items):
    return steps(items).replace('<ol class="steps">', f'<ol class="steps" style="counter-reset: st {start - 1}">', 1)


def page(n, section, body):
    return f"""
<section class="page">
  <header><span>MarkFlow 取扱説明書</span><span>{section}</span></header>
  <div class="body">{body}</div>
  <footer>{n}</footer>
</section>"""


K = lambda s: f'<b class="k">{s}</b>'  # 押すボタン（原文ママ）

P1 = page(1, "はじめに", f"""
<div class="cover">
  <p class="kind">取扱説明書</p>
  <h1>MarkFlow</h1>
  <p class="lead">スマホ（Android）と PC（Windows）で、会議の録音から議事録まで</p>
  <p class="model">形名　MarkFlow 0.6.4 ベータ版</p>
</div>
<h2>ご使用の手順</h2>
<div class="fig">{fig_overview()}</div>
<div class="howto"><b>この説明書の見かた</b>　<b class="k">OK</b> のように【 】で囲んだ字は、画面のボタンの文字そのままです。図の <span class="dot">1</span> <span class="dot">2</span> … は、手順の中の「図①」「図②」と対応しています。</div>
<div class="two">
  <div>
    <h2>ご用意いただくもの</h2>
    <table class="spec">
      <tr><th>スマホ</th><td>社用の Android</td></tr>
      <tr><th>PC</th><td>社用の Windows PC</td></tr>
      <tr><th>アカウント</th><td>会社の Google アカウント（<span class="nw">@gendai-a.co.jp</span>）</td></tr>
      <tr><th>リンク</th><td>三田から届いた 2 つのリンク（スマホ用の参加リンク・PC 用のダウンロード）</td></tr>
    </table>
  </div>
  <div>
    <h2>安全上のご注意</h2>
    <div class="caution">{warn_mark()}<div><p class="ct">注意</p><p>録音を始める前に、会議の参加者にひとこと伝えてください。</p></div></div>
    <div class="caution">{warn_mark()}<div><p class="ct">お願い</p><p>スマホと PC は、同じ会社のアカウントでログインしてください。同じドキュメントがどちらにも出ます。</p></div></div>
  </div>
</div>
""")

P2 = page(2, "スマホ（Android）に入れる", f"""
<h2>スマホ（Android）に入れる</h2>
<div class="side">
  <div class="col-text">
  {steps([
      ("Play ストアにログインしているアカウントが、会社のアカウント（@gendai-a.co.jp）か確かめる。",
       "Play ストアの右上の丸いアイコンを押すと、いまのアカウントが出ます。"),
      ("三田から届いた<b>参加リンク</b>（play.google.com/apps/internaltest/…）を、スマホで開く。", None),
      ("開いたページでテストに参加し、Google Play のページへ進む。",
       "ボタンの文字は、Google の画面のつくりで変わることがあります。"),
      (f"「Markflow - Markdown Editor」の{K('インストール')}を押す。終わったらアプリを開く。", None),
      (f"最初に出る「利用状況データについて」は{K('OK')}（右の図①）。", None),
      (f"右上の<b>ログインのボタン</b>（→ の形）を押し（右の図②）、Google のアカウントを選ぶ画面で会社のアカウントを選ぶ。", None),
      (f"ブラウザに「サインインが完了しました」と出たら、{K('アプリに戻る')}を押す（右下の図③）。", None),
      ("初めて録音するとき、マイクを使ってよいか聞かれたら、許可する。", None),
  ])}
  </div>
  <div class="col-fig">
    <div class="fig">{F_SP_HOME}</div>
    <div class="fig">{F_SP_OAUTH}</div>
  </div>
</div>
""")

P3 = page(3, "PC（Windows）に入れる", f"""
<h2>PC（Windows）に入れる</h2>
{steps([
    ("PC で、三田から届いた<b>ダウンロードのリンク</b>を開き、ファイルを保存する。",
     "ファイル名は <span class=\"mono\">MarkFlow_0.6.4-beta.12_x64-setup.exe</span>（約 14MB）のような形です。ブラウザが保存してよいか聞いてきたら、保存する方を選んでください。"),
    ("保存したファイルをダブルクリックする。", None),
    (f"青い画面「Windows によって PC が保護されました」が出たら、{K('詳細情報')}を押し、続けて{K('実行')}を押す（下の図）。", None),
])}
<div class="fig">{fig_smartscreen()}</div>
{steps([
    (f"英語のインストーラが開く。{K('Next &gt;')}を押す（下の図①）。", None),
    (f"「Choose Install Location」はそのまま{K('Install')}を押す（②）。", None),
    (f"「Completing MarkFlow Setup」で、「Run MarkFlow」にチェックが入ったまま{K('Finish')}を押す（③）。MarkFlow が開きます。",
     "「Create desktop shortcut」にチェックが入っていると、デスクトップに MarkFlow のアイコンができます。"),
])}
<div class="fig">{fig_nsis()}</div>
<p class="memo">管理者のパスワードは要りません（いま使っている Windows のユーザーにだけ入ります）。次からの更新は、アプリが自動で行います。</p>
""").replace('<ol class="steps">', '<ol class="steps">', 1)

# 2 つ目の手順リストは 4 から数える
P3 = P3.replace('<ol class="steps"><li><p>英語', '<ol class="steps" start="4"><li><p>英語', 1)

P4 = page(4, "ログインする（PC）", f"""
<h2>PC でログインする</h2>
<p class="intro">スマホでは 2 ページの手順 5〜7 でログインが済んでいます。PC でも同じ会社のアカウントでログインします。</p>
<div class="fig">{F_PC_HOME}</div>
{steps([
    (f"MarkFlow が開いたら、「利用状況データについて」は{K('OK')}（図①）。", None),
    (f"右上の{K('Sign in')}を押す（図②）。ブラウザが開くので、会社のアカウントを選ぶ。", None),
    ("ブラウザに「Signed in successfully」と出たら、そのタブを閉じて MarkFlow に戻る。",
     "英語で「このタブを閉じて MarkFlow に戻ってください」という意味です。"),
])}
<div class="fig small">{F_PC_OAUTH}</div>
<p class="memo">ログインすると、スマホで作ったドキュメントも PC の左の「My Documents」に並びます。</p>
""")

P5 = page(5, "会議を録って議事録にする", f"""
<h2>会議を録って議事録にする（PC）</h2>
<div class="fig">{F_PC_TOP}</div>
{steps([
    (f"左の「My Documents」の{K('+')}で、新しいドキュメントを作る（図①）。1 行目の <span class=\"mono\">#</span> のあとに会議名を書く。", None),
    (f"上の{K('Voice')}を押す（図②）。下に録音のバーが出ます。", None),
    ("<b>Web 会議の相手の声も録るとき</b>は、録音の前に、バーの<b>画面の形のボタン</b>を押してオンにする（下の図③）。マイクの声に加えて、PC から出ている音も録ります。",
     "マウスを重ねると、オフのときは「システム音声も録音（会議等）」、オンのときは「システム音声 ON（クリックで無効化）」と出ます。対面の会議ならオフのままで構いません。"),
])}
<div class="fig">{fig_sysaudio()}</div>
{steps_from(4, [
    (f"録音の前に、バーの{K('Manual')}を{K('5min')}に変える（図④）。録音しながら 5 分ごとに、それまでの話を議事録の形にまとめて本文に書いていきます（Structure）。",
     "間隔は 1min〜5min から選べます。おすすめは 5min です。"),
])}
<div class="fig">{F_PC_BAR}</div>
<div class="fig">{F_PC_STOP}</div>
{steps_from(5, [
    (f"{K('Record')}で録音を始める（図⑤）。バーの上の線と秒数は、次にまとめるまでの残り時間です（図⑥）。", None),
    (f"すぐにまとめたいときは{K('Structure')}（図⑦）。", None),
    (f"会議が終わったら{K('Stop')}（図⑧）。最後に{K('Structure')}をもう一度押して、最後の数分ぶんもまとめる。", None),
])}
<div class="tip"><p class="tt">仕上げに使える {K('Refine')}</p><p>止めたあと、Structure の右に{K('Refine')}が出ます。押すと録音の全体を文字に起こし直して、議事録を書き直します。より正確に仕上げたいときに使ってください（長い会議は数分かかります）。</p></div>
""")

P6 = page(6, "スマホで録る・共有・困ったとき", f"""
<h2>スマホで録るとき</h2>
<div class="pair">
  <div class="fig">{F_SP_TOOL}</div>
  <div class="fig">{F_SP_BAR}</div>
</div>
<p>{K('Voice')}の代わりに、上の<b>マイクのボタン</b>を押します（図①）。下のバーの{K('手動')}を{K('5min')}に変え（図②）、{K('Record')}で録音を始めます（図③）。あとは PC と同じです。スマホには PC の音を録るボタンは無く、マイクで録ります。</p>
<p class="note">録音中に別のドキュメントを開いても、録音は最初のドキュメントに入ります。</p>
<h2>議事録を人に見せる</h2>
<div class="side mini">
  <div class="fig">{F_PC_SHARE}</div>
  {steps([
      ("右上の<b>共有のボタン</b>（丸が 3 つつながった形）を押す（左の図①）。スマホも同じ場所です。", None),
      (f"{K('Webに公開')}を押す。「誰でも閲覧できる公開URLを生成します。」と書いてあるとおり、リンクを知っている人なら誰でも読めます。", None),
      ("できた URL（markflow.jp/p/…）をコピーして、チャットで送る。",
       f"内容を直したら{K('再公開（内容を更新）')}、見せるのをやめるときは{K('公開停止')}。"),
  ])}
</div>
<h2>故障かな？と思ったら</h2>
<table class="trouble">
  <tr><th>こんなとき</th><th>こうしてください</th></tr>
  <tr><td>参加リンクを開いても、テストに参加できない・アプリが出てこない</td><td>Play ストアのアカウントが会社のアカウントか確かめ、違えば切り替えてからリンクを開き直す。それでも出なければ三田へ（登録が済んでいないことがあります）。</td></tr>
  <tr><td>「Windows によって PC が保護されました」に{K('実行')}が出ない</td><td>会社の PC の設定で止められています。三田へ連絡してください。</td></tr>
  <tr><td>インストーラが「Failed to install WebView2!」で止まる</td><td>インターネットにつながっているか確かめて、ファイルをもう一度ダブルクリックする。</td></tr>
  <tr><td>ログインのあと、アプリに戻らない</td><td>スマホはブラウザの{K('アプリに戻る')}を押す。PC はタブを閉じて MarkFlow に戻り、戻っていなければ{K('Sign in')}をもう一度。</td></tr>
  <tr><td>スマホと PC でドキュメントが違う</td><td>両方が同じ会社のアカウントでログインしているか確かめる。</td></tr>
  <tr><td>プランや上限の画面が出た</td><td>購入はしないで、三田へ連絡してください（社内用の設定をします）。</td></tr>
</table>
<p class="contact">わからないときは、画面の写真を撮って三田（Google Chat）へ。</p>
""")

CSS = f"""
@page {{ size: A4; margin: 0; }}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
body {{ font-family: {FONT}; color: {INK}; font-size: 9.6pt; line-height: 1.62; font-feature-settings: "palt"; letter-spacing: 0.01em; }}
.page {{ width: 210mm; height: 297mm; padding: 13mm 16mm 14mm; position: relative; page-break-after: always; overflow: hidden; }}
header {{ display: flex; justify-content: space-between; font-size: 8pt; color: {SUB}; border-bottom: 0.3mm solid {INK}; padding-bottom: 1.6mm; margin-bottom: 6mm; }}
footer {{ position: absolute; bottom: 8mm; left: 0; right: 0; text-align: center; font-size: 8pt; color: {SUB}; }}
h1 {{ font-size: 34pt; font-weight: 600; letter-spacing: 0.02em; line-height: 1.1; }}
h2 {{ font-size: 13pt; font-weight: 600; margin: 5mm 0 2.6mm; padding-left: 2.6mm; border-left: 1.4mm solid {INK}; line-height: 1.3; }}
h2:first-child {{ margin-top: 0; }}
h3 {{ font-size: 10.5pt; font-weight: 600; margin-bottom: 1.4mm; }}
.cover {{ border: 0.5mm solid {INK}; padding: 7mm 8mm 6mm; margin-bottom: 7mm; }}
.cover .kind {{ font-size: 12pt; font-weight: 600; letter-spacing: 0.4em; margin-bottom: 2mm; }}
.cover .lead {{ font-size: 12pt; margin-top: 3mm; }}
.cover .model {{ font-size: 9pt; color: {SUB}; margin-top: 4mm; border-top: 0.25mm solid {RULE}; padding-top: 2mm; }}
.fig {{ margin: 2mm 0 3mm; }}
.fig svg {{ display: block; }}
.fig.small {{ margin-left: 0; }}
.two {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin-top: 2mm; }}
.side {{ display: grid; grid-template-columns: 1fr 58mm; gap: 7mm; align-items: start; }}
.side.mini {{ grid-template-columns: 82mm 1fr; gap: 6mm; margin-top: 2mm; }}
.side.mini .fig {{ margin: 0; }}
table {{ border-collapse: collapse; width: 100%; }}
.spec th, .spec td {{ border-top: 0.25mm solid {RULE}; padding: 1.6mm 1mm; vertical-align: top; text-align: left; }}
.spec tr:last-child th, .spec tr:last-child td {{ border-bottom: 0.25mm solid {RULE}; }}
.spec th {{ width: 21mm; font-weight: 600; white-space: nowrap; }}
.caution {{ display: flex; gap: 2.4mm; border: 0.3mm solid {INK}; padding: 2.4mm 3mm; margin-bottom: 2.6mm; }}
.caution .mark {{ flex: none; margin-top: 0.6mm; }}
.caution .ct {{ font-weight: 600; color: {ACC}; }}
ol.steps {{ list-style: none; counter-reset: st; }}
ol.steps[start="4"] {{ counter-reset: st 3; }}
ol.steps > li {{ counter-increment: st; position: relative; padding-left: 9mm; margin-bottom: 2.4mm; }}
ol.steps > li::before {{ content: counter(st); position: absolute; left: 0; top: 0.4mm; width: 6mm; height: 6mm; background: {INK}; color: #fff; font-weight: 600; font-size: 9.5pt; line-height: 6mm; text-align: center; }}
.note {{ font-size: 8.4pt; color: {SUB}; margin-top: 0.6mm; }}
.memo {{ font-size: 8.8pt; border-top: 0.25mm solid {RULE}; padding-top: 2mm; margin-top: 2mm; }}
.intro {{ margin-bottom: 2mm; }}
b {{ font-weight: 600; }}
b.k {{ font-weight: 600; color: {ACC}; }}
b.k::before {{ content: "【"; }}
b.k::after {{ content: "】"; }}
.mono {{ font-family: {MONO}; font-size: 8.4pt; }}
.trouble th, .trouble td {{ border-top: 0.25mm solid {RULE}; padding: 1.8mm 1.6mm; text-align: left; vertical-align: top; font-size: 8.8pt; }}
.trouble tr:first-child th {{ border-top: 0.4mm solid {INK}; border-bottom: 0.25mm solid {INK}; font-size: 8.4pt; }}
.trouble tr:last-child td {{ border-bottom: 0.4mm solid {INK}; }}
.trouble td:first-child {{ width: 62mm; font-weight: 600; }}
.pair {{ display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; align-items: end; }}
.nw {{ white-space: nowrap; }}
.howto {{ font-size: 8.8pt; border: 0.3mm solid {RULE}; padding: 2.2mm 3mm; margin: 1mm 0 5mm; }}
.dot {{ display: inline-block; width: 4.4mm; height: 4.4mm; border-radius: 50%; background: {INK}; color: #fff; font-size: 7.4pt; line-height: 4.4mm; text-align: center; font-weight: 600; }}
.tip {{ border: 0.3mm solid {INK}; padding: 2.2mm 3mm; margin: 1mm 0 2mm; font-size: 8.8pt; }}
.tip .tt {{ font-weight: 600; margin-bottom: 0.6mm; }}
.contact {{ margin-top: 4mm; font-weight: 600; }}
"""

html = f"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>MarkFlow 取扱説明書（Android・Windows）</title>
<style>{CSS}</style></head><body>{P1}{P2}{P3}{P4}{P5}{P6}</body></html>"""
open(os.path.join(HERE, "manual.html"), "w").write(html)
# 線画だけの図は単体の SVG にも書き出す（dopa-shiryo の検査用）
os.makedirs(os.path.join(HERE, "svg"), exist_ok=True)
for name, svg in [("overview", fig_overview()), ("smartscreen", fig_smartscreen()), ("installer", fig_nsis()), ("sysaudio", fig_sysaudio())]:
    open(os.path.join(HERE, "svg", f"{name}.svg"), "w").write(svg)
print("ok", len(html))
