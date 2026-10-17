const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow = null;

// Register custom protocol scheme for deep-linking (templeconnect://)[cite: 1]
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('templeconnect', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('templeconnect');
}

// Ensure single instance lock so deep links focus the running app[cite: 1]
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Focus window if user triggers protocol while app is already open[cite: 1]
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      const deepLink = commandLine.find(arg => arg.startsWith('templeconnect://'));
      if (deepLink) {
        const targetUrl = parseDeepLink(deepLink);
        mainWindow.loadURL(targetUrl);
      }
    }
  });

  app.whenReady().then(() => {
    const deepLinkArg = process.argv.find(arg => arg.startsWith('templeconnect://'));
    const initialUrl = parseDeepLink(deepLinkArg);

    createWindow(initialUrl);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(initialUrl);
      }
    });
  });
}

function parseDeepLink(deepLinkStr) {
  const fallbackUrl = 'https://console-templeconnect.app';
  if (!deepLinkStr) return fallbackUrl;

  try {
    const rawUrl = deepLinkStr.replace(/^templeconnect:\/\/?/, 'https://');
    const urlObj = new URL(rawUrl);
    const deviceId = urlObj.searchParams.get('device');
    const token = urlObj.searchParams.get('token');

    if (deviceId || token) {
      return `https://console-templeconnect.app/?device=${deviceId || ''}&token=${token || ''}&app=1&solo=1`;
    }
  } catch (err) {
    console.error('Failed to parse deep link protocol:', err);
  }

  return fallbackUrl;
}

function createWindow(urlToLoad) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(urlToLoad);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});