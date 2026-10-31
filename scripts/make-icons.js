// Builds all app icons from build/logo.svg (or logo.png): build/logo.png, build/icon.png (1024), build/icons/*.png, build/icon.ico, tray icons
// Optional: logo-small.svg for 16–32 px, tray-logo.svg for the tray (needs transparent parts for the macOS template)
// Usage: npm run icons   (the logo may be rectangular – it is centered on a square canvas)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const SRC = path.join(BUILD, 'logo.png');

// SVG wins over PNG; returns a data: URL or null
function source(name) {
  for (const [ext, type] of [['svg', 'image/svg+xml'], ['png', 'image/png']]) {
    const f = path.join(BUILD, `${name}.${ext}`);
    if (fs.existsSync(f)) return `data:${type};base64,` + fs.readFileSync(f).toString('base64');
  }
  return null;
}
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

function ico(pngs) {
  // ICO with embedded PNGs (Windows Vista+)
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, o);
    header.writeUInt8(size >= 256 ? 0 : size, o + 1);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(buf.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const data = source('logo');
  if (!data) {
    console.error('build/logo.svg or build/logo.png is missing.');
    app.exit(1);
    return;
  }
  const small = source('logo-small') ?? data;
  const trayData = source('tray-logo') ?? data;
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<canvas></canvas>');
  // the title bar and window icon use logo.png
  if (data.startsWith('data:image/svg')) {
    const b64 = await w.webContents.executeJavaScript(`new Promise((res) => { const img = new Image(); img.onload = () => {
      const c = document.querySelector('canvas'); c.width = c.height = 1024; const x = c.getContext('2d'); x.clearRect(0, 0, 1024, 1024); x.drawImage(img, 0, 0, 1024, 1024);
      res(c.toDataURL('image/png').split(',')[1]); }; img.src = ${JSON.stringify(data)}; })`);
    fs.writeFileSync(SRC, Buffer.from(b64, 'base64'));
  }
  fs.mkdirSync(path.join(BUILD, 'icons'), { recursive: true });
  const out = [];
  for (const size of SIZES) {
    const b64 = await w.webContents.executeJavaScript(`new Promise((res) => { const img = new Image(); img.onload = () => {
      const c = document.querySelector('canvas'); c.width = c.height = ${size}; const x = c.getContext('2d'); x.clearRect(0, 0, ${size}, ${size});
      x.imageSmoothingQuality = 'high'; const s = Math.min(${size} / img.width, ${size} / img.height);
      x.drawImage(img, (${size} - img.width * s) / 2, (${size} - img.height * s) / 2, img.width * s, img.height * s);
      res(c.toDataURL('image/png').split(',')[1]); }; img.src = ${JSON.stringify(size <= 32 ? small : data)}; })`);
    const buf = Buffer.from(b64, 'base64');
    if (size === 1024) fs.writeFileSync(path.join(BUILD, 'icon.png'), buf);
    else fs.writeFileSync(path.join(BUILD, 'icons', `${size}x${size}.png`), buf);
    if (size <= 256) out.push({ size, buf });
  }
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(out));

  // Tray: logo 22 px (+ @2x); variant with a dot for new mail; macOS template = black silhouette
  const tray = [
    ['tray', false, false],
    ['tray-unread', true, false],
    ['trayTemplate', false, true],
  ];
  for (const [base, unread, template] of tray) {
    for (const f of [1, 2]) {
      const size = 22 * f;
      const b64 = await w.webContents.executeJavaScript(`new Promise((res) => { const img = new Image(); img.onload = () => {
        const c = document.querySelector('canvas'); c.width = c.height = ${size}; const x = c.getContext('2d'); x.clearRect(0, 0, ${size}, ${size});
        x.globalCompositeOperation = 'source-over';
        x.imageSmoothingQuality = 'high'; const s = Math.min(${size} / img.width, ${size} / img.height);
        x.drawImage(img, (${size} - img.width * s) / 2, (${size} - img.height * s) / 2, img.width * s, img.height * s);
        if (${template}) { x.globalCompositeOperation = 'source-in'; x.fillStyle = '#000'; x.fillRect(0, 0, ${size}, ${size}); }
        if (${unread}) { const r = ${size} * 0.22; const cx = ${size} - r - 0.5, cy = r + 0.5;
          x.globalCompositeOperation = 'destination-out'; x.beginPath(); x.arc(cx, cy, r + ${f} * 1.5, 0, Math.PI * 2); x.fill();
          x.globalCompositeOperation = 'source-over'; x.fillStyle = '#2BA89F'; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); }
        res(c.toDataURL('image/png').split(',')[1]); }; img.src = ${JSON.stringify(trayData)}; })`);
      fs.writeFileSync(path.join(BUILD, `${base}${f === 2 ? '@2x' : ''}.png`), Buffer.from(b64, 'base64'));
    }
  }
  console.log('Done: build/logo.png, build/icon.png, build/icons/, build/icon.ico, build/tray*.png');
  app.exit(0);
});
