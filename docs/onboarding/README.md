# MarkFlow 取扱説明書（Android・Windows）

社内の利用者向けの取説（A4・6ページ）。配布物は `MarkFlow_取扱説明書_Android_Windows.pdf`。

## 作り直し方（リポジトリ直下で）

1. `pnpm dev`（1420 番）を起動する
2. 画面を撮り直す（`img/` の PNG とボタンの座標 `img/boxes.json` を書き直す）
   `cp docs/onboarding/capture.mjs ./.cap-tmp.mjs && node ./.cap-tmp.mjs "$PWD/docs/onboarding/img"; rm ./.cap-tmp.mjs`
3. `python3 docs/onboarding/build.py` で `manual.html` と線画の `svg/` を作る
4. `node docs/onboarding/render.mjs` で PDF にする（各ページのはみ出しの値も出る）
5. 線画は `node ~/.claude/skills/dopa-shiryo/scripts/dopa.mjs check docs/onboarding/svg/<名前>.svg` で検査する

`manual.html`・`svg/`・`preview/` は作るたびに出る中間物なので git に入れない。
Windows の警告とインストーラの図は、NSIS（tauri-bundler 2.10.1）の言語ファイルの文言から描いた一例。
