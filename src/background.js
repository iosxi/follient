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

  function parseMetadata(html, finalUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const title =
      metaContent(doc, [
        'meta[property="og:title"]',
        'meta[name="og:title"]',
        'meta[name="twitter:title"]',
      ]) ||
      (doc.querySelector('title') ? doc.querySelector('title').textContent.trim() : null);

    const rawImage = metaContent(doc, [
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[name="og:image"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
    ]);

    const description = metaContent(doc, [
      'meta[property="og:description"]',
      'meta[name="description"]',
    ]);

    const siteName = metaContent(doc, ['meta[property="og:site_name"]']);

    return {
      title: title || null,
      image: absolutize(rawImage, finalUrl),
      description: description || null,
      siteName: siteName || null,
    };
  }

  async function fetchMetadata(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        redirect: 'follow',
        cache: 'force-cache',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
        throw new Error('not html: ' + contentType);
      }

      const buffer = await readCapped(response);
      const html = decodeBody(buffer, contentType);
      return parseMetadata(html, response.url || url);
    } finally {
      clearTimeout(timer);
    }
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
        return { title: null, image: null, description: null, siteName: null, error: String(e) };
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
