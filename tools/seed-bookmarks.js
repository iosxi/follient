/**
 * 動作テスト専用のブックマーク投入スクリプト。
 * 製品には含めず、tools/make-test-build.js が作るテスト用コピーにだけ同梱する。
 * (bookmarks API 経由なので、プロファイルの内部形式に依存しない)
 */
(async () => {
  const FLAG = 'follient:seeded';
  const already = await browser.storage.local.get(FLAG);
  if (already[FLAG]) return;

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

  await insert('toolbar_____', TREE);
  await browser.storage.local.set({ [FLAG]: true });
  console.log('follient: test bookmarks seeded');
})();
