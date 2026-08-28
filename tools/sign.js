/**
 * AMO で署名して、配布できる XPI を作る。
 *   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node tools/sign.js
 *
 * 資格情報は環境変数からのみ読む (コマンドライン引数に書くと
 * シェルの履歴やプロセス一覧に残るため)。
 *
 * --channel unlisted (既定) は AMO に公開せず、署名済み XPI だけを受け取る。
 * 署名された XPI は通常版の Firefox にそのままインストールできる。
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
      '    node tools/sign.js',
      '',
      '  bash:',
      '    export AMO_JWT_ISSUER="user:12345:67"',
      '    export AMO_JWT_SECRET="..."',
      '    node tools/sign.js',
      '',
      'キーの発行: https://addons.mozilla.org/developers/addon/api/key/',
    ].join('\n')
  );
  process.exit(1);
}

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const channel = process.argv.includes('--listed') ? 'listed' : 'unlisted';

/**
 * 実行に必要なものだけをステージングしてから署名する。
 * --ignore-files でふるい落とすより確実で、日本語ファイル名を
 * コマンドライン引数に載せずに済む。
 */
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'follient-sign-'));
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(stage, 'manifest.json'));
fs.cpSync(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true });

/**
 * npx は Windows では npx.cmd で、Node 20 以降は .cmd を shell 無しで
 * spawn できない (EINVAL)。shell を挟むと引用符やコードページの問題が出るので、
 * npm 同梱の npx-cli.js を node で直接叩く。
 */
function npxCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const cli = npxCli();
if (!cli) {
  console.error('npx-cli.js が見つかりませんでした。npm の導入を確認してください。');
  process.exit(1);
}

console.log('署名します: ' + manifest.name + ' ' + manifest.version);
console.log('  id      = ' + manifest.browser_specific_settings.gecko.id);
console.log('  channel = ' + channel);
console.log('  staged  = ' + stage);
console.log('');

const result = spawnSync(
  process.execPath,
  [
    cli,
    '--yes',
    'web-ext@latest',
    'sign',
    '--source-dir', stage,
    '--artifacts-dir', distDir,
    '--channel', channel,
    '--api-key', issuer,
    '--api-secret', secret,
  ],
  { stdio: 'inherit', cwd: root }
);

fs.rmSync(stage, { recursive: true, force: true });

if (result.error) {
  console.error('\n署名プロセスを起動できませんでした: ' + result.error.code);
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('\n署名に失敗しました (web-ext の終了コード ' + result.status + ')。');
  console.error('上に出ている web-ext のメッセージを確認してください。');
  process.exit(result.status === null ? 1 : result.status);
}

console.log('\n署名済み XPI は dist/ にあります。');
