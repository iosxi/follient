/**
 * 動作テスト専用のブックマーク投入スクリプト。
 * 製品には含めず、tools/make-test-build.js が作るテスト用コピーにだけ同梱する。
 * (bookmarks API 経由なので、プロファイルの内部形式に依存しない)
 */
(async () => {
  const FLAG = 'follient:seeded';
  const already = await browser.storage.local.get(FLAG);
  if (already[FLAG]) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 新規プロファイルの初回起動では、Firefox 自身による既定ブックマークの
   * 取り込みが背景ページより後に走り、先に入れたものを消してしまう。
   * 取り込みが終わった (= メニューに既定の項目が現れた) のを見てから入れる。
   */
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const menu = await browser.bookmarks.getChildren('menu________');
      if (menu.length > 0) break;
    } catch (e) {
      /* ルートがまだ無い。待つ。 */
    }
    await sleep(500);
  }
  await sleep(3000); // 取り込みの後片付けが終わるまで少し置く

  const TREE = [
    {
      title: '開発',
      children: [
        { title: 'GitHub', url: 'https://github.com/' },
        { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/ja/' },
        { title: 'Rust', url: 'https://www.rust-lang.org/ja' },
        { title: 'Node.js', url: 'https://nodejs.org/ja' },
        { title: 'Deno', url: 'https://deno.com/' },
        { title: 'Python', url: 'https://www.python.org/' },
        {
          title: '言語リファレンス',
          children: [
            { title: 'TypeScript', url: 'https://www.typescriptlang.org/' },
            { title: 'Go', url: 'https://go.dev/' },
            { title: 'Kotlin', url: 'https://kotlinlang.org/' },
          ],
        },
        { title: '空のフォルダ', children: [] },
      ],
    },
    {
      title: 'ニュース',
      children: [
        { title: 'BBC News', url: 'https://www.bbc.com/news' },
        { title: 'The Guardian', url: 'https://www.theguardian.com/international' },
        { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
      ],
    },
    {
      // 実際に「タブが増えてキャプチャも採れない」と報告のあった URL。
      // OGP が無いページから、フィード等で画像を拾えるかを見るためのもの。
      title: 'RAWKUMA',
      children: [
        { title: 'RAWKUMA - latest', url: 'https://rawkuma.net/latest-update/?the_page=1' },
        { title: 'RAWKUMA - bouken', url: 'https://rawkuma.net/manga/bouken-shinai-watashi-no-isekai-manual/' },
        { title: 'RAWKUMA - isekai', url: 'https://rawkuma.net/manga/isekai-de-cheat-skill-wo-te-ni-shita-ore-wa-genjitsu-sekai-wo-mo-musou-suru-girls-side-kareinaru-otome-tachi-no-bouken-wa-sekai-wo-kaeta/' },
      ],
    },
    {
      // OGP 画像を持たないページばかりのフォルダ。スクリーンショット代替と、
      // 同一ホストが並んだときの間隔制御を確かめるためのもの。
      title: 'OGPなし',
      children: [
        { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
        { title: 'HN - newest', url: 'https://news.ycombinator.com/newest' },
        { title: 'HN - ask', url: 'https://news.ycombinator.com/ask' },
        { title: 'HN - show', url: 'https://news.ycombinator.com/show' },
        { title: 'arXiv', url: 'https://arxiv.org/' },
        { title: 'Example', url: 'https://example.com/' },
      ],
    },
    { title: 'Mozilla', url: 'https://www.mozilla.org/ja/' },
    { title: 'Firefox', url: 'https://www.mozilla.org/ja/firefox/new/' },
    { title: 'Wikipedia', url: 'https://ja.wikipedia.org/' },
    { title: 'NASA', url: 'https://www.nasa.gov/' },
    { title: 'Unsplash', url: 'https://unsplash.com/' },
    { title: 'Pinterest', url: 'https://www.pinterest.com/' },
    { title: 'Nature', url: 'https://www.nature.com/' },
    { title: 'arXiv', url: 'https://arxiv.org/' },
    { title: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/' },
    { title: 'CSS-Tricks', url: 'https://css-tricks.com/' },
    { title: 'The Verge', url: 'https://www.theverge.com/' },
    { title: 'Ars Technica', url: 'https://arstechnica.com/' },
  ];

  async function insert(parentId, nodes) {
    for (const node of nodes) {
      if (node.url) {
        await browser.bookmarks.create({ parentId, title: node.title, url: node.url });
      } else {
        const created = await browser.bookmarks.create({ parentId, title: node.title });
        await insert(created.id, node.children);
      }
    }
  }

  try {
    await insert('toolbar_____', TREE);
    await browser.storage.local.set({ [FLAG]: true });
    const added = await browser.bookmarks.getChildren('toolbar_____');
    console.log('follient: test bookmarks seeded (' + added.length + ' items)');
  } catch (e) {
    console.error('follient: seeding failed', e);
  }
})();
