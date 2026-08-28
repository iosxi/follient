/**
 * AMO で署名済みの XPI を取ってくる。
 *   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node tools/fetch-signed.js [version]
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
const version = process.argv[2] || manifest.version;

/** AMO の API は短命な JWT で認証する。 */
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

function authHeaders() {
  return { Authorization: 'JWT ' + makeToken() };
}

async function main() {
  const base = 'https://addons.mozilla.org/api/v5/addons';
  const url =
    base + '/' + encodeURIComponent(addonId) + '/versions/' + encodeURIComponent(version) + '/';

  console.log('問い合わせ中: ' + addonId + ' ' + version);

  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.text();
    console.error('AMO への問い合わせに失敗しました (HTTP ' + response.status + ')');
    console.error(body.slice(0, 800));
    if (response.status === 404) {
      // AMO は未公開 (unlisted) のアドオンに対し、認証が通らない場合も
      // 401 ではなく 404 を返す。どちらなのかは応答から区別できない。
      console.error(
        [
          '',
          '次のいずれかです。',
          '  - 資格情報が違う、または失効している (AMO は未公開アドオンに 404 を返す)',
          '  - そのバージョンがまだ AMO に無い → 先に tools/sign.js を実行する',
        ].join('\n')
      );
    }
    process.exit(1);
  }

  const data = await response.json();

  // 署名 API は files[]、通常の版 API は file を返す。両方を受ける。
  const files = Array.isArray(data.files) ? data.files : data.file ? [data.file] : [];
  if (files.length === 0) {
    console.error('このバージョンにファイルがありません。');
    console.error(JSON.stringify(data).slice(0, 800));
    process.exit(1);
  }

  const file = files[0];
  const signed = file.signed === true || file.status === 'public' || file.status === 'unreviewed';
  const downloadUrl = file.download_url || file.url;

  console.log('  署名: ' + (file.signed === undefined ? '(不明) status=' + file.status : file.signed));
  if (!downloadUrl) {
    console.error('ダウンロード URL がありません。まだ署名処理が終わっていない可能性があります。');
    process.exit(1);
  }
  if (!signed) {
    console.error('まだ署名されていません。数分おいて再実行してください。');
    process.exit(1);
  }

  const download = await fetch(downloadUrl, { headers: authHeaders() });
  if (!download.ok) {
    console.error('ダウンロードに失敗しました (HTTP ' + download.status + ')');
    process.exit(1);
  }

  const name = path.basename(new URL(downloadUrl).pathname) || 'follient-' + version + '-signed.xpi';
  const outFile = path.join(distDir, name);
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(await download.arrayBuffer()));

  const size = fs.statSync(outFile).size;
  console.log('保存しました: ' + path.relative(root, outFile) + ' (' + size + ' bytes)');
}

main().catch((e) => {
  console.error('失敗しました:', e && e.message ? e.message : e);
  process.exit(1);
});
