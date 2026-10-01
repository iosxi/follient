/**
 * follient - background
 *
 * ニュータブ側から依頼された URL の OGP メタデータ (og:title / og:image) を
 * 取得して返す。ページ本体の取得はクロスオリジンになるため、
 * http/https のホスト権限を持つこのバックグラウンドスクリプトが担当する。
 */

/* IIFE: 背景ページは複数スクリプトを同じグローバルスコープで読む。
   名前の衝突で他のスクリプトが丸ごと死ぬのを防ぐため閉じ込める。 */
(() => {
  const CACHE_PREFIX = 'og:';

  /**
   * 取り出し方の版。取得元を増やしたり読み込み上限を変えたりしたら上げる。
   *
   * これが無いと、改善しても古い結果を見続けてしまう。実際 512KB 上限だった
   * 頃に「画像なし」と判定された YouTube が、上限を 2MB にした後も 7 日間
   * 頭文字タイルのままだった。版が違うキャッシュは捨てて取り直す。
   *
   * v9 で上げたのは、v24 が**よそのサイトにも付けてしまった updatedAt** を
   * 捨てるため。残しておくと、並べ替えが入りの間ずっと、関係のないページを
   * 1 日に 1 度読み直し続ける。
   */
  const EXTRACT_VERSION = 9;

  /**
   * rawkuma.onl だけの取り出し方の版。
   *
   * v26 までは rawkuma.onl を知らず、サイト共通のロゴを作品の絵として
   * 拾い、話数も日時も持たない結果を保存していた。EXTRACT_VERSION を
   * 上げると何百件あるよその結果まで全部取り直すことになるので、
   * rawkuma.onl の分だけをこちらの版で見分けて捨てる。
   */
  const ONL_EXTRACT_VERSION = 1;

  /** 保存してある結果が、今の取り出し方で作られたものか。 */
  function isCurrentEntry(url, entry) {
    if (!entry || entry.v !== EXTRACT_VERSION) return false;
    if (isOnlHost(url) && entry.onl !== ONL_EXTRACT_VERSION) return false;
    return true;
  }

  /** 画像が取れた結果の寿命。 */
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * 画像が取れなかった結果の寿命。短くしておく。
   * こちらは「今の実装では見つけられなかった」という記録でしかなく、
   * 実装が良くなれば結果が変わりうるため。
   */
  const CACHE_TTL_EMPTY_MS = 24 * 60 * 60 * 1000;

  /**
   * 話数だけの寿命。
   *
   * 「最新が何話か」は毎日変わりうるので、絵とは別の時計で見る。絵は
   * img: に持っていて取り直さないため、ここで期限が切れてもページの HTML を
   * もう一度読むだけで済み、画像の再取得は起きない。
   */
  const CHAPTER_TTL_MS = 24 * 60 * 60 * 1000;

  const FETCH_TIMEOUT_MS = 8000;
  /**
   * 1 ページから読む上限。
   *
   * 「<head> が読めれば十分」と決め打つと足りない。YouTube の視聴ページは
   * og:image が 680KB 付近にあり、512KB で切ると読めなかった (トップページは
   * 6KB 付近なので通っていた)。
   *
   * 上限は「これより大きいページ」にしか影響しない。普通のページは末尾まで
   * 読んで終わるので、上げても取得量は変わらない。
   */
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_CONCURRENCY = 4;

  /** URL -> Promise。同一 URL の多重取得を防ぐ。 */
  const inFlight = new Map();

  /** 設定。設定画面での変更をその場で拾う。 */
  let settings = Object.assign({}, FOLLIENT_DEFAULTS);
  follientLoadSettings().then((loaded) => {
    settings = loaded;
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = Object.assign({}, FOLLIENT_DEFAULTS, changes.settings.newValue || {});
    }
  });

  /** 同時接続数を絞るための簡易セマフォ。 */
  let running = 0;
  const waiting = [];

  function acquire() {
    if (running < MAX_CONCURRENCY) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      running -= 1;
    }
  }

  function isFetchable(url) {
    return /^https?:\/\//i.test(url);
  }

  async function readCache(url) {
    const key = CACHE_PREFIX + url;
    const stored = await browser.storage.local.get(key);
    const entry = stored[key];
    if (!entry) return null;
    // 取り出し方が変わっていたら、古い判断は当てにならない
    if (!isCurrentEntry(url, entry)) return null;
    const ttl = entry.data && entry.data.image ? CACHE_TTL_MS : CACHE_TTL_EMPTY_MS;
    if (Date.now() - entry.at > ttl) return null;

    /*
     * 絵はまだ使えるが、話数や更新日時が古い、という場合は取り直す。
     *
     * どちらも rawkuma のページにしか無い (updatedAt は他所では常に null)。
     * よその何百件を毎日読み直すことにはならない。
     */
    const wantsFresh =
      (settings.showChapters && entry.data && entry.data.chapters) ||
      (settings.sortByUpdated && entry.data && entry.data.updatedAt);
    if (wantsFresh) {
      const at = (entry.data && entry.data.chaptersAt) || entry.at;
      if (Date.now() - at > CHAPTER_TTL_MS) return null;
    }
    return entry.data;
  }

  async function writeCache(url, data) {
    try {
      const entry = { at: Date.now(), v: EXTRACT_VERSION, data };
      if (isOnlHost(url)) entry.onl = ONL_EXTRACT_VERSION;
      await browser.storage.local.set({ [CACHE_PREFIX + url]: entry });
    } catch (e) {
      // 容量超過などは致命的ではないので握りつぶす
      console.warn('follient: cache write failed', e);
    }
  }

  /* ------------------------------------------------------------------ *
   * サムネイルの実体を保存する
   *
   * 候補の URL だけを覚えていても、開くたびに相手から取り直すことになる。
   * 相手が不安定だと、一度出たサムネイルが次に開いたとき出ない。実際
   * rawkuma.net の 500 件フォルダで「読めていたものが元に戻る」という
   * 報告が出た。一度読めた絵は縮小して手元に持ち、次からはそれを出す。
   *
   * 取得は背景側で行う。ニュータブの <img> は他所のオリジンなので canvas が
   * 汚染され、画素を読み出せない。背景はホスト権限があるので普通に取れる。
   * ------------------------------------------------------------------ */

  const THUMB_PREFIX = 'img:';
  const THUMB_INDEX_KEY = 'img:index';

  /**
   * 保存しておく枚数の上限。超えたら古いものから捨てる。
   *
   * 相手が渋いサイトでは 1 枚取るのに何十秒もかかる。せっかく取れたものを
   * 勝手に捨てないよう、実際の蔵書よりずっと大きくしてある。1 枚あたり
   * 30〜60KB 程度なので、埋まっても 100MB 前後。
   */
  const THUMB_MAX = 2000;

  /** 保存する画像の最大幅と質。カード幅の 2 倍あれば足りる。 */
  const THUMB_MAX_WIDTH = 400;
  const THUMB_QUALITY = 0.68;

  /** 元画像の読み込み上限。これより大きいものは縮小せず諦める。 */
  const THUMB_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

  /** 同じページの保存が二重に走らないようにする。 */
  const savingThumb = new Set();

  function thumbKey(url) {
    return THUMB_PREFIX + url;
  }

  async function readThumb(url) {
    try {
      const key = thumbKey(url);
      const stored = await browser.storage.local.get(key);
      const entry = stored[key];
      if (!entry || !entry.image) return null;
      // v26 までに rawkuma.onl で保存したのはサイト共通のロゴ。作品の絵では
      // ないので見なかったことにする。読めた絵が届けば上書きされる。
      if (isOnlHost(url) && entry.onl !== ONL_EXTRACT_VERSION) return null;
      // 期限は設けない。一度取れた絵は、消せと言われるまで持ち続ける。
      // 渋い相手から 1 枚取るのに何十秒もかかることがあり、黙って捨てると
      // その苦労をやり直させることになる。取り直しは ︙ の「サムネイル更新」
      // か、設定画面の一括消去で、利用者が選んだときだけ行う。
      return entry.image;
    } catch (e) {
      return null;
    }
  }

  /** 保存枚数が上限を超えたら、古いものから消す。 */
  async function trimThumbs(index) {
    if (index.length <= THUMB_MAX) return index;
    index.sort((a, b) => a.at - b.at);
    const drop = index.slice(0, index.length - THUMB_MAX);
    await browser.storage.local.remove(drop.map((e) => thumbKey(e.url)));
    return index.slice(index.length - THUMB_MAX);
  }

  async function writeThumb(url, image) {
    try {
      const entry = { at: Date.now(), image };
      if (isOnlHost(url)) entry.onl = ONL_EXTRACT_VERSION;
      await browser.storage.local.set({ [thumbKey(url)]: entry });

      const stored = await browser.storage.local.get(THUMB_INDEX_KEY);
      let index = Array.isArray(stored[THUMB_INDEX_KEY]) ? stored[THUMB_INDEX_KEY] : [];
      index = index.filter((entry) => entry.url !== url);
      index.push({ url, at: Date.now() });
      index = await trimThumbs(index);
      await browser.storage.local.set({ [THUMB_INDEX_KEY]: index });
    } catch (e) {
      // 容量超過などは致命的ではない。次に開いたときまた試す。
      console.warn('follient: thumbnail cache write failed', e);
    }
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = src;
    });
  }

  /**
   * 縮小して JPEG の data URL にする。
   * blob: は拡張機能自身のオリジンなので canvas は汚染されない。
   * JPEG は透過を持てないので、透明な部分が黒くならないよう白で下地を敷く。
   */
  async function shrinkToDataUrl(blob) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImageElement(objectUrl);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) throw new Error('image has no size');

      const scale = Math.min(1, THUMB_MAX_WIDTH / width);
      const outWidth = Math.max(1, Math.round(width * scale));
      const outHeight = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = outWidth;
      canvas.height = outHeight;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outWidth, outHeight);
      ctx.drawImage(img, 0, 0, outWidth, outHeight);

      return canvas.toDataURL('image/jpeg', THUMB_QUALITY);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  /**
   * ニュータブで読めた画像を、背景でも取り直して保存する。
   * たいていはブラウザのキャッシュに載っているので、網には出ない。
   */
  async function saveThumb(pageUrl, imageUrl) {
    if (!isFetchable(imageUrl)) return;
    if (savingThumb.has(pageUrl)) return;
    savingThumb.add(pageUrl);

    await acquire();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let blob;
      try {
        const response = await fetch(imageUrl, {
          credentials: 'omit',
          redirect: 'follow',
          cache: 'force-cache',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const type = response.headers.get('content-type') || '';
        if (type && !/^image\//i.test(type)) return;
        blob = await response.blob();
      } finally {
        clearTimeout(timer);
      }
      if (!blob || blob.size === 0 || blob.size > THUMB_SOURCE_MAX_BYTES) return;

      await writeThumb(pageUrl, await shrinkToDataUrl(blob));
    } catch (e) {
      // 保存できなくても表示は済んでいる。次に開いたときまた試す。
    } finally {
      release();
      savingThumb.delete(pageUrl);
    }
  }

  /**
   * Content-Type ヘッダと meta タグから文字コードを推定してデコードする。
   * 日本語サイトには Shift_JIS / EUC-JP がまだ残っているため。
   */
  function decodeBody(buffer, contentType) {
    const bytes = new Uint8Array(buffer);
    let charset = null;

    const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
    if (fromHeader) charset = fromHeader[1];

    if (!charset) {
      // meta 宣言は ASCII 互換なので latin1 で先読みして構わない
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
      const meta =
        /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ||
        /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
      if (meta) charset = meta[1];
    }

    try {
      return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch (e) {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }

  /** レスポンスの先頭 MAX_BYTES だけを読む。 */
  async function readCapped(response) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      return await response.arrayBuffer();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, total - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
    }
    return out.buffer;
  }

  function absolutize(candidate, baseUrl) {
    if (!candidate) return null;
    try {
      return new URL(candidate, baseUrl).href;
    } catch (e) {
      return null;
    }
  }

  function metaContent(doc, selectors) {
    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      const value = el && el.getAttribute('content');
      if (value && value.trim()) return value.trim();
    }
    return null;
  }

  /** JSON-LD の image は文字列・配列・オブジェクトのいずれもあり得る。 */
  function flattenImage(image) {
    if (!image) return null;
    if (typeof image === 'string') return image;
    if (Array.isArray(image)) {
      for (const item of image) {
        const found = flattenImage(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof image === 'object' && typeof image.url === 'string') return image.url;
    return null;
  }

  function pickJsonLdImage(value, depth) {
    if (!value || depth > 4 || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = pickJsonLdImage(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const direct = flattenImage(value.image || value.thumbnailUrl || value.logo);
    if (direct) return direct;
    for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
      const found = pickJsonLdImage(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function imageFromJsonLd(doc) {
    const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const node of nodes) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch (e) {
        continue; // 壊れた JSON-LD は珍しくない
      }
      const found = pickJsonLdImage(data, 0);
      if (found) return found;
    }
    return null;
  }

  /**
   * アイコンや飾りに使われがちな名前。中身の画像ではないので避ける。
   * 語の切れ目でだけ当てる。"galleries" の中の "ad" などを拾わないため。
   */
  const DECORATION_RE =
    /(^|[\s\/_.-])(icons?|logos?|sprites?|spacer|blank|pixel|avatars?|badges?|banners?|btn|buttons?|arrows?|emoji|loading|loader|placeholder|thumb-default|ads?|advert)([\s\/_.-]|$)/i;

  /**
   * 画像の在り処。遅延読み込みのページは src に 1x1 の透明画像を置き、
   * 本当の場所を data-* や srcset に持たせていることがある。
   */
  const IMAGE_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-echo'];

  function imageUrlOf(img) {
    for (const attr of IMAGE_ATTRS) {
      const value = (img.getAttribute(attr) || '').trim();
      // data: の中身は placeholder であることがほとんどで、カードには使えない
      if (value && value.slice(0, 5) !== 'data:') return value;
    }
    for (const attr of ['srcset', 'data-srcset']) {
      const set = img.getAttribute(attr);
      if (!set) continue;
      const first = set.split(',')[0].trim().split(/\s+/)[0];
      if (first && first.slice(0, 5) !== 'data:') return first;
    }
    return null;
  }

  /**
   * 本文中の、中身らしい画像を選ぶ。
   *
   * かつては width / height 属性が 200x120 以上のものだけを見ていた。
   * だが今の HTML は寸法を CSS に置くので属性が無いほうが普通で、
   * この段はほとんどのページで何も返していなかった。nyahentai.one と
   * momon-ga.com がまさにそれで、OGP も JSON-LD の画像もフィードも持たず、
   * 一覧の <img> にだけ絵があるのに寸法属性が無いため素通りしていた。
   *
   * そこで属性は「小さいと分かっているものを外す」ためだけに使い、
   * 無いことは外す理由にしない。代わりに名前で飾りを避け、前のほうに
   * 出てくるものを選ぶ。見出し画像はたいてい本文の先頭側にある。
   *
   * 1 枚に絞らず候補として複数返す。先頭が読めなかったときに次を試せる。
   */
  function imagesFromBody(doc, limit) {
    const images = doc.querySelectorAll('img');
    const sized = []; // 寸法属性で十分大きいと分かっているもの
    const unsized = []; // 寸法が分からないもの
    let seen = 0;

    for (const img of images) {
      if (seen >= 40) break; // 深追いしても当たらない。ページ末尾は関連記事や広告
      const src = imageUrlOf(img);
      if (!src) continue;
      seen += 1;

      // ベクタは大半がロゴやアイコン
      if (/\.svg(\?|#|$)/i.test(src)) continue;

      const width = parseInt(img.getAttribute('width') || '0', 10);
      const height = parseInt(img.getAttribute('height') || '0', 10);
      // 寸法が分かっていて小さいなら、それは飾り
      if ((width && width < 120) || (height && height < 120)) continue;

      const hint =
        src + ' ' + (img.getAttribute('class') || '') + ' ' + (img.getAttribute('alt') || '');
      if (DECORATION_RE.test(hint)) continue;

      (width >= 200 && height >= 120 ? sized : unsized).push(src);
      if (sized.length >= limit) break;
    }
    return sized.concat(unsized).slice(0, limit);
  }

  /** ページが名乗っている RSS / Atom フィードの場所。 */
  function findFeedUrl(doc, baseUrl) {
    const links = doc.querySelectorAll('link[rel~="alternate"][href]');
    for (const link of links) {
      const type = (link.getAttribute('type') || '').toLowerCase();
      if (type.indexOf('rss') !== -1 || type.indexOf('atom') !== -1) {
        return absolutize(link.getAttribute('href'), baseUrl);
      }
    }
    return null;
  }

  /**
   * RSS / Atom から画像を拾う。
   * media:thumbnail のような名前空間つきの要素も拾うため、名前空間は問わない。
   */
  function imageFromFeedDoc(doc, baseUrl) {
    const attrOf = (tag, attr) => {
      const nodes = doc.getElementsByTagNameNS('*', tag);
      for (const node of nodes) {
        const value = node.getAttribute(attr);
        if (value) return value;
      }
      return null;
    };

    const media = attrOf('thumbnail', 'url') || attrOf('content', 'url');
    if (media) return absolutize(media, baseUrl);

    const enclosures = doc.getElementsByTagNameNS('*', 'enclosure');
    for (const node of enclosures) {
      const type = (node.getAttribute('type') || '').toLowerCase();
      const href = node.getAttribute('url') || node.getAttribute('href');
      if (href && type.indexOf('image/') === 0) return absolutize(href, baseUrl);
    }

    // RSS の <image><url>、Atom の <logo> / <icon>
    for (const tag of ['url', 'logo', 'icon']) {
      const nodes = doc.getElementsByTagNameNS('*', tag);
      for (const node of nodes) {
        const text = (node.textContent || '').trim();
        if (text && /^(https?:|\/)/i.test(text)) return absolutize(text, baseUrl);
      }
    }

    // 記事本文の HTML に埋まっている img
    for (const tag of ['encoded', 'description', 'summary', 'content']) {
      const nodes = doc.getElementsByTagNameNS('*', tag);
      for (const node of nodes) {
        const match = /<img[^>]+src=["']([^"']+)["']/i.exec(node.textContent || '');
        if (match) return absolutize(match[1], baseUrl);
      }
    }
    return null;
  }

  /** 画像以外の、ページが名乗っている文字情報。 */
  function parseMetadata(doc) {
    const title =
      metaContent(doc, [
        'meta[property="og:title"]',
        'meta[name="og:title"]',
        'meta[name="twitter:title"]',
      ]) ||
      (doc.querySelector('title') ? doc.querySelector('title').textContent.trim() : null);

    const description = metaContent(doc, [
      'meta[property="og:description"]',
      'meta[name="description"]',
    ]);

    const siteName = metaContent(doc, ['meta[property="og:site_name"]']);

    return {
      title: title || null,
      description: description || null,
      siteName: siteName || null,
    };
  }
  /* ------------------------------------------------------------------ *
   * 更新日時 (rawkuma 専用)
   *
   * カードを「新しい順」に並べるための鍵。話数の表示と同じく rawkuma.net
   * のページにしか付けない。よそのブックマークには null のままにして、
   * 並びも通信も v23 までと変わらないようにする。
   *
   * v24 では og:updated_time や JSON-LD からどのサイトの日時も拾って
   * いたが、それだと**別のフォルダまで並びが変わってしまう**という
   * 報告が出た。日時の在り処を広げるのではなく、対象を rawkuma に
   * 絞るのが正しかった。
   * ------------------------------------------------------------------ */

  /** これより古い・これより先の日付は、名乗っていても採らない。 */
  const DATE_MIN_MS = Date.UTC(2000, 0, 1);
  const DATE_FUTURE_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

  /**
   * 日付として使える文字列だけを ms に直す。
   *
   * Date.parse は緩すぎる。年だけの "1958" のような値も通してしまい、
   * 1958-01-01 という嘘の日付ができる (rawkuma の JSON-LD が実際にそう
   * 書いている)。年月日が揃っているもの (ISO 風) と、RFC 822 風
   * ("Thu, 11 Sep 2026 11:14:40 +0000") だけを受ける。
   *
   * 予定投稿で未来の日付を名乗るページがあるので、明後日より先も捨てる。
   * これを通すと、その 1 枚が永久に先頭へ居座る。
   */
  function parseDate(value) {
    if (value == null || typeof value === 'object') return null;
    const text = String(value).trim();
    if (!text) return null;
    const looksIso = /\d{4}-\d{2}-\d{2}/.test(text);
    const looksRfc = /\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/.test(text);
    if (!looksIso && !looksRfc) return null;

    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) return null;
    if (ms < DATE_MIN_MS) return null;
    if (ms > Date.now() + DATE_FUTURE_SLACK_MS) return null;
    return ms;
  }

  /**
   * 本文の <time datetime> のうち、いちばん新しいもの。
   *
   * 話数の並ばない rawkuma のページ (/latest-update/ や話数のページ) 用。
   * どれが「このページの日付」かは分からないので、いちばん新しいものを
   * 「最後に何かあった時刻」と見なす。未来の日付は parseDate が落とす。
   */
  function updatedFromTimeTags(doc) {
    const nodes = doc.querySelectorAll('time[datetime]');
    let best = null;
    let seen = 0;
    for (const node of nodes) {
      if (seen >= 300) break;
      seen += 1;
      const ms = parseDate(node.getAttribute('datetime'));
      if (ms && (!best || ms > best)) best = ms;
    }
    return best;
  }

  /**
   * 本文を取ってきて文字列にする。HTML でもフィードでも使う。
   *
   * @param {boolean} [reload] HTTP キャッシュを無視して取り直す。
   *   「サムネイル更新」からの取得で使う。保存済みの応答をそのまま
   *   読み返しては、更新を選んだ意味が無いため。
   * @param {boolean} [revalidate] 手元の写しを使う前に、必ずサーバーに
   *   確かめる。写しの鮮度を見ない force-cache では困るページ用。
   */
  async function fetchText(url, accept, typePattern, reload, revalidate) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        redirect: 'follow',
        cache: reload ? 'reload' : revalidate ? 'no-cache' : 'force-cache',
        signal: controller.signal,
        // 言語を名乗らない要求を弾くサイトがある。ブラウザとして自然な形にする。
        headers: { Accept: accept, 'Accept-Language': 'ja,en;q=0.8' },
      });
      if (!response.ok) {
        // 2xx でないことは、それ自体がカードに出す価値のある情報。
        // 呼び出し側で見分けられるよう、番号を持たせて投げる。
        const failure = new Error('HTTP ' + response.status);
        failure.httpStatus = response.status;
        throw failure;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType && typePattern && !typePattern.test(contentType)) {
        throw new Error('unexpected type: ' + contentType);
      }

      const buffer = await readCapped(response);
      return { text: decodeBody(buffer, contentType), finalUrl: response.url || url };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ *
   * チャプター一覧 (rawkuma 専用)
   *
   * 汎用ではない。作品ページに並ぶ話数へのリンクを拾い、新しい順に返す。
   * 「どこまで読んだか」はニュータブ側が CSS の :visited で出す。訪問済みか
   * どうかは JavaScript から読めない (履歴詐取の対策で塞がれている) ので、
   * ここでは URL を渡すところまでしかできない。
   * ------------------------------------------------------------------ */

  const CHAPTER_HOST_RE = /(^|\.)rawkuma\.net$/i;

  /**
   * rawkuma の移転先。ドメインだけでなく中身の作りがまるごと違うので、
   * 拾い方は別に持つ (「rawkuma.onl」の節)。
   */
  const ONL_HOST_RE = /(^|\.)rawkuma\.onl$/i;

  /**
   * この URL が rawkuma (.net / .onl) のものか。
   *
   * 話数の表示も更新日時も、このサイトにしか付けない。判定を 1 か所に
   * まとめておかないと、片方だけよそのサイトに漏れる。v24 では日時の側が
   * 全サイトに漏れていて、関係のないフォルダまで並びが変わってしまった。
   */
  function isChapterHost(url) {
    try {
      const host = new URL(url).hostname;
      return CHAPTER_HOST_RE.test(host) || ONL_HOST_RE.test(host);
    } catch (e) {
      return false;
    }
  }

  /** この URL が rawkuma.onl のものか。.net とは拾い方が違う。 */
  function isOnlHost(url) {
    try {
      return ONL_HOST_RE.test(new URL(url).hostname);
    } catch (e) {
      return false;
    }
  }

  /**
   * 末尾は chapter-<話数>.<記事ID>/ という形。話数には 169.5 のような
   * 小数もある (実データで 6 件あった)。記事 ID は毎回ちがうので、
   * 話数から URL を組み立てることはできない。必ずページから拾う。
   */
  const CHAPTER_PATH_RE = /\/chapter-(.+)\.(\d+)\/?$/i;

  /**
   * 話数を出すのは作品ページ (/manga/<作品>/) だけ。
   *
   * 一覧ページ (/latest-update/ など) にも話数へのリンクは並ぶが、それは
   * 別々の作品の寄せ集めで、1 つの作品の続きではない。実際テストで
   * 「RAWKUMA - latest」のカードに、無関係な作品の話数が 3 つ並んだ。
   */
  const MANGA_PATH_RE = /^\/manga\/[^/]+\/?$/i;

  function chaptersFromDoc(doc, baseUrl) {
    if (isOnlHost(baseUrl)) return onlChaptersFromDoc(doc, baseUrl);
    if (!isChapterHost(baseUrl)) return null;
    let here;
    try {
      here = new URL(baseUrl);
    } catch (e) {
      return null;
    }
    if (!MANGA_PATH_RE.test(here.pathname)) return null;

    const byUrl = new Map();
    const links = doc.querySelectorAll('a[href*="/chapter-"]');
    for (const link of links) {
      const url = absolutize(link.getAttribute('href'), baseUrl);
      if (!url || byUrl.has(url)) continue;

      let path;
      try {
        path = new URL(url).pathname;
      } catch (e) {
        continue;
      }
      const found = CHAPTER_PATH_RE.exec(path);
      if (!found) continue;

      const number = parseFloat(found[1]);
      if (!Number.isFinite(number)) continue;

      // 話数のリンクの中には、その話が上がった時刻の <time datetime> がある。
      // /latest-update/ の並びはこの時刻の降順そのものだった (実測)。
      const time = link.querySelector('time[datetime]');
      const at = time ? parseDate(time.getAttribute('datetime')) : null;

      const chapter = { url, number, label: 'Chapter-' + found[1] };
      if (at) chapter.at = at;
      byUrl.set(url, chapter);
    }

    if (byUrl.size === 0) return null;

    /*
     * 打ち切らず、拾えたものを全部返す。
     *
     * 数を絞っても取得は軽くならない。ページの HTML は 1 回読むだけで、
     * その中の話数リンクはどのみち全部見て回っているからである。v20 で
     * 3 つに絞っていたのは「カードが縦に伸びる」という見た目の都合だけで、
     * それはニュータブ側が 3 行の送り箱に収めることで片が付いた。増えるのは
     * 保存する JSON の大きさで、1 話あたり 100 バイト程度しかない
     * (500 話でも 50KB)。
     */
    return [...byUrl.values()].sort((a, b) => b.number - a.number);
  }

  /** 話数のうち、いちばん新しいものの時刻。分からなければ null。 */
  function chaptersUpdatedAt(chapters) {
    if (!Array.isArray(chapters)) return null;
    let best = null;
    for (const chapter of chapters) {
      if (chapter.at && (!best || chapter.at > best)) best = chapter.at;
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * rawkuma.onl
   *
   * rawkuma.net から移ってきた先。作品の URL (slug) も、話数の URL の形も、
   * 日時の在り処も違うので、.net の読み替えでは済まない。.net の拾い方には
   * 手を付けず、こちらは別に持つ。以下は rawkuma.onl を実際に取って
   * 見た結果 (2026-10-01):
   *
   * - 作品ページは /manga/<作品> で、末尾に / を付けると 404。
   * - 話数は /manga/<作品>/chapter-<話数>。記事 ID は付かない。
   *   話数には 7.2 のような小数もある。
   * - 作品ページの横の欄に、**よその作品の話数とカバー**が並んでいる。
   *   話数を拾うときは同じ作品のものに絞らないと混ざる。
   * - 話数の横の日時は「10 月前」のような相対表記だけで、時刻が取れない。
   *   絶対時刻は JSON-LD の Article.dateModified にある。トップの「最新」の
   *   並びと 10 作中 9 作が一致した。外れた 1 作は、作品ページ自体が
   *   Cloudflare に 21 時間前のまま残っていたもので (Age: 76976)、
   *   そちらにはまだ最新話が載っていなかった。
   * - og:image が 2 つあり、1 つめはサイト共通のロゴ。作品の絵は 2 つめ。
   * ------------------------------------------------------------------ */

  const ONL_MANGA_PATH_RE = /^\/manga\/([^/]+)\/?$/i;
  const ONL_CHAPTER_PATH_RE = /^\/manga\/([^/]+)\/chapter-(\d+(?:\.\d+)?)\/?$/i;

  /** 作品ページから、その作品の話数だけを新しい順に拾う。 */
  function onlChaptersFromDoc(doc, baseUrl) {
    let here;
    try {
      here = new URL(baseUrl);
    } catch (e) {
      return null;
    }
    const work = ONL_MANGA_PATH_RE.exec(here.pathname);
    if (!work) return null;
    const slug = work[1].toLowerCase();

    const byUrl = new Map();
    const links = doc.querySelectorAll('a[href*="/chapter-"]');
    for (const link of links) {
      const url = absolutize(link.getAttribute('href'), baseUrl);
      if (!url || byUrl.has(url)) continue;

      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        continue;
      }
      if (!ONL_HOST_RE.test(parsed.hostname)) continue;
      const found = ONL_CHAPTER_PATH_RE.exec(parsed.pathname);
      // 横の欄に並ぶ、よその作品の話数を落とす
      if (!found || found[1].toLowerCase() !== slug) continue;

      const number = parseFloat(found[2]);
      if (!Number.isFinite(number)) continue;
      byUrl.set(url, { url, number, label: 'Chapter-' + found[2] });
    }

    if (byUrl.size === 0) return null;
    return [...byUrl.values()].sort((a, b) => b.number - a.number);
  }

  /**
   * 作品の更新日時。JSON-LD の Article.dateModified。
   *
   * 本文の <time> は datetime を持たず、中身も「[最終更新日時: 2026-09-21
   * 22:09:57]」と時差の無い書き方なので使わない。JSON-LD のほうは同じ時刻を
   * +07:00 付きで名乗っている。
   */
  function onlUpdatedAt(doc) {
    const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const node of nodes) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch (e) {
        continue;
      }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (!item || item['@type'] !== 'Article') continue;
        const ms = parseDate(item.dateModified) || parseDate(item.datePublished);
        if (ms) return ms;
      }
    }
    return null;
  }

  /**
   * og:image のうち、作品の絵。
   *
   * 1 つめはどのページにも付くサイト共通のロゴ (しかも普通に読める) なので、
   * 先頭だけを見ると全部のカードが同じロゴになる。2 つ以上あるときは
   * 1 つめを捨てる。トップページのように 1 つしか無ければ、それを使う。
   */
  function onlOgImages(doc) {
    const values = [];
    for (const node of doc.querySelectorAll('meta[property="og:image"]')) {
      const value = (node.getAttribute('content') || '').trim();
      if (value) values.push(value);
    }
    return values.length > 1 ? values.slice(1) : values;
  }

  /** ページが名乗るフィードから画像を 1 枚拾う。無ければ null。 */
  async function feedImage(doc, baseUrl, reload) {
    const feedUrl = findFeedUrl(doc, baseUrl);
    if (!feedUrl) return null;
    try {
      const feed = await fetchText(
        feedUrl,
        'application/rss+xml,application/atom+xml,application/xml,text/xml',
        /xml/i,
        reload
      );
      const feedDoc = new DOMParser().parseFromString(feed.text, 'application/xml');
      if (feedDoc.querySelector('parsererror')) return null;
      return imageFromFeedDoc(feedDoc, feed.finalUrl);
    } catch (e) {
      return null; // フィードが無い/壊れていても、ページ本体の情報は返す
    }
  }

  /**
   * 使えそうな画像を、良い順に「全部」集める。
   *
   * 1 枚見つけた時点で打ち切ってはいけない。取り出せたことと、その URL が
   * 実際に読めることは別だからである。rawkuma.net は JSON-LD が 404 の
   * ファイルを指していて、本文の img には生きた画像があるのに「サムネイル
   * なし」になっていた。1 件しか返さないとカード側に次を試す道が無い。
   * 読めるかどうかはニュータブ側の <img> が決めるので、候補は残しておく。
   */
  async function fetchMetadata(url, reload) {
    /*
     * rawkuma.onl は HTML に Cache-Control: max-age=86400 を付けてくる。
     * force-cache は鮮度を見ずに手元の写しを返すので、1 日ごとの取り直しが
     * いつまでも同じ話数を読み続けかねない。ここだけ毎回サーバーに確かめる。
     * (If-Modified-Since には応えず常に 200 が返る。実測)
     */
    const onl = isOnlHost(url);
    const page = await fetchText(
      url,
      'text/html,application/xhtml+xml',
      /text\/html|application\/xhtml/i,
      reload,
      onl
    );
    const doc = new DOMParser().parseFromString(page.text, 'text/html');
    const meta = parseMetadata(doc);
    const onlPage = isOnlHost(page.finalUrl);

    const images = [];
    const seen = new Set();
    const add = (raw, source) => {
      const abs = absolutize(raw, page.finalUrl);
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      images.push({ url: abs, source });
    };

    // 1〜3: ページが自分で名乗っている見出し画像
    if (settings.sourceOg && onlPage) {
      for (const raw of onlOgImages(doc)) add(raw, 'og');
    } else if (settings.sourceOg) {
      add(
        metaContent(doc, [
          'meta[property="og:image:secure_url"]',
          'meta[property="og:image"]',
          'meta[name="og:image"]',
          'meta[name="twitter:image"]',
          'meta[name="twitter:image:src"]',
        ]),
        'og'
      );
    }
    if (settings.sourceImageSrc) {
      const link = doc.querySelector('link[rel="image_src"][href]');
      if (link) add(link.getAttribute('href'), 'image_src');
    }
    if (settings.sourceJsonLd) add(imageFromJsonLd(doc), 'json-ld');

    // 4: フィード。取得が 1 回増えるので、ページが何も名乗っていないときだけ見る
    if (settings.sourceFeed && images.length === 0) {
      add(await feedImage(doc, page.finalUrl, reload), 'feed');
    }

    // 5: 本文の img
    // rawkuma.onl の本文には、よその作品のカバーが横の欄に並ぶ。作品の絵が
    // もう分かっているなら見ない。先頭が一時的に読めなかったとき、よその
    // 作品の絵に落ちて、それが手元に保存されてしまうため。
    if (settings.sourceBodyImg && !(onlPage && images.length > 0)) {
      for (const raw of imagesFromBody(doc, 3)) add(raw, 'img');
    }

    meta.images = images;
    meta.image = images.length ? images[0].url : null;
    meta.imageSource = images.length ? images[0].source : null;

    /*
     * 話数は「新しい順」の日時の元にもなるので、並べ替えが入りのときは
     * showChapters が切りでも拾う。カードに出すかどうかは別の話。
     */
    const chapters =
      settings.showChapters || settings.sortByUpdated
        ? chaptersFromDoc(doc, page.finalUrl)
        : null;
    meta.chapters = settings.showChapters ? chapters : null;
    meta.chaptersAt = meta.chapters ? Date.now() : 0;

    /*
     * 更新日時。rawkuma のページにだけ付ける。
     *
     * 作品ページは話数の <time> から (/latest-update/ の並びはこの降順
     * そのものだった)。話数の並ばない rawkuma のページは、本文の <time> の
     * うちいちばん新しいもので代える。よそのサイトは null のまま。
     *
     * rawkuma.onl は話数に時刻が無いので、作品の JSON-LD から取る。
     */
    let updatedAt = null;
    let updatedSource = null;
    if (onlPage) {
      updatedAt = onlUpdatedAt(doc);
      updatedSource = updatedAt ? 'json-ld' : null;
    } else if (isChapterHost(page.finalUrl)) {
      updatedAt = chaptersUpdatedAt(chapters);
      updatedSource = updatedAt ? 'chapter' : null;
      if (!updatedAt) {
        updatedAt = updatedFromTimeTags(doc);
        if (updatedAt) updatedSource = 'time';
      }
    }

    meta.updatedAt = updatedAt || null;
    meta.updatedSource = updatedAt ? updatedSource : null;
    return meta;
  }

  /** 実際に取りにいく一回分。キャッシュの判断は呼び出し側でする。 */
  async function runFetch(url, reload) {
    await acquire();
    try {
      const data = await fetchMetadata(url, reload);
      await writeCache(url, data);
      return data;
    } catch (e) {
      // 失敗も短期キャッシュしたいところだが、一時的なオフライン等もあるので
      // エラーは返すだけにして、ニュータブ側でフォールバック表示させる。
      const result = {
        title: null,
        images: [],
        image: null,
        chapters: null,
        updatedAt: null,
        description: null,
        siteName: null,
        error: String(e),
      };
      if (typeof e.httpStatus === 'number') {
        result.httpStatus = e.httpStatus;
      } else if (e && e.name === 'AbortError') {
        result.httpStatus = 0;
        result.netKind = 'timeout';
      } else if (e instanceof TypeError) {
        // 名前が引けない、接続できない等
        result.httpStatus = 0;
        result.netKind = 'network';
      }
      return result;
    } finally {
      release();
    }
  }

  /**
   * @param {boolean} [force] 保存してある結果も HTTP キャッシュも無視して
   *   取り直す。「サムネイル更新」から来る。まとめ役 (inFlight) にも
   *   載せない。載せると、通常の取得が始めた古いやり方の結果を
   *   そのまま受け取ってしまうため。
   */
  async function getMetadata(url, force) {
    if (!isFetchable(url)) {
      return {
        title: null,
        images: [],
        image: null,
        chapters: null,
        updatedAt: null,
        description: null,
        siteName: null,
        skipped: true,
      };
    }

    if (force) return runFetch(url, true);

    const cached = await readCache(url);
    if (cached) return cached;

    if (inFlight.has(url)) return inFlight.get(url);

    const task = runFetch(url, false).finally(() => inFlight.delete(url));
    inFlight.set(url, task);
    return task;
  }

  /**
   * カードが実際に読めた URL を教えてもらい、次からはそれを先頭にする。
   *
   * 先頭の候補が死んでいると、開くたびにそこで 404 を踏んでから次へ移る。
   * 一度分かったことは覚えておく。
   */
  async function promoteImage(pageUrl, imageUrl) {
    const key = CACHE_PREFIX + pageUrl;
    const stored = await browser.storage.local.get(key);
    const entry = stored[key];
    if (!entry || !entry.data || !Array.isArray(entry.data.images)) return;

    const images = entry.data.images;
    const at = images.findIndex((c) => c.url === imageUrl);
    if (at <= 0) return; // 知らない URL か、すでに先頭

    const promoted = [images[at]].concat(images.filter((_, i) => i !== at));
    entry.data.images = promoted;
    entry.data.image = promoted[0].url;
    entry.data.imageSource = promoted[0].source;
    await browser.storage.local.set({ [key]: entry });
  }

  /**
   * 並べ替えに要ることを、まとめて返す。取りにはいかない。
   *
   * 返すのは 2 つ。**どれが並べ替えの対象か** (sortable) と、保存してある
   * 日時 (dates)。ニュータブは最初の一描きでこれを聞く。何百件あっても
   * storage.local.get 1 回で済み、網にも出ないので、開いた瞬間に
   * 「前に見たときの順」で並べられる。足りない日時は後から
   * follient:updated が埋める。
   *
   * sortable を先に渡すのが肝心。これが無いと、日時が届くまで「どのカードが
   * 動きうるか」が決まらず、届くたびに関係のないカードまで場所を変える。
   * rawkuma 以外はここで落ちるので、よそのフォルダは 1 件も取りにいかない。
   *
   * 日時の期限は見ない。少し古くても順番の当たりとしては使えるし、正しい値は
   * 取り直しが済んだ時点で上書きされる。
   */
  async function readUpdatedCache(urls) {
    const list = Array.isArray(urls) ? urls.filter(isFetchable) : [];
    const sortable = list.filter(isChapterHost);
    if (sortable.length === 0) return { sortable: [], dates: {} };

    const stored = await browser.storage.local.get(sortable.map((url) => CACHE_PREFIX + url));

    const dates = {};
    for (const url of sortable) {
      const entry = stored[CACHE_PREFIX + url];
      if (!isCurrentEntry(url, entry)) continue;
      const at = entry.data && entry.data.updatedAt;
      if (at) dates[url] = at;
    }
    return { sortable, dates };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message) return undefined;
    if (message.type === 'follient:metadata') {
      return getMetadata(message.url, message.force);
    }
    if (message.type === 'follient:updated') {
      // 対象外のページは、ここで断つ。ニュータブが取り違えて頼んできても
      // 網には出さない。
      if (!isChapterHost(message.url)) return Promise.resolve({ at: null });
      // 取得の道筋は普通の取得と同じ (キャッシュもまとめ役も共用する) ので、
      // あとでカードが開かれても二度取りにならない。
      return getMetadata(message.url).then((data) => ({
        at: (data && data.updatedAt) || null,
        source: (data && data.updatedSource) || null,
      }));
    }
    if (message.type === 'follient:updated-cached') {
      return readUpdatedCache(message.urls).catch(() => ({ sortable: [], dates: {} }));
    }
    if (message.type === 'follient:image-ok') {
      return promoteImage(message.url, message.image).catch(() => {});
    }
    if (message.type === 'follient:thumb-get') {
      return readThumb(message.url).then((image) => ({ image }));
    }
    if (message.type === 'follient:thumb-save') {
      // 保存の完了は待たせない。表示はもう済んでいる。
      saveThumb(message.url, message.image);
      return Promise.resolve({ accepted: true });
    }
    return undefined;
  });
})();
