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
   */
  const EXTRACT_VERSION = 4;

  /** 画像が取れた結果の寿命。 */
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * 画像が取れなかった結果の寿命。短くしておく。
   * こちらは「今の実装では見つけられなかった」という記録でしかなく、
   * 実装が良くなれば結果が変わりうるため。
   */
  const CACHE_TTL_EMPTY_MS = 24 * 60 * 60 * 1000;
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
    if (entry.v !== EXTRACT_VERSION) return null;
    const ttl = entry.data && entry.data.image ? CACHE_TTL_MS : CACHE_TTL_EMPTY_MS;
    if (Date.now() - entry.at > ttl) return null;
    return entry.data;
  }

  async function writeCache(url, data) {
    try {
      await browser.storage.local.set({
        [CACHE_PREFIX + url]: { at: Date.now(), v: EXTRACT_VERSION, data },
      });
    } catch (e) {
      // 容量超過などは致命的ではないので握りつぶす
      console.warn('follient: cache write failed', e);
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
  /**
   * 本文を取ってきて文字列にする。HTML でもフィードでも使う。
   *
   * @param {boolean} [reload] HTTP キャッシュを無視して取り直す。
   *   「サムネイル更新」からの取得で使う。保存済みの応答をそのまま
   *   読み返しては、更新を選んだ意味が無いため。
   */
  async function fetchText(url, accept, typePattern, reload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        redirect: 'follow',
        cache: reload ? 'reload' : 'force-cache',
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
    const page = await fetchText(
      url,
      'text/html,application/xhtml+xml',
      /text\/html|application\/xhtml/i,
      reload
    );
    const doc = new DOMParser().parseFromString(page.text, 'text/html');
    const meta = parseMetadata(doc);

    const images = [];
    const seen = new Set();
    const add = (raw, source) => {
      const abs = absolutize(raw, page.finalUrl);
      if (!abs || seen.has(abs)) return;
      seen.add(abs);
      images.push({ url: abs, source });
    };

    // 1〜3: ページが自分で名乗っている見出し画像
    if (settings.sourceOg) {
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
    if (settings.sourceBodyImg) {
      for (const raw of imagesFromBody(doc, 3)) add(raw, 'img');
    }

    meta.images = images;
    meta.image = images.length ? images[0].url : null;
    meta.imageSource = images.length ? images[0].source : null;
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

  browser.runtime.onMessage.addListener((message) => {
    if (!message) return undefined;
    if (message.type === 'follient:metadata') {
      return getMetadata(message.url, message.force);
    }
    if (message.type === 'follient:image-ok') {
      return promoteImage(message.url, message.image).catch(() => {});
    }
    return undefined;
  });
})();
