# DEVELOPMENT

follient の開発メモ。利用者向けの説明は [README.md](README.md)。

## バージョンとリリースの方針

**XPI を変更したら、必ずバージョンを上げる。** 修正依頼で XPI の作り直しが
必要になった場合は XPI を作成し、その XPI が前回と 1 バイトでも違うなら
バージョンを上げてから配る。同じ番号で中身の違う XPI を出さない。

**番号の付けかた: `manifest.json` の `N.0.0` ↔ git タグ `vN`。**

| リリース | manifest version | タグ |
| --- | --- | --- |
| 初回 | `1.0.0` | `v0` |
| 2番目 | `2.0.0` | `v2` |
| 以降 | `3.0.0`, `4.0.0`, … | `v3`, `v4`, … |

初回だけ manifest `1.0.0` にタグ `v0` が付いており対応がずれている。
以降はメジャー番号とタグ番号を一致させる。番号が飛ぶのは構わない。

AMO で署名した番号は**永久に消費される**。同じ番号での再アップロードは
できないので、署名前にバージョンを確定させること。

## 構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | MV2。`chrome_url_overrides.newtab` で新しいタブを差し替える |
| `src/newtab.html` | 画面の骨格とカードのテンプレート |
| `src/newtab.css` | タイル配置と配色（ライト/ダーク両対応） |
| `src/newtab.js` | ブックマークの読み出し、masonry、遅延読み込み、階層移動 |
| `src/background.js` | OGP の取得・解析・キャッシュ |
| `src/capture.js` | OGP 画像が無いページのスクリーンショット取得 |
| `tools/build-xpi.js` | 配布用 XPI の作成 |
| `tools/sign.js` | AMO 署名 |
| `tools/fetch-signed.js` | 署名済み XPI の取得のみやり直す |
| `tools/make-icons.js` | アイコン PNG の生成 |
| `tools/make-test-build.js` | 動作テスト用ビルドの作成 |
| `tools/seed-bookmarks.js` | テスト用ブックマークの投入（製品には含めない） |

## 落とし穴

### 背景スクリプトは必ず IIFE で閉じる

MV2 の背景ページは `background.scripts` の全ファイルを**同一のグローバル
スコープ**で読み込む。異なるファイルが同じ名前を `const`/`let` で宣言すると、
後から読まれたファイルが重複宣言の SyntaxError で**丸ごと実行されない**。

実際に `capture.js` と `background.js` が両方 `running` を宣言していて、
`background.js` が起動せず OGP が全滅した。エラーは背景ページのコンソールにしか
出ないため、表からは「なぜか OGP が取れない」としか見えない。

背景スクリプトを追加するときは、必ず `(() => { ... })();` で全体を囲むこと。

### 撮影ウィンドウを隠す方法は無い

`windows.create({ state: 'minimized' })` は使えない。

- `state` と `width`/`height` は同時指定できず、`windows.create` が例外を投げる
- 最小化されたウィンドウは描画が止まるので、撮れても白紙になる

ページを実際に描画させる必要がある以上、ウィンドウ自体は避けられない。
現状は画面の右下隅へ追い出し、`focused: false` で前面に出さないのが限界。

### 新規プロファイルの初回起動では投入したブックマークが消える

Firefox 自身の既定ブックマーク取り込みが背景ページより後に走り、先に入れた
ものを消す。`tools/seed-bookmarks.js` はメニューに既定項目が現れるのを待って
から投入している。

## 設計メモ

### なぜ背景ページで OGP を取るのか

ページ本文の取得はクロスオリジンになるため、`<all_urls>` を持つ背景スクリプトが
`fetch` して `DOMParser` で `og:title` / `og:image` を抜き出す。結果は
`storage.local` に 7 日間キャッシュ。同時接続は 4 本まで、レスポンスは先頭
512KB だけ読む（`<head>` が読めれば足りる）。`Content-Type` と `meta` から
文字コードを判定するので Shift_JIS のページも読める。

### スクリーンショットの取りかた

拡張機能からヘッドレスブラウザは起動できないので、`windows.create` で
ポップアップを開き、読み込み完了 + `SETTLE_MS` 待ってから `tabs.captureTab()`
で撮る。撮った画像は背景ページの canvas で後処理する。

1. 縁の単色部分を削る（`findContentBox`）。片側 40% までに制限
2. ほぼ単色の画像は捨てる（`looksBlank`）。描画されなかった場合の保険
3. 幅 640px まで縮小し、JPEG 品質 0.72 で保存

間隔の制御（すべて `src/capture.js` 冒頭の定数）:

