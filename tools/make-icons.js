'use strict';

// Rasterises assets/logo.svg into build/icon.png, which electron-builder turns
// into a .icns for macOS and a .ico for Windows. Run it after changing the SVG:
//
//   npm run icons
//
// Uses the Electron already in devDependencies, so there is no image toolchain
// to install and the SVG stays the single source of truth for the mark.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'logo.svg');
const OUT_DIR = path.join(ROOT, 'build');
const SIZE = 1024;

app.disableHardwareAcceleration();

async function render() {
  const svg = fs.readFileSync(SOURCE, 'utf8');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false },
  });

  const page = `<!doctype html><meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; background:transparent; }
  svg { display:block; width:${SIZE}px; height:${SIZE}px; }
</style>
${svg}`;

  await win.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(page)
  );
  // Let the compositor settle so gradients and the mask are fully painted.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  const target = path.join(OUT_DIR, 'icon.png');
  fs.writeFileSync(target, png);
  win.destroy();

  const { width, height } = image.getSize();
  console.log(`wrote ${path.relative(ROOT, target)}  ${width}x${height}  ${png.length} bytes`);

  if (width < 512 || height < 512) {
    console.error('ERROR: icon must be at least 512x512 for electron-builder.');
    return 1;
  }
  return 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await render();
  } catch (error) {
    console.error('icon generation failed:', error);
  }
  app.exit(code);
});
