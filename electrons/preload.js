// Intentionally minimal. Synora's Electron shell is a thin client -- all
// AI processing happens on Railway, and the React app doesn't need any
// Node.js or OS-level APIs today (no local file access, no native
// notifications yet). If recurring check-in reminders later need native
// desktop notifications, that bridge gets added here via
// contextBridge.exposeInMainWorld(...), not by enabling nodeIntegration.
