'use strict';

const zlib = require('zlib');
const { nativeImage } = require('electron');

// Icons are drawn at runtime instead of shipped as binary assets, so the repo
// stays plain text and the tray icon renders correctly on both platforms.

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // no filter
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedRect(x, y, rect) {
  const [x0, y0, x1, y1, r] = rect;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Two offset rounded panels with a gap between them: a stack of sessions.
// These mirror assets/logo.svg (divided by its 1024 canvas) so the tray mark
// and the app icon are the same shape.
const BACK = [0.166, 0.166, 0.586, 0.586, 0.102];
const FRONT = [0.414, 0.414, 0.834, 0.834, 0.102];
const FRONT_GAP = [0.375, 0.375, 0.873, 0.873, 0.121];

function coverageAt(x, y) {
  if (insideRoundedRect(x, y, FRONT)) return 1;
  if (insideRoundedRect(x, y, BACK) && !insideRoundedRect(x, y, FRONT_GAP)) {
    return 0.6;
  }
  return 0;
}

// 4x supersampling keeps the curves smooth at 16px.
function render(size, [r, g, b], { plate = null } = {}) {
  const samples = 4;
  const rgba = Buffer.alloc(size * size * 4);
  const plateRect = [0.02, 0.02, 0.98, 0.98, 0.22];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let glyph = 0;
      let backing = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          glyph += coverageAt(x, y);
          if (plate && insideRoundedRect(x, y, plateRect)) backing += 1;
        }
      }
      const total = samples * samples;
      glyph /= total;
      backing /= total;

      const offset = (py * size + px) * 4;
      if (plate) {
        // Composite the glyph over a coloured plate for the app icon.
        const alpha = Math.max(backing, glyph);
        const mix = backing > 0 ? glyph / Math.max(backing, 0.0001) : glyph;
        rgba[offset] = Math.round(plate[0] * (1 - mix) + r * mix);
        rgba[offset + 1] = Math.round(plate[1] * (1 - mix) + g * mix);
        rgba[offset + 2] = Math.round(plate[2] * (1 - mix) + b * mix);
        rgba[offset + 3] = Math.round(alpha * 255);
      } else {
        rgba[offset] = r;
        rgba[offset + 1] = g;
        rgba[offset + 2] = b;
        rgba[offset + 3] = Math.round(glyph * 255);
      }
    }
  }
  return encodePNG(size, size, rgba);
}

const CORAL = [217, 119, 87];

// macOS wants a black template image so the menu bar can invert it.
// Windows tray sits on a mostly dark taskbar, so a coloured mark reads better.
function trayImage() {
  if (process.platform === 'darwin') {
    const image = nativeImage.createFromBuffer(render(16, [0, 0, 0]), {
      scaleFactor: 1,
    });
    image.addRepresentation({
      scaleFactor: 2,
      buffer: render(32, [0, 0, 0]),
    });
    image.setTemplateImage(true);
    return image;
  }
  const image = nativeImage.createFromBuffer(render(16, CORAL), {
    scaleFactor: 1,
  });
  image.addRepresentation({ scaleFactor: 2, buffer: render(32, CORAL) });
  return image;
}

function appImage() {
  const image = nativeImage.createFromBuffer(
    render(256, [255, 255, 255], { plate: CORAL })
  );
  return image;
}

module.exports = { trayImage, appImage };
