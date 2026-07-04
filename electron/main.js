import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..'); // project root — where server.js + public/ live

// Ask the OS for a free localhost port so we never collide with another app.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Wait until the embedded server answers before we point the window at it.
function waitForServer(port, timeout = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/status' }, (r) => {
        r.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeout) reject(new Error('embedded server did not start in time'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

let win;

async function createWindow(port) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#05070d',
    title: 'Flight-Radar',
    icon: join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // External links (aisstream.io, opensky, plane photos) open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(`http://127.0.0.1:${port}/`);

  if (process.env.FR_SMOKE) {
    // Headless CI/self-test: prove it booted and loaded, then exit cleanly.
    setTimeout(() => app.quit(), 2500);
  }
}

app.whenReady().then(async () => {
  const port = await freePort();
  process.env.PORT = String(port);
  // Keys saved from the web UI must persist to a writable, per-user location.
  process.env.FR_DATA_DIR = app.getPath('userData');

  // Importing server.js boots Express + the AIS stream (side effects on import).
  await import(pathToFileURL(join(ROOT, 'server.js')).href);
  await waitForServer(port);
  await createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => app.quit());
