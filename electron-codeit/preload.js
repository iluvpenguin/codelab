const { contextBridge, ipcRenderer } = require("electron");

// Track the single active collab:message listener so we can remove it cleanly.
let _collabListener = null;

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Window / dialog ─────────────────────────────────────────────────────────
  openFolder:    () => ipcRenderer.invoke("dialog:openFolder"),
  minimize:      () => ipcRenderer.invoke("window:minimize"),
  maximize:      () => ipcRenderer.invoke("window:maximize"),
  close:         () => ipcRenderer.invoke("window:close"),
  openExternal:  (url) => ipcRenderer.invoke("shell:openExternal", url),
  platform:      process.platform,

  // ── TCP Collaboration ────────────────────────────────────────────────────────
  //
  // collabConnect  — open a TCP connection and send create/join.
  //   host        : TCP host (usually "127.0.0.1")
  //   port        : TCP port (usually 8002)
  //   name        : display name for this participant
  //   sessionCode : 6-char invite code to join, or null to create a new session
  //
  // Returns a Promise that resolves { ok: true } when the socket is open,
  // or rejects with the socket error.  The actual session welcome/error comes
  // later as a 'collab:message' IPC event.
  collabConnect: (host, port, name, sessionCode) =>
    ipcRenderer.invoke("collab:connect", host, port, name, sessionCode),

  // collabSend — write one JSON message to the open TCP socket.
  collabSend: (msg) => ipcRenderer.invoke("collab:send", msg),

  // collabDisconnect — send { type:"leave" } and close the socket.
  collabDisconnect: () => ipcRenderer.invoke("collab:disconnect"),

  // onCollabMessage — register a callback for inbound TCP messages.
  //   Only one callback is active at a time.  Call offCollabMessage() to remove it.
  onCollabMessage: (callback) => {
    // Remove any previous listener first
    if (_collabListener) {
      ipcRenderer.removeListener("collab:message", _collabListener);
    }
    _collabListener = (_event, msg) => callback(msg);
    ipcRenderer.on("collab:message", _collabListener);
  },

  // offCollabMessage — remove the currently registered callback.
  offCollabMessage: () => {
    if (_collabListener) {
      ipcRenderer.removeListener("collab:message", _collabListener);
      _collabListener = null;
    }
  },
});
