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

かつて `capture.js` (v13 で撤去) と `background.js` が両方 `running` を宣言して
いて、
`background.js` が起動せず OGP が全滅した。エラーは背景ページのコンソールにしか
出ないため、表からは「なぜか OGP が取れない」としか見えない。

背景スクリプトを追加するときは、必ず `(() => { ... })();` で全体を囲むこと。

### キャッシュには取り出し方の版を持たせる

`background.js` は取得結果を `storage.local` に保存する。**「画像が見つからな
かった」という結果も保存される**ため、取得元を増やしたり上限を変えたりしても、
既存のブックマークには反映されない。

実際、読み込み上限を 2MB に上げた後も YouTube の視聴ページは頭文字タイルの
ままだった。512KB 時代に「画像なし」と判定した結果が 7 日間残っていたため。

対策は 3 つ:

| 対策 | 内容 |
| --- | --- |
| `EXTRACT_VERSION` | キャッシュに版を持たせ、版が違えば無視して取り直す。**取り出し方を変えたら必ず上げる** |
| 失敗結果の寿命を短く | 画像が取れた結果は 7 日、取れなかった結果は 1 日 (`CACHE_TTL_EMPTY_MS`) |
| 設定画面の消去ボタン | `og:` と `shot:` (撮影時代の残り) で始まる保存を消す。待たずに取り直せる |

版番号を持たない古い形式のキャッシュを背景側で仕込んだうえで動作を確認済み。
版違いとして捨てられ、動画サムネイルが出ることを見た。

### 読み込み上限は「head だけ」では足りない

`MAX_BYTES` は 1 ページから読む上限。当初 512KB にして「`<head>` が読めれば
十分」と決め打っていたが、足りなかった。

| URL | og:image の位置 | 512KB 上限での結果 |
| --- | --- | --- |
| `youtube.com/` | 6KB | 取れる |
| `youtube.com/watch?v=...` | 679KB | **取れない** |
| `youtu.be/...` | 680KB | **取れない** |

YouTube の視聴ページは og タグの前に 670KB ほどのスクリプトが入っている。
トップページだけ通っていたので気づきにくかった。現在は 2MB。

上限は**これより大きいページにしか影響しない**。普通のページは末尾まで読んで
終わるので、上げても取得量は変わらない。`</head>` を見つけたら止める案も
あるが、JSON-LD や本文中の画像は `<body>` にあることが多く、それらの取得元を
潰してしまうので採らない。

### 設定画面

`options_ui` で `src/options.html` を開く。取得方法 1〜5 をそれぞれ入り切りできる。

既定値と読み出しは `src/defaults.js` に置き、背景ページと設定画面の両方から
読む。この 1 枚だけ IIFE で包んでいない (両方の文脈でグローバルとして使うため)。
`background.js` が `storage.onChanged` を見ていて、設定を変えるとその場で効く。ブラウザの再起動は要らない。

見た目はチェックボックスのまま `appearance: none` で角丸のスライドスイッチに
している。`input` のままなのでキーボード操作も読み上げも普通に効く。

### 2xx で返らないページは状態を出す

消えたブックマークは珍しくない。画像を探しても意味が無いので、HTTP の番号と
その意味だけを平たいタイル (3:1) で出す。

`fetchText` は `!response.ok` のとき `httpStatus` を持たせた Error を投げ、
`getMetadata` がそれを結果に載せる。接続そのものに失敗した場合は
`httpStatus: 0` とし、`netKind` で `timeout` と `network` を区別する。

ニュータブ側は `httpStatus` があれば、頭文字タイルではなく状態タイルを出す。

配色は 4xx を橙 (`status-client`)、5xx と接続不可を紫 (`status-server`) に
分けてある。番号を知らなくても、色で「こちら側の問題か向こう側か」が分かる。

### 画像は取れるところから順に取る

撮影という最後の手段が無くなったので (後述)、HTML から取り出せる道を尽くす。

`src/background.js` が次の順で探す:

| 順 | 取得元 | 備考 |
| --- | --- | --- |
| 1 | `og:image` / `twitter:image` | 従来から |
| 2 | `link rel="image_src"` | 古いが今も使われる |
| 3 | JSON-LD (`application/ld+json`) | `image` / `thumbnailUrl` / `logo`、`@graph` も辿る |
| 4 | **RSS / Atom フィード** | `link rel=alternate` から見つけて取得。`media:thumbnail`、`media:content`、画像の `enclosure`、RSS の `<image><url>`、Atom の `<logo>`/`<icon>`、本文中の `img` |
| 5 | 本文中の `img` | 下記。ここで見つからなければ「サムネイルなし」で確定 |

どこから取れたかは `imageSource` で返る。動作確認に使える。

報告のあった rawkuma.net は `og:image` も `twitter:image` も `image_src` も
持たないが JSON-LD に画像があり、そこから表紙画像を出せている
(RSS/Atom も持っているので、JSON-LD が無くても 4 で拾える)。

