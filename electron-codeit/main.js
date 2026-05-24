const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const http = require("http");
const net  = require("net");
const { spawn, execSync } = require("child_process");

const PORT        = 58483;
const COLLAB_PORT = 8002;          // Raw TCP collaboration server
const DEV = process.env.NODE_ENV === "development" || !app.isPackaged;

// ── TCP Collaboration socket state ────────────────────────────────────────────
let collabSocket = null;   // active net.Socket, or null
let collabBuf    = "";     // partial-line accumulation buffer

let mainWindow = null;
let backendProcess = null;   // non-null only if THIS process started the backend

// ── Port helpers ──────────────────────────────────────────────────────────────

function killPort() {
  try {
    if (process.platform === "win32") {
      const result = execSync(`netstat -ano | findstr :${PORT}`, { encoding: "utf8" });
      const lines = result.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0") {
          try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); } catch (e) {}
        }
      }
    }
  } catch (e) {}
}

// Ping the health endpoint. Resolves true if the backend is already up.
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}/api/`, (res) => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

// ── Backend lifecycle ─────────────────────────────────────────────────────────

async function startBackend() {
  if (DEV) {
    console.log("[main] Dev mode — expecting backend already running on", PORT);
    return 0;
  }

  // If a CodeLab backend is already healthy (started by another window),
  // share it instead of killing it and starting a new one.
  if (await checkHealth()) {
    console.log("[main] Backend already running on port", PORT, "— sharing it");
    return 0;   // window can open immediately, no startup delay needed
  }

  // Nothing healthy on the port — kill any stale process and start fresh.
  killPort();
  const exePath = path.join(process.resourcesPath, "codelab-server", "codelab-server.exe");
  console.log("[main] Starting backend:", exePath);
  backendProcess = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    stdio: "pipe",
    detached: false,
  });
  backendProcess.stdout.on("data", (d) => console.log("[backend]", d.toString().trim()));
  backendProcess.stderr.on("data", (d) => console.error("[backend]", d.toString().trim()));
  backendProcess.on("exit", (code) => console.log("[backend] exited with code", code));

  return 5000;   // give the server time to start before opening the window
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#1e1e1e",
    title: "CodeLab",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(
      `window.__BACKEND_URL__ = 'http://localhost:${PORT}';`
    );
  });

  if (DEV) {
    mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = path.join(process.resourcesPath, "app", "index.html");
    mainWindow.loadFile(indexPath);
  }

  mainWindow.on("closed", () => { mainWindow = null; });

  // Redirect all window.open() calls (e.g. GitHub token page) to the system
  // browser instead of opening a blank new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };   // don't open an Electron window
  });
}

// ── Menu ──────────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Open Folder", accelerator: "CmdOrCtrl+Shift+O", click: () => mainWindow?.webContents.executeJavaScript(`document.querySelector('[data-testid="open-folder-btn"]')?.click()`) },
        { type: "separator" },
        { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { label: "Toggle DevTools", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: "Run",
      submenu: [
        { label: "Run File", accelerator: "F5", click: () => mainWindow?.webContents.executeJavaScript(`window.__runCode && window.__runCode()`) },
        { label: "Debug File", accelerator: "F6", click: () => mainWindow?.webContents.executeJavaScript(`window.__debugCode && window.__debugCode()`) },
        { label: "Stop", accelerator: "Shift+F5", click: () => mainWindow?.webContents.executeJavaScript(`window.__stopCode && window.__stopCode()`) },
      ],
    },
    { label: "Help", submenu: [{ label: "About CodeLab", click: () => dialog.showMessageBox(mainWindow, { type: "info", title: "CodeLab", message: "CodeLab v1.0.0\n\nA modern code editor with GitHub integration and AI assistance." }) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle("window:close", () => mainWindow?.close());
ipcMain.handle("shell:openExternal", (_event, url) => shell.openExternal(url));

// ── TCP Collaboration IPC handlers ────────────────────────────────────────────
//
// The renderer cannot open raw TCP sockets (browser security model).
// Instead it calls these IPC handlers; the main process owns the net.Socket
// and forwards data in both directions.
//
// collab:connect  → open TCP connection, send create/join message
// collab:send     → write a JSON message to the socket
// collab:disconnect → send leave + destroy socket
// 'collab:message' events are pushed to the renderer via webContents.send()

ipcMain.handle("collab:connect", (_event, host, port, name, sessionCode) => {
  return new Promise((resolve, reject) => {
    // Tear down any existing connection first
    if (collabSocket) {
      try { collabSocket.destroy(); } catch (_) {}
      collabSocket = null;
      collabBuf = "";
    }

    const sock = net.createConnection({ host: host || "127.0.0.1", port: port || COLLAB_PORT }, () => {
      collabSocket = sock;
      // First message establishes the session:
      //   sessionCode == null → create a new session
      //   sessionCode != null → join an existing session
      const initMsg = sessionCode
        ? { type: "join", code: sessionCode, name }
        : { type: "create", name };
      sock.write(JSON.stringify(initMsg) + "\n");
      resolve({ ok: true });
    });

    sock.setEncoding("utf-8");

    sock.on("data", (chunk) => {
      collabBuf += chunk;
      // Parse every complete newline-delimited JSON line
      const lines = collabBuf.split("\n");
      collabBuf = lines.pop();            // last element may be incomplete
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          mainWindow?.webContents.send("collab:message", msg);
        } catch (_) { /* ignore malformed lines */ }
      }
    });

    sock.on("error", (err) => {
      console.error("[collab-tcp] socket error:", err.message);
      if (collabSocket === sock) { collabSocket = null; collabBuf = ""; }
      // If the promise hasn't resolved yet, reject it; otherwise push disconnected event
      reject(err);
    });

    sock.on("close", () => {
      console.log("[collab-tcp] socket closed");
      if (collabSocket === sock) { collabSocket = null; collabBuf = ""; }
      mainWindow?.webContents.send("collab:message", { type: "disconnected" });
    });
  });
});

ipcMain.handle("collab:send", (_event, msg) => {
  if (collabSocket && !collabSocket.destroyed) {
    try {
      collabSocket.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      console.error("[collab-tcp] send error:", err.message);
    }
  }
});

ipcMain.handle("collab:disconnect", () => {
  if (collabSocket) {
    try {
      collabSocket.write(JSON.stringify({ type: "leave" }) + "\n");
      collabSocket.destroy();
    } catch (_) {}
    collabSocket = null;
    collabBuf = "";
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const delay = await startBackend();
  buildMenu();
  setTimeout(() => { createWindow(); }, delay);
});

app.on("window-all-closed", () => {
  // Only kill the backend if THIS process started it.
  // If we're sharing another instance's backend, leave it running.
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => { if (mainWindow === null) createWindow(); });
