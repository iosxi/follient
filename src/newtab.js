/**
 * follient - new tab
 *
 * ブックマークツリーを Pinterest 風のタイルで表示する。
 * - フォルダ: フォルダアイコンのカード。クリックでその中へ入る。
 * - ブックマーク: OGP のタイトルと画像のカード。
 *   画像とメタデータはカードがビューエリアに入った時点で取得する。
 */

const grid = document.getElementById('grid');
const emptyMessage = document.getElementById('empty');
const upLink = document.getElementById('up-link');
const breadcrumb = document.getElementById('breadcrumb');
const cardTemplate = document.getElementById('card-template');

/** grid-auto-rows / gap の実測値。masonry の span 計算に使う。 */
let rowUnit = 4;
let gapUnit = 18;

/** 描画世代。非同期処理が古い画面に書き込むのを防ぐ。 */
let generation = 0;

function readGridMetrics() {
  const styles = getComputedStyle(document.documentElement);
  rowUnit = parseFloat(styles.getPropertyValue('--row')) || 4;
  gapUnit = parseFloat(styles.getPropertyValue('--gap')) || 18;
}

/* ------------------------------------------------------------------ *
 * Masonry
 * ------------------------------------------------------------------ */

/**
 * カードの実高さから grid-row の span を決める。
 * row-gap は 0 で、縦の隙間はカードの margin-bottom が作っている。
 */
function layoutCard(card) {
  const height = card.getBoundingClientRect().height;
  if (!height) return;
  const span = Math.max(1, Math.ceil((height + gapUnit) / rowUnit));
  if (card.dataset.span !== String(span)) {
    card.dataset.span = String(span);
    card.style.gridRowEnd = 'span ' + span;
  }
}

/** 画像読み込みやウィンドウ幅の変化で高さが変わるたびに貼り直す。 */
const cardResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) layoutCard(entry.target);
});

/* ------------------------------------------------------------------ *
 * 見た目のためのユーティリティ
 * ------------------------------------------------------------------ */

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** ホスト名から安定した色を作り、画像が無いカードの面を塗る。 */
function applyFallbackColor(element, seed) {
  const hue = hashString(seed || 'follient') % 360;
  element.style.setProperty('--fb-a', 'hsl(' + hue + ' 62% 62%)');
  element.style.setProperty('--fb-b', 'hsl(' + ((hue + 32) % 360) + ' 58% 44%)');
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || parsed.protocol.replace(':', '');
  } catch (e) {
    return '';
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** フォルダのグリフ。innerHTML を避けて要素として組み立てる。 */
function createFolderIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute(
    'd',
    'M3 7.2c0-1.1.9-2 2-2h3.6c.6 0 1.2.28 1.6.76l.9 1.12c.38.48.95.76 1.56.76H19' +
      'c1.1 0 2 .9 2 2v7.4c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.2z'
  );
  body.setAttribute('fill', '#ffffff');
  body.setAttribute('fill-opacity', '0.95');

  const crease = document.createElementNS(SVG_NS, 'path');
  crease.setAttribute('d', 'M3 10.5h18');
  crease.setAttribute('stroke', 'rgba(0,0,0,0.14)');
  crease.setAttribute('stroke-width', '1.2');

  svg.appendChild(body);
  svg.appendChild(crease);
  return svg;
}

/* ------------------------------------------------------------------ *
 * メタデータの遅延取得
 * ------------------------------------------------------------------ */

function requestMetadata(url) {
  return browser.runtime
    .sendMessage({ type: 'follient:metadata', url })
    .catch(() => ({ title: null, image: null }));
}

/**
 * OGP 画像が無いページは、実際の見た目を撮った画像で代替する。
 * 撮影は相手サイトへの間隔を空けて順番に行われるため、すぐには返らない。
 * 出来上がりは follient:screenshot-ready で送られてくる。
 */
function requestScreenshot(url) {
  return browser.runtime
    .sendMessage({ type: 'follient:screenshot', url })
    .catch(() => ({ image: null }));
}

/** 撮影待ちのカードを URL から引けるようにしておく。 */
const cardsAwaitingShot = new Map();

