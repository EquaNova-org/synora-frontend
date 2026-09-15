const { contextBridge, ipcRenderer } = require('electron');

// If you already have a preload.js with other bridged APIs, merge this in
// rather than replacing the file.
//
// NOTE: this file MUST stay CommonJS (require/module.exports), even though
// the rest of the project uses ES modules ("type": "module" in package.json).
// Electron's sandboxed preload context does not support import/export
// syntax -- using it throws "Cannot use import statement outside a module".
contextBridge.exposeInMainWorld('electronAPI', {
  // Opens a URL in the system browser instead of navigating this window to
  // it. Used for both Stripe Checkout and the sign-in handoff page.
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // Fired when the app is brought back via synora://checkout?status=...
  // Returns an unsubscribe function.
  onCheckoutCallback: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('checkout-callback', listener);
    return () => ipcRenderer.removeListener('checkout-callback', listener);
  },

  // Fired when the app is brought back via synora://auth?token=... after
  // the user completes sign-in in the system browser (see
  // DesktopAuthHandoff.jsx on the web frontend). The payload is our own
  // backend-issued desktop token (see desktop_auth.py), not a Clerk
  // session -- store it with setStoredAuthToken below. Returns an
  // unsubscribe function.
  onAuthCallback: (callback) => {
    const listener = (_event, token) => callback(token);
    ipcRenderer.on('auth-callback', listener);
    return () => ipcRenderer.removeListener('auth-callback', listener);
  },

  // Secure, OS-keychain-backed persistence for the desktop token (see
  // main.js's safeStorage-backed handlers) -- not plain localStorage.
  getStoredAuthToken: () => ipcRenderer.invoke('auth:get-token'),
  setStoredAuthToken: (token) => ipcRenderer.invoke('auth:set-token', token),
  clearStoredAuthToken: () => ipcRenderer.invoke('auth:clear-token'),
});
