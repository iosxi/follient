/**
 * AMO で署名済みの XPI を取ってくる。
 *   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node tools/fetch-signed.js [version]
 *   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node tools/fetch-signed.js --list
 *
 * 署名そのものは tools/sign.js で行うが、アップロードが済んだ後に
 * ダウンロードだけ失敗することがある (端末が閉じた、通信が切れた等)。
 * その場合 sign.js を再実行しても「Version X already exists」で弾かれる。
 * バージョンを上げる必要は無く、すでに署名されたものを取得すればよい。
 *
 * version を省略すると manifest.json のものを使う。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;

if (!issuer || !secret) {
  console.error(
    [
      'AMO_JWT_ISSUER と AMO_JWT_SECRET を環境変数に設定してください。',
      '',
      '  PowerShell:',
      '    $env:AMO_JWT_ISSUER = "user:12345:67"',
      '    $env:AMO_JWT_SECRET = "..."',
      '    node tools/fetch-signed.js',
    ].join('\n')
  );
  process.exit(1);
}

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const addonId = manifest.browser_specific_settings.gecko.id;

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const wantedVersion = args.find((a) => !a.startsWith('--')) || manifest.version;

const API = 'https://addons.mozilla.org/api/v5';

/** AMO の API は短命な JWT で認証する。トークンは決して表示しない。 */
function makeToken() {
  const b64 = (input) =>
    Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = b64(
    JSON.stringify({
      iss: issuer,
      jti: crypto.randomBytes(16).toString('hex'),
      iat: issuedAt,
      exp: issuedAt + 300,
    })
  );
  const signature = b64(
    crypto.createHmac('sha256', secret).update(header + '.' + payload).digest()
  );
  return header + '.' + payload + '.' + signature;
}

async function get(url) {
  const response = await fetch(url, { headers: { Authorization: 'JWT ' + makeToken() } });
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * 版の一覧を取る。unlisted は filter を付けないと出てこない。
 * AMO の API は過去に経路が変わっているので、候補を順に試す。
 */
async function listVersions() {
  const id = encodeURIComponent(addonId);
  const candidates = [
    API + '/addons/addon/' + id + '/versions/?filter=all_with_unlisted',
    API + '/addons/addon/' + id + '/versions/',
    API + '/addons/' + id + '/versions/',
  ];

  for (const url of candidates) {
    const result = await get(url);
    console.log('  ' + (result.ok ? 'OK  ' : result.status + ' ') + url.replace(API, ''));
    if (result.ok && result.body && Array.isArray(result.body.results)) {
      let versions = result.body.results;
      let next = result.body.next;
      while (next) {
        const page = await get(next);
        if (!page.ok || !page.body || !Array.isArray(page.body.results)) break;
        versions = versions.concat(page.body.results);
        next = page.body.next;
      }
      return versions;
    }
  }
  return null;
}

/** 版オブジェクトからダウンロードできるファイルを取り出す。 */
function fileOf(version) {
  if (version.file) return version.file;
  if (Array.isArray(version.files) && version.files.length > 0) return version.files[0];
  return null;
}

function describe(version) {
  const file = fileOf(version);
  const status = file ? file.status || '(status不明)' : '(fileなし)';
  const signed = file && file.signed !== undefined ? ' signed=' + file.signed : '';
  return '  ' + String(version.version).padEnd(10) + ' ' + status + signed;
}

async function main() {
  console.log('アドオン: ' + addonId);
  console.log('版の一覧を問い合わせています…');

  const versions = await listVersions();

  if (!versions) {
    console.error('');
    console.error('版の一覧を取得できませんでした。');
    console.error('AMO は未公開 (unlisted) のアドオンに対し、認証が通らない場合も');
    console.error('401 ではなく 404 を返します。次を確認してください。');
    console.error('  - AMO_JWT_ISSUER / AMO_JWT_SECRET が現在有効なものか');
    console.error('  - 発行元のアカウントがこのアドオンの所有者か');
    console.error('  - manifest の id がアップロード時と同じか: ' + addonId);
    process.exit(1);
  }

  console.log('');
  console.log('AMO にある版:');
  for (const version of versions) console.log(describe(version));
  console.log('');

  if (listOnly) return;

  const target = versions.find((v) => String(v.version) === String(wantedVersion));
  if (!target) {
    console.error(wantedVersion + ' は AMO にありません。先に tools/sign.js を実行してください。');
    process.exit(1);
  }

  const file = fileOf(target);
  const downloadUrl = file && (file.url || file.download_url);
  if (!downloadUrl) {
    console.error(wantedVersion + ' にダウンロードできるファイルがありません。');
    console.error('署名処理がまだ終わっていない可能性があります。数分おいて再実行してください。');
    process.exit(1);
  }

  console.log('取得します: ' + wantedVersion);
  const download = await fetch(downloadUrl, {
    headers: { Authorization: 'JWT ' + makeToken() },
  });
  if (!download.ok) {
    console.error('ダウンロードに失敗しました (HTTP ' + download.status + ')');
    process.exit(1);
  }

  const name =
    path.basename(new URL(downloadUrl).pathname) || 'follient-' + wantedVersion + '-signed.xpi';
  const outFile = path.join(distDir, name);
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(await download.arrayBuffer()));

  console.log(
    '保存しました: ' + path.relative(root, outFile) + ' (' + fs.statSync(outFile).size + ' bytes)'
  );
}

main().catch((e) => {
  console.error('失敗しました:', e && e.message ? e.message : e);
  process.exit(1);
});
