import { contextBridge, ipcRenderer } from 'electron';

// If you already have a preload.js with other bridged APIs (auth, etc.),
// merge this into it rather than replacing the file -- this only adds the
// checkout-related bridge.
contextBridge.exposeInMainWorld('electronAPI', {
  // Opens a Stripe Checkout URL in the system browser instead of navigating
  // this window to it.
  openExternalCheckout: (url) => ipcRenderer.invoke('checkout:open-external', url),

  // Registers a callback fired when the app is brought back via the
  // synora://checkout?status=success|canceled deep link. Returns an
  // unsubscribe function.
  onCheckoutCallback: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('checkout-callback', listener);
    return () => ipcRenderer.removeListener('checkout-callback', listener);
  },
});