function rememberForShot(url, card) {
  let list = cardsAwaitingShot.get(url);
  if (!list) {
    list = new Set();
    cardsAwaitingShot.set(url, list);
  }
  list.add(card);
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'follient:screenshot-ready') return undefined;
  const list = cardsAwaitingShot.get(message.url);
  if (!list) return undefined;
  for (const card of list) {
    if (card.isConnected) showImage(card, message.image);
  }
  cardsAwaitingShot.delete(message.url);
  return undefined;
});

/** ビューエリアに入ったカードだけ OGP を取りにいく。 */
const viewportObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      viewportObserver.unobserve(entry.target);
      hydrateCard(entry.target);
    }
  },
  { rootMargin: '200px 0px' }
);

async function hydrateCard(card) {
  const url = card.dataset.url;
  const myGeneration = generation;
  const data = await requestMetadata(url);
  if (myGeneration !== generation || !card.isConnected) return;

  card.classList.remove('is-pending');

  // ブックマークに利用者自身が付けた名前があればそれを尊重し、
  // 既定のまま (= URL そのもの等) の場合だけ OG タイトルで補う。
  if (data && data.title && card.dataset.useOgTitle === 'true') {
    card.querySelector('.title').textContent = data.title;
    card.title = data.title + '\n' + url;
  }

  if (data && data.image) {
    showImage(card, data.image);
    return;
  }

  // OGP 画像が無いので、ページの見た目を撮ったものに切り替える
  const shot = await requestScreenshot(url);
  if (myGeneration !== generation || !card.isConnected) return;

  if (shot && shot.image) {
    showImage(card, shot.image);
  } else {
    // 撮影待ち。出来上がったら screenshot-ready で差し替わる
    if (shot && shot.queued) rememberForShot(url, card);
    layoutCard(card);
  }
}

function showImage(card, src) {
  const img = card.querySelector('.thumb-img');
  const thumb = card.querySelector('.thumb');

  img.addEventListener(
    'load',
    () => {
      if (!card.isConnected) return;
      const ratio = img.naturalWidth / img.naturalHeight;
      if (ratio > 0 && Number.isFinite(ratio)) {
        // 極端に細長い画像でタイルが破綻しないように制限する
        thumb.style.aspectRatio = String(Math.min(2.4, Math.max(0.62, ratio)));
      }
      img.classList.add('loaded');
      layoutCard(card);
    },
    { once: true }
  );

  img.addEventListener(
    'error',
    () => {
      // 画像だけ落ちた場合はフォールバック面を残したままにする
      img.removeAttribute('src');
      layoutCard(card);
    },
    { once: true }
  );

  img.src = src;
}

/* ------------------------------------------------------------------ *
 * カード生成
 * ------------------------------------------------------------------ */

function createFolderCard(node, childCount) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  card.classList.add('is-folder');
  card.href = '#f/' + encodeURIComponent(node.id);

  const fallback = card.querySelector('.thumb-fallback');
  fallback.appendChild(createFolderIcon());
  applyFallbackColor(fallback, node.title || node.id);

  card.querySelector('.thumb-img').remove();

  const title = node.title || '(名称未設定のフォルダ)';
  card.querySelector('.title').textContent = title;
  card.querySelector('.host').textContent =
    childCount === 0 ? '空のフォルダ' : childCount + ' 件';
  card.title = title;

  return card;
}

function createBookmarkCard(node) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  card.classList.add('is-pending');
  card.href = node.url;
  card.dataset.url = node.url;

  const host = hostOf(node.url);
  const fallback = card.querySelector('.thumb-fallback');
  applyFallbackColor(fallback, host || node.url);
  fallback.textContent = (host || '?').charAt(0).toUpperCase();

  // ブックマーク名が URL そのままなら OG タイトルで置き換える
  const hasOwnTitle = Boolean(node.title) && node.title !== node.url;
  card.dataset.useOgTitle = hasOwnTitle ? 'false' : 'true';

  card.querySelector('.title').textContent = hasOwnTitle ? node.title : host || node.url;
  card.querySelector('.host').textContent = host;
  card.title = (node.title || node.url) + '\n' + node.url;

  return card;
}

/* ------------------------------------------------------------------ *
 * ナビゲーション
 * ------------------------------------------------------------------ */

