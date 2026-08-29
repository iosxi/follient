/**
 * follient - background
 *
 * ニュータブ側から依頼された URL の OGP メタデータ (og:title / og:image) を
 * 取得して返す。ページ本体の取得はクロスオリジンになるため、
 * <all_urls> 権限を持つこのバックグラウンドスクリプトが担当する。
 */

/* IIFE: 背景ページは複数スクリプトを同じグローバルスコープで読む。
   名前の衝突で他のスクリプトが丸ごと死ぬのを防ぐため閉じ込める。 */
(() => {
  const CACHE_PREFIX = 'og:';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
  const FETCH_TIMEOUT_MS = 8000;
  const MAX_BYTES = 512 * 1024; // <head> が読めれば十分なので先頭のみ
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
    if (Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.data;
  }

  async function writeCache(url, data) {
    try {
      await browser.storage.local.set({
        [CACHE_PREFIX + url]: { at: Date.now(), data },
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

  /** 本文中の大きめの画像。大きさが属性で分かるものだけを見る。 */
  function imageFromBody(doc) {
    const images = doc.querySelectorAll('img[src]');
    for (const img of images) {
      const width = parseInt(img.getAttribute('width') || '0', 10);
      const height = parseInt(img.getAttribute('height') || '0', 10);
      if (width >= 200 && height >= 120) return img.getAttribute('src');
    }
    return null;
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

  function parseMetadata(doc, finalUrl) {
    const title =
      metaContent(doc, [
        'meta[property="og:title"]',
        'meta[name="og:title"]',
        'meta[name="twitter:title"]',
      ]) ||
      (doc.querySelector('title') ? doc.querySelector('title').textContent.trim() : null);

    // OGP を第一に、無ければ順に代わりを探す。撮影はここで見つからなかった
    // ときの最後の手段なので、ここで拾えるほど安全で安上がりになる。
    let source = 'og';
    let rawImage = settings.sourceOg
      ? metaContent(doc, [
          'meta[property="og:image:secure_url"]',
          'meta[property="og:image"]',
          'meta[name="og:image"]',
          'meta[name="twitter:image"]',
          'meta[name="twitter:image:src"]',
        ])
      : null;

    if (!rawImage && settings.sourceImageSrc) {
      const link = doc.querySelector('link[rel="image_src"][href]');
      if (link) {
        rawImage = link.getAttribute('href');
        source = 'image_src';
      }
    }
    if (!rawImage && settings.sourceJsonLd) {
      rawImage = imageFromJsonLd(doc);
      if (rawImage) source = 'json-ld';
    }
    if (!rawImage && settings.sourceBodyImg) {
      rawImage = imageFromBody(doc);
      if (rawImage) source = 'img';
    }
    if (!rawImage) source = null;

    const description = metaContent(doc, [
      'meta[property="og:description"]',
      'meta[name="description"]',
    ]);

    const siteName = metaContent(doc, ['meta[property="og:site_name"]']);

    return {
      title: title || null,
      image: absolutize(rawImage, finalUrl),
      imageSource: source,
      description: description || null,
      siteName: siteName || null,
    };
  }

  /** 本文を取ってきて文字列にする。HTML でもフィードでも使う。 */
  async function fetchText(url, accept, typePattern) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        redirect: 'follow',
        cache: 'force-cache',
        signal: controller.signal,
        headers: { Accept: accept },
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

  async function fetchMetadata(url) {
    const page = await fetchText(
      url,
      'text/html,application/xhtml+xml',
      /text\/html|application\/xhtml/i
    );
    const doc = new DOMParser().parseFromString(page.text, 'text/html');
    const meta = parseMetadata(doc, page.finalUrl);
    if (meta.image) return meta;

    // ページ自体に画像が無くても、フィードなら持っていることが多い。
    // 撮影に回すより、こちらのほうが安全で速い。
    if (!settings.sourceFeed) return meta;

    const feedUrl = findFeedUrl(doc, page.finalUrl);
    if (!feedUrl) return meta;

    try {
      const feed = await fetchText(
        feedUrl,
        'application/rss+xml,application/atom+xml,application/xml,text/xml',
        /xml/i
      );
      const feedDoc = new DOMParser().parseFromString(feed.text, 'application/xml');
      if (!feedDoc.querySelector('parsererror')) {
        const image = imageFromFeedDoc(feedDoc, feed.finalUrl);
        if (image) {
          meta.image = image;
          meta.imageSource = 'feed';
        }
      }
    } catch (e) {
      // フィードが無い/壊れていても、ページ本体の情報は返す
    }
    return meta;
  }

  async function getMetadata(url) {
    if (!isFetchable(url)) {
      return { title: null, image: null, description: null, siteName: null, skipped: true };
    }

    const cached = await readCache(url);
    if (cached) return cached;

    if (inFlight.has(url)) return inFlight.get(url);

    const task = (async () => {
      await acquire();
      try {
        const data = await fetchMetadata(url);
        await writeCache(url, data);
        return data;
      } catch (e) {
        // 失敗も短期キャッシュしたいところだが、一時的なオフライン等もあるので
        // エラーは返すだけにして、ニュータブ側でフォールバック表示させる。
        const result = {
          title: null,
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
        inFlight.delete(url);
      }
    })();

    inFlight.set(url, task);
    return task;
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'follient:metadata') return undefined;
    return getMetadata(message.url);
  });
})();
