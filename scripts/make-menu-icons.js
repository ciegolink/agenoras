// Builds the small icons of the tray menu (Open, New email, New event, …) from the same line icons as in the app:
// build/menu/<name>.png (16 px) and <name>@2x.png (32 px) in black for Windows and Linux,
// <name>Template.png / <name>Template@2x.png for macOS (template images: the system colours them for light and dark menus).
// Usage: npm run menu-icons
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build', 'menu');
const ICONS = {
  open: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  event: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M12 13v5M9.5 15.5h5"/>',
  task: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
  contact: '<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 12.5-4.3"/><path d="M19 14v6M16 17h6"/>',
  quit: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
};
const BLACK = '#000000';

const svg = (paths, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<canvas></canvas>');
  const render = (data, size) =>
    w.webContents.executeJavaScript(`new Promise((res) => { const img = new Image(); img.onload = () => {
      const c = document.querySelector('canvas'); c.width = c.height = ${size}; const x = c.getContext('2d'); x.clearRect(0, 0, ${size}, ${size}); x.drawImage(img, 0, 0, ${size}, ${size});
      res(c.toDataURL('image/png').split(',')[1]); }; img.src = ${JSON.stringify(data)}; })`);
  for (const [name, paths] of Object.entries(ICONS)) {
    for (const [suffix, color] of [['', BLACK], ['Template', BLACK]]) {
      const data = 'data:image/svg+xml;base64,' + Buffer.from(svg(paths, color)).toString('base64');
      fs.writeFileSync(path.join(OUT, `${name}${suffix}.png`), Buffer.from(await render(data, 16), 'base64'));
      fs.writeFileSync(path.join(OUT, `${name}${suffix}@2x.png`), Buffer.from(await render(data, 32), 'base64'));
    }
  }
  console.log('Menu icons written to', OUT);
  app.quit();
});
