import { app, BrowserWindow, shell, ipcMain, protocol, net, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
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

// synora://checkout?status=success|canceled  -> Stripe Checkout return
// synora://auth?token=<desktop-token>          -> post-sign-in handoff
// (see api.py's create-checkout-session and desktop-handoff endpoints)
function parseDeepLink(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.host === 'checkout') {
      return { kind: 'checkout', status: parsed.searchParams.get('status') };
    }
    if (parsed.host === 'auth') {
      return { kind: 'auth', token: parsed.searchParams.get('token') };
    }
  } catch {
    // malformed, ignore
  }
  return null;
}

function deliverDeepLink(parsed) {
  if (!mainWindow || !parsed) return;
  if (parsed.kind === 'checkout') {
    mainWindow.webContents.send('checkout-callback', parsed.status);
  } else if (parsed.kind === 'auth') {
    mainWindow.webContents.send('auth-callback', parsed.token);
  }
}

function handleDeepLink(url) {
  const parsed = parseDeepLink(url);
  if (!parsed) return;
  if (!mainWindow) {
    pendingDeepLink = parsed;
    return;
  }
  deliverDeepLink(parsed);
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
    // TEMPORARY -- remove this line once the blank-screen issue is confirmed
    // fixed. Opens the Chromium inspector so we can see real console errors
    // in the packaged app, which are otherwise completely invisible.
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Open any target="_blank" links (e.g. Terms/Privacy) in the OS browser
  // instead of inside the Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingDeepLink) {
      deliverDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Stripe Checkout and the Clerk sign-in handoff page must both open in the
// system browser, never navigate the packaged app's own window (that would
// replace it with the web tier). The renderer calls this via the preload
// bridge instead of setting window.location.href directly.
ipcMain.handle('app:open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});

// Secure storage for the desktop app's own auth token (see desktop_auth.py
// on the backend and App.jsx's getAuthToken). Encrypted at rest via the
// OS keychain (safeStorage) rather than plain localStorage, since this is
// a health app's auth credential -- not just a UI preference.
function tokenFilePath() {
  return path.join(app.getPath('userData'), 'desktop_token.enc');
}

ipcMain.handle('auth:get-token', () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = fs.readFileSync(tokenFilePath());
    return safeStorage.decryptString(encrypted);
  } catch {
    return null; // no token stored yet, or the file is unreadable/corrupt
  }
});

ipcMain.handle('auth:set-token', (_event, token) => {
  if (typeof token !== 'string' || !safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(tokenFilePath(), safeStorage.encryptString(token));
  return true;
});

ipcMain.handle('auth:clear-token', () => {
  try {
    fs.unlinkSync(tokenFilePath());
  } catch {
    // already gone -- fine
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
    pendingDeepLink = parseDeepLink(extractDeepLink(process.argv));
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