function folderIdFromHash() {
  const match = /^#f\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

/** ルートまで parentId を辿って、パンくず用の配列を作る。 */
async function buildPath(folderId) {
  const path = [];
  let id = folderId;
  const guard = new Set();

  while (id && !guard.has(id)) {
    guard.add(id);
    let node;
    try {
      node = (await browser.bookmarks.get(id))[0];
    } catch (e) {
      break;
    }
    if (!node) break;
    path.unshift(node);
    id = node.parentId;
  }
  return path;
}

function renderNavigation(path, rootId) {
  breadcrumb.textContent = '';

  const rootLink = document.createElement('a');
  rootLink.href = '#';
  rootLink.textContent = 'ブックマーク';
  breadcrumb.appendChild(rootLink);

  // path の先頭はルート自身なので落とす
  const visible = path.filter((node) => node.id !== rootId);

  visible.forEach((node, index) => {
    const separator = document.createElement('span');
    separator.className = 'sep';
    separator.textContent = '/';
    breadcrumb.appendChild(separator);

    const label = node.title || '(名称未設定)';
    if (index === visible.length - 1) {
      const current = document.createElement('span');
      current.className = 'current';
      current.textContent = label;
      breadcrumb.appendChild(current);
    } else {
      const link = document.createElement('a');
      link.href = '#f/' + encodeURIComponent(node.id);
      link.textContent = label;
      breadcrumb.appendChild(link);
    }
  });

  // 仮想フォルダ (= ルート以外) にいる時だけ「上層に戻る」を出す
  if (visible.length === 0) {
    upLink.hidden = true;
  } else {
    const parent = visible.length >= 2 ? visible[visible.length - 2] : null;
    upLink.href = parent ? '#f/' + encodeURIComponent(parent.id) : '#';
    upLink.hidden = false;
  }
}

/* ------------------------------------------------------------------ *
 * 描画
 * ------------------------------------------------------------------ */

async function render() {
  generation += 1;
  const myGeneration = generation;

  viewportObserver.disconnect();
  cardResizeObserver.disconnect();
  cardsAwaitingShot.clear();
  grid.textContent = '';
  emptyMessage.hidden = true;

  const treeRoot = (await browser.bookmarks.getTree())[0];
  const rootId = treeRoot.id;
  const folderId = folderIdFromHash() || rootId;

  let children;
  try {
    children = await browser.bookmarks.getChildren(folderId);
  } catch (e) {
    // 消えたフォルダのハッシュが残っている場合はルートへ戻す
    location.hash = '';
    return;
  }
  if (myGeneration !== generation) return;

  const path = await buildPath(folderId);
  if (myGeneration !== generation) return;
  renderNavigation(path, rootId);

  const leaf = path.length ? path[path.length - 1] : null;
  document.title = leaf && leaf.id !== rootId && leaf.title ? leaf.title : 'follient';

  const visibleNodes = children.filter((node) => {
    if (node.type === 'separator') return false;
    return node.url ? /^(https?|ftp|file):/i.test(node.url) : true;
  });

  if (visibleNodes.length === 0) {
    emptyMessage.hidden = false;
    return;
  }

  // フォルダの件数表示のためだけに子を数える
  const counts = await Promise.all(
    visibleNodes.map((node) =>
      node.url
        ? Promise.resolve(0)
        : browser.bookmarks.getChildren(node.id).then(
            (kids) => kids.length,
            () => 0
          )
    )
  );
  if (myGeneration !== generation) return;

  const fragment = document.createDocumentFragment();
  const cards = [];

  visibleNodes.forEach((node, index) => {
    const card = node.url ? createBookmarkCard(node) : createFolderCard(node, counts[index]);
    card.style.animationDelay = Math.min(index, 24) * 18 + 'ms';
    fragment.appendChild(card);
    cards.push(card);
  });

  grid.appendChild(fragment);

  for (const card of cards) {
    layoutCard(card);
    cardResizeObserver.observe(card);
    if (card.dataset.url) viewportObserver.observe(card);
  }
}

/* ------------------------------------------------------------------ *
 * 起動
 * ------------------------------------------------------------------ */

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0 });
});

// ブックマークが変更されたら表示を追随させる
for (const eventName of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) {
  const event = browser.bookmarks[eventName];
  if (event) event.addListener(() => render());
}

readGridMetrics();
render();