| 定数 | 既定 | 意味 |
| --- | --- | --- |
| `GLOBAL_GAP_MS` | 6000 | 撮影と撮影の間隔（全ホスト共通） |
| `HOST_GAP_MS` | 90000 | 同一ホストを続けて撮るときの間隔 |
| `JITTER_RATIO` | 0.4 | 上記に上乗せするゆらぎ。等間隔アクセスを避ける |
| `MAX_CACHED` | 120 | 保存する画像の上限。超えたら古い順に捨てる |

待ち行列は 1 件ずつ処理する。ホスト間隔に引っかかった仕事は行列に残したまま、
撮れる別のホストを先に処理する。

`unlimitedStorage` は要求していない。権限を増やすと更新時に利用者の再承認が
必要になるため、画像を小さく保って既定の保存容量に収める方針。

### masonry

`grid-auto-rows` を 4px の細かい行にし、カードの実測高さから
`grid-row-end: span N` を JS で計算する。各カードに `ResizeObserver` を付けて
あるので、画像の読み込みやウィンドウ幅の変化で高さが変わっても貼り直る。
OGP 画像は読み込み後に実際の縦横比を `.thumb` に反映する（極端な比率は
0.62〜2.4 に丸める）。

### MV2 を使っている理由

Firefox の MV3 ではホスト権限が既定で付与されず、利用者の許可操作を挟まないと
OGP を取得できない。

## 作業手順

### 開発時の読み込み

```sh
npx web-ext run --source-dir .
npx web-ext lint --source-dir . --ignore-files "tools/**" "dist/**"
```

または `about:debugging#/runtime/this-firefox` から `manifest.json` を選ぶ。

### 動作テスト

新規プロファイルにはブックマークがほとんど無いので、テスト用の階層を作る
ビルドを使う。

```sh
node tools/make-test-build.js /tmp/follient-test
npx web-ext run --source-dir /tmp/follient-test \
  --firefox-profile /tmp/ff-profile --keep-profile-changes
```

`tools/seed-bookmarks.js` がツールバー配下にフォルダ入りのブックマークを一度
だけ作る。OGP を持つサイトと持たないサイトの両方、および同一ホストが並ぶ
「OGPなし」フォルダ（撮影の間隔制御を見るため）が入っている。

拡張機能ページを直接開くには、プロファイルの `prefs.js` にある
`extensions.webextensions.uuids` から UUID を引いて
`moz-extension://<uuid>/src/newtab.html` を開く。`#f/<フォルダID>` を付ければ
その階層から表示できる（例: `#f/toolbar_____`）。

背景ページのログは `about:debugging` の「調査」から開くコンソールに出る。
web-ext の標準出力には出ない。

### XPI の作成

```sh
node tools/build-xpi.js     # -> dist/follient-<version>.xpi
```

`manifest.json` と `src/` だけを詰める。更新日時を固定しているので、内容が
同じなら毎回同じファイルができる（ハッシュで差分を確認できる）。

### 署名

```powershell
$env:AMO_JWT_ISSUER = "user:12345:67"
$env:AMO_JWT_SECRET = "..."
node tools/sign.js
```

資格情報は環境変数からのみ読む（引数に書くと履歴やプロセス一覧に残る）。
`--channel unlisted` 固定で、AMO には公開されず署名済み XPI が `dist/` に出る。
署名には `browser_specific_settings.gecko.id` が使われる。この ID は AMO 上で
アカウントに永続的に紐づくので変更しないこと。

`tools/sign.js` は `manifest.json` と `src/` だけを一時ディレクトリにコピー
してから署名する。`--ignore-files` に日本語ファイル名を渡さずに済ませるため。

### 署名済み XPI の取得だけやり直す

`sign.js` はアップロード → 署名待ち → ダウンロード の順に進む。アップロードが
済んだ後にダウンロードだけ失敗する (端末が閉じた、通信が切れた) ことがある。
その状態で `sign.js` を再実行すると `Version X already exists` で弾かれるが、
**バージョンを上げる必要は無い**。署名はできているので、取得だけやり直す。

```powershell
$env:AMO_JWT_ISSUER = "user:12345:67"
$env:AMO_JWT_SECRET = "..."
node tools/fetch-signed.js          # manifest のバージョン
node tools/fetch-signed.js 2.0.0    # 明示する場合
```

AMO は未公開 (unlisted) のアドオンに対し、資格情報が通らない場合も 401 ではなく
404 を返す。404 が出たら「バージョンが無い」と「認証が通っていない」の両方を疑う。

### アイコン

```sh
node tools/make-icons.js
```

`src/icons/*.png` は生成物。
