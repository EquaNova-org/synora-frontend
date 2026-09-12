import { app, BrowserWindow, shell, ipcMain, protocol, net } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vite's dev server URL during development; in production we load the
// built static files directly from disk instead.
const DEV_SERVER_URL = 'http://localhost:5173';
const isDev = !app.isPackaged;

// Custom protocol Stripe Checkout redirects back into instead of an
// https:// URL -- see api.py's create-checkout-session (client="desktop").
// This keeps the packaged app's own window from ever navigating away to
// the hosted web tier when a payment completes.
const PROTOCOL = 'synora';

// Separate custom scheme for serving the built frontend itself. Vite emits
// <script type="module">, and Chromium silently blocks ES module scripts
// loaded over a raw file:// URL (CORS), which is why the packaged app was
// showing a blank white window even after fixing vite.config.js's `base`.
// Serving dist/ through a privileged scheme instead makes it behave like a
// normal origin, so module scripts load correctly. Must be registered
// before the app is ready.
const APP_SCHEME = 'app';
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow = null;
// Deep link that arrived before the window existed (cold start on Windows/Linux).
let pendingDeepLink = null;

function registerProtocol() {
  if (isDev && process.platform === 'win32') {
    // In dev, Electron is launched via a generic electron.exe, so the OS
    // needs to be told the exact args to relaunch with.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function extractDeepLink(argv) {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`)) || null;
}

function handleDeepLink(url) {
  if (!url) return;
  let status = null;
  try {
    status = new URL(url).searchParams.get('status');
  } catch {
    return; // malformed, ignore
  }
  if (!mainWindow) {
    pendingDeepLink = status;
    return;
  }
  mainWindow.webContents.send('checkout-callback', status);
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 820,
    minWidth: 400,
    minHeight: 600,
    title: 'Synora',
    backgroundColor: '#f7f6f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Serve the built app over app:// (registered above) instead of raw
    // file:// so Vite's <script type="module"> bundles actually load.
    mainWindow.loadURL(`${APP_SCHEME}://bundle/index.html`);
  }

  // Open any target="_blank" links (e.g. Terms/Privacy) in the OS browser
  // instead of inside the Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingDeepLink) {
      mainWindow.webContents.send('checkout-callback', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Stripe Checkout must open in the system browser, never navigate the
// packaged app's own window (that would replace it with the web tier at
// FRONTEND_URL). The renderer calls this via the preload bridge instead of
// setting window.location.href directly.
ipcMain.handle('checkout:open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running -- let it handle the deep link
  // (delivered to it via 'second-instance' below) and quit this one.
  app.quit();
} else {
  registerProtocol();

  // Windows/Linux: a deep link relaunches the app or, if it's already
  // running, arrives here as argv on the existing instance.
  app.on('second-instance', (_event, argv) => {
    handleDeepLink(extractDeepLink(argv));
  });

  // macOS: deep links arrive via this event instead of argv.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(() => {
    // dist/ sits one level up from electron/ after the Vite build.
    const distPath = path.join(__dirname, '..', 'dist');
    protocol.handle(APP_SCHEME, (request) => {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '' || pathname === '/') pathname = '/index.html';
      const filePath = path.join(distPath, pathname);
      return net.fetch(pathToFileURL(filePath).toString());
    });

    // Cold start on Windows/Linux via the protocol (app wasn't running yet).
    pendingDeepLink = (() => {
      const link = extractDeepLink(process.argv);
      if (!link) return null;
      try {
        return new URL(link).searchParams.get('status');
      } catch {
        return null;
      }
    })();
    createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
