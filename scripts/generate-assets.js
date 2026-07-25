const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const outputDir = path.join(__dirname, '..', 'public', 'assets');
fs.mkdirSync(outputDir, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(width, height, pixels) {
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.concat([Buffer.from([0]), pixels.subarray(y * width * 4, (y + 1) * width * 4)]));
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([header, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const palettes = [
  ['#d7f6e8', '#2e8b70', '#f0b18d'],
  ['#e4efff', '#4669ad', '#dca67e'],
  ['#fff0da', '#cc7653', '#e6ad7f'],
  ['#ece4ff', '#7252a7', '#bc8d70'],
  ['#e6f3f5', '#357b87', '#d69c7d'],
  ['#fff1f2', '#b24f6a', '#e0aa8e'],
  ['#e8f4ea', '#31745a', '#d8a07f'],
  ['#f5eaf4', '#985b87', '#e0ab8c'],
  ['#e9eef8', '#405f92', '#c99072'],
  ['#fff2e2', '#b66b35', '#e2ad88'],
  ['#e5f2f3', '#287581', '#d19a78'],
  ['#f2eafa', '#76569b', '#dfaa8c'],
];

function hex(value) {
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

for (let index = 0; index < palettes.length; index += 1) {
  const [background, shirt, skin] = palettes[index].map(hex);
  const size = 256;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const distance = Math.hypot(x - 128, y - 105);
      const shirtShape = y > 162 && Math.abs(x - 128) < 94 - Math.max(0, y - 195) * 0.35;
      const face = distance < 54 && y < 166;
      const hair = Math.hypot(x - 128, y - 80) < 56 && y < 110;
      const eye = ((x - 105) ** 2 + (y - 112) ** 2 < 7) || ((x - 151) ** 2 + (y - 112) ** 2 < 7);
      const mouth = y > 132 && y < 137 && x > 118 && x < 139;
      let color = background;
      if (shirtShape) color = shirt;
      if (face) color = skin;
      if (hair) color = shirt;
      if (eye || mouth) color = [39, 45, 55];
      pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255;
    }
  }
  fs.writeFileSync(path.join(outputDir, `avatar-${index + 1}.png`), png(size, size, pixels));
}
