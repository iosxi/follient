/**
 * 配布用の XPI を作る (依存なし)。
 *   node tools/build-xpi.js
 *
 * XPI は拡張子が違うだけの ZIP。manifest.json をアーカイブの直下に置く。
 * 実行に必要なファイルだけを入れ、tools/ や設計書などは含めない。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist');

/** アーカイブに入れるもの。ここに無いものは配布物に含まれない。 */
const INCLUDE = ['manifest.json', 'src'];

function collect(relPath, acc) {
  const abs = path.join(root, relPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      collect(path.posix.join(relPath, name), acc);
    }
  } else {
    acc.push(relPath);
  }
  return acc;
}

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** 再現可能なビルドにするため、更新日時は固定値にする。 */
const DOS_TIME = 0x6000; // 12:00:00
const DOS_DATE = 0x5821; // 2024-01-01

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    // 圧縮して大きくなるなら無圧縮で入れる
    const useStore = compressed.length >= data.length;
    const body = useStore ? data : compressed;
    const method = useStore ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

const names = INCLUDE.reduce((acc, entry) => collect(entry, acc), []);
const files = names.map((name) => ({
  name,
  data: fs.readFileSync(path.join(root, name)),
}));

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const outFile = path.join(outDir, 'follient-' + manifest.version + '.xpi');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, buildZip(files));

console.log('built ' + path.relative(root, outFile));
for (const { name, data } of files) {
  console.log('  ' + name + ' (' + data.length + ' bytes)');
}
