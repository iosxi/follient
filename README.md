# follient

ブックマークを Pinterest 風のタイルで表示する Firefox の新しいタブ。

- 起動直後はブックマークのルートを表示する
- フォルダはフォルダアイコンのカード、ブックマークは OGP のタイトルと画像のカード
- 2 種類とも同じカードで、高さの揃わないタイル (masonry) に並ぶ
- カードがビューエリアに入った時点で OGP を取りに行き、画像を表示する
- フォルダをクリックするとその中を同じ形式で展開する
- ルート以外では、一番上に「上層に戻る」リンクが出る

## 構成

| ファイル | 役割 |
| --- | --- |
| [manifest.json](manifest.json) | MV2。`chrome_url_overrides.newtab` で新しいタブを差し替える |
| [src/newtab.html](src/newtab.html) | 画面の骨格とカードのテンプレート |
| [src/newtab.css](src/newtab.css) | タイル配置と配色 (ライト/ダーク両対応) |
| [src/newtab.js](src/newtab.js) | ブックマークの読み出し、masonry、遅延読み込み、階層移動 |
| [src/background.js](src/background.js) | OGP の取得・解析・キャッシュ |

### なぜ背景ページで OGP を取るのか

ページ本文の取得はクロスオリジンになるため、`<all_urls>` を持つバックグラウンド
スクリプトが `fetch` して `DOMParser` で `og:title` / `og:image` を抜き出す。
結果は `storage.local` に 7 日間キャッシュする。同時接続は 4 本までに絞り、
レスポンスは先頭 512KB だけ読む (`<head>` が読めれば足りるため)。
`Content-Type` と `meta` から文字コードを判定するので Shift_JIS のページも読める。

### masonry の作り方

`grid-auto-rows` を 4px の細かい行にし、カードの実測高さから
`grid-row-end: span N` を JS で計算している。`ResizeObserver` を各カードに
付けてあるので、画像の読み込みやウィンドウ幅の変化で高さが変わっても貼り直る。
OGP 画像は読み込み後に実際の縦横比を `.thumb` に反映する (極端な比率は 0.62〜2.4 に丸める)。

## 開発時の読み込み

一時的な読み込み (署名不要):

1. Firefox で `about:debugging#/runtime/this-firefox` を開く
2. 「一時的なアドオンを読み込む」から `manifest.json` を選ぶ
3. 新しいタブを開くと follient が出る (初回は新しいタブの変更確認が出るので「変更を維持」)

`web-ext` を使う場合:

```sh
npx web-ext run --source-dir .
npx web-ext lint --source-dir . --ignore-files "tools/**"
```

## 動作テスト

新規プロファイルにはブックマークがほとんど無いので、テスト用の階層を作る
ビルドを用意してある。

```sh
node tools/make-test-build.js /tmp/follient-test
npx web-ext run --source-dir /tmp/follient-test --firefox-profile /tmp/ff-profile \
  --keep-profile-changes
```

`tools/seed-bookmarks.js` がツールバー配下にフォルダ入りのブックマークを一度だけ作る
(`storage.local` のフラグで二重投入を防ぐ)。製品のビルドには含まれない。

拡張機能ページを直接開きたい場合は、プロファイルの `prefs.js` にある
`extensions.webextensions.uuids` から UUID を引いて
`moz-extension://<uuid>/src/newtab.html` を開く。`#f/<フォルダID>` を付ければ
その階層から表示できる (例: `#f/toolbar_____`)。

## 配布 (XPI)

```sh
node tools/build-xpi.js     # -> dist/follient-<version>.xpi
```

`manifest.json` と `src/` だけを詰めた ZIP で、`tools/` や設計書は入らない。
更新日時を固定してあるので、内容が同じなら毎回同じファイルができる。

### 他の人に試してもらう

**未署名のまま渡す場合**、通常版の Firefox には恒久インストールできない
(Release / Beta では署名必須の設定を解除できないため)。一時読み込みで試してもらう:

1. `about:debugging#/runtime/this-firefox` を開く
2. 「一時的なアドオンを読み込む」で `follient-<version>.xpi` を選ぶ
3. 新しいタブを開く。初回は新しいタブの変更確認が出るので「変更を維持」

この方法は Firefox を終了すると消える。恒久的に入れてもらうには、
Developer Edition / Nightly / ESR で `about:config` の
`xpinstall.signatures.required` を `false` にしてもらうか、下の署名を行う。

**署名して渡す場合** (通常版の Firefox にそのまま入る):

1. [addons.mozilla.org](https://addons.mozilla.org/developers/addon/api/key/) で
   API キーとシークレットを発行する
2. 資格情報を環境変数に入れて署名する。`--channel unlisted` なので
   AMO には公開されず、署名済み XPI が `dist/` に落ちてくる:

```powershell
$env:AMO_JWT_ISSUER = "user:12345:67"
$env:AMO_JWT_SECRET = "..."
node tools/sign.js
```

`tools/sign.js` は資格情報を環境変数からのみ読む (引数に書くと履歴や
プロセス一覧に残るため)。`manifest.json` と `src/` だけを一時ディレクトリに
コピーしてから署名するので、`tools/` や設計書は成果物に入らない。

署名には `browser_specific_settings.gecko.id` が使われる。
一度 AMO に登録すると、その ID は以後そのアカウントに紐づくので変更しないこと。

## アイコン

`src/icons/*.png` は生成物。作り直すには:

```sh
node tools/make-icons.js
```

## 既知の制約

- Manifest V2 を使っている。Firefox の MV3 ではホスト権限が既定で付与されず、
  利用者の許可操作を挟まないと OGP を取得できないため。
- OGP を持たないページはホスト名の頭文字を置いたタイルで代替する。
- `chrome_url_overrides.newtab` は恒久インストールには署名が必要
  (`about:debugging` からの一時読み込みは署名不要)。