フィードの取得はページ本体に画像が無いときだけ行う。1 ページあたり最大 2 回の
取得で済む。読む量は本体と同じく `MAX_BYTES` までに制限している。

### 本文の `img` を寸法属性で選ばない

かつて 5 は `width`/`height` **属性**が 200x120 以上のものだけを見ていた。今の
HTML は寸法を CSS に置くので属性が無いほうが普通で、この段はほとんどのページで
何も返していなかった。

nyahentai.one と momon-ga.com がこれ。OGP も `image_src` もフィードも持たず、
JSON-LD (Yoast) にも画像が無く、一覧の `<img>` にだけ絵があるのに寸法属性が
無いため素通りしていた。

属性は「小さいと分かっているものを外す」ためだけに使い、無いことは外す理由に
しない。加えて遅延読み込み (`data-src` / `srcset`) の在り処を見て、
`DECORATION_RE` でアイコンやロゴらしい名前を避け、前のほうにあるものを選ぶ。

### 新規プロファイルの初回起動では投入したブックマークが消える

Firefox 自身の既定ブックマーク取り込みが背景ページより後に走り、先に入れた
ものを消す。`tools/seed-bookmarks.js` はメニューに既定項目が現れるのを待って
から投入している。

## 設計メモ

### なぜ背景ページで OGP を取るのか

ページ本文の取得はクロスオリジンになるため、`http://*/*` と `https://*/*` を持つ背景スクリプトが
`fetch` して `DOMParser` で `og:title` / `og:image` を抜き出す。結果は
`storage.local` に 7 日間キャッシュ。同時接続は 4 本まで、レスポンスは先頭
512KB だけ読む（`<head>` が読めれば足りる）。`Content-Type` と `meta` から
文字コードを判定するので Shift_JIS のページも読める。

### 狭いホスト権限と撮影は両立しない (v13 で撮影を捨てた)

`<all_urls>` は `file:` も含むため、Firefox の権限一覧に「ユーザーのコンピューター
上のローカルファイルへのアクセス」が出る。v12 でこれを嫌い、`http://*/*` と
`https://*/*` に絞った。OGP 取得は `^https?://` しか見ないので、これで足りる。

**だがこれは撮影機能を黙って壊した。** Firefox は「実際に何を読むか」ではなく
**マニフェストに `<all_urls>` という文字列があるか**だけで API を露出するか決める。
Firefox 140 の `tabs.json` スキーマを omni.ja から取り出して確認した:

| 関数 | 露出条件 |
| --- | --- |
| `tabs.captureTab` | `<all_urls>` |
| `tabs.captureVisibleTab` | `<all_urls>` または `activeTab` |

`http://*/*` + `https://*/*` は origin の集合に入るだけで、この文字列一致には
効かない。結果 `browser.tabs.captureTab` が**存在しなくなり**、権限エラーでは
なく `is not a function` で落ちる。v12 以降、撮影は全サイトで動いていなかった。
しかも失敗は 24 時間キャッシュされるので、表からは「取れないサイト」と
区別が付かなかった。

`captureVisibleTab` なら `activeTab` でも代替できるが、`captureTab` は
`<all_urls>` 一択。しかも `activeTab` は利用者が操作したタブにしか効かないので、
隠しタブ方式とは噛み合わない。

v13 では権限の狭さを取り、撮影機能そのものを捨てた。`src/capture.js` を削除し、
それだけが使っていた `tabHide` 権限も返上した。取得方法は 1〜5 になり、どこからも
画像が取れないページは「サムネイルなし」で確定する。動かない選択肢を設定画面に
残して利用者を騙さないため。

撮影を戻すなら `<all_urls>` を必須か `optional_permissions` で名乗るしかない。
実装は `git show ea6be3e:src/capture.js` に一式残っている (隠しタブ、間隔制御、
安全確認、余白削り)。

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
だけ作る。OGP を持つサイトと持たないサイトの両方が入っている。後者は
「サムネイルなし」の見え方の確認に使える。

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

`--list` を付けると AMO 側にある版とその状態だけを表示する。状態が `public`
なら署名は済んでいる。

版の一覧は `/api/v5/addons/addon/{guid}/versions/?filter=all_with_unlisted`
から取る。`addon/` セグメントが要る点と、unlisted は `filter` を付けないと
一覧に出てこない点に注意。`/api/v5/addons/{guid}/versions/{version}/` という
経路もあるが、こちらは 404 になる。

AMO は未公開 (unlisted) のアドオンに対し、資格情報が通らない場合も 401 ではなく
404 を返す。404 が出たら「バージョンが無い」と「認証が通っていない」の両方を疑う。

なお AMO は再梱包時に manifest.json の非 ASCII 文字を \\uXXXX 形式に変換する。
署名済み XPI と手元のビルドはバイト単位では一致しないが、内容は同じ。

### アイコン

```sh
node tools/make-icons.js
```

`src/icons/*.png` は生成物。
