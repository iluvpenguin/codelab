import React, { useState, useEffect, useRef } from "react";

const PASTEL_COLORS = [
  "#a8d8ea", "#f9c9b6", "#c8b6ff", "#ffe0a0",
  "#b8e4b8", "#f5c0d0", "#d4eac8", "#e8d4b0",
];

export function colorForName(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
  return PASTEL_COLORS[Math.abs(h) % PASTEL_COLORS.length];
}

const inputStyle   = { width:"100%", backgroundColor:"#3c3c3c", border:"1px solid #555", borderRadius:"3px", color:"#cccccc", padding:"5px 8px", fontSize:"12px", outline:"none", boxSizing:"border-box" };
const labelStyle   = { fontSize:"11px", color:"#858585", marginBottom:"4px", textTransform:"uppercase", letterSpacing:"0.08em" };
const sectionStyle = { padding:"10px 12px", borderBottom:"1px solid #3e3e42" };
const btnPrimary   = { width:"100%", backgroundColor:"#0078d4", border:"none", borderRadius:"3px", color:"#fff", padding:"7px", cursor:"pointer", fontSize:"12px", display:"flex", alignItems:"center", justifyContent:"center", gap:"6px" };
const btnSecondary = { width:"100%", backgroundColor:"transparent", border:"1px solid #555", borderRadius:"3px", color:"#cccccc", padding:"7px", cursor:"pointer", fontSize:"12px", display:"flex", alignItems:"center", justifyContent:"center", gap:"6px" };

/**
 * CollabPanel — real-time collaboration via raw TCP socket.
 *
 * The browser renderer cannot open TCP sockets directly, so all network I/O
 * goes through Electron's main process:
 *
 *   window.electronAPI.collabConnect(host, port, name, code|null)
 *     → main.js opens net.Socket → sends { type:"create"|"join", ... }
 *     → server replies with { type:"welcome", ... }
 *     → main.js fires ipcRenderer.send("collab:message", msg)
 *     → onCollabMessage callback → onConnect(code, name)
 *
 * Subsequent messages (edit, cursor, presence, …) arrive the same way.
 */
export default function CollabPanel({ connected, code, participants, myName, onConnect, onDisconnect, onMessage }) {
  const [name, setName]         = useState("User" + Math.floor(Math.random() * 999));
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied]     = useState(false);
  const [error, setError]       = useState(null);
  const [connecting, setConnecting] = useState(false);

  // Store the display name used for the pending connection attempt so the
  // welcome handler can read it even if the state closure is stale.
  const pendingNameRef = useRef("");

  // ── IPC message listener ──────────────────────────────────────────────────
  // Always active so we can receive the welcome/error for a connection attempt
  // before `connected` becomes true.
  useEffect(() => {
    if (!window.electronAPI?.onCollabMessage) return;

    const handler = (msg) => {
      if (msg.type === "welcome") {
        setConnecting(false);
        setError(null);
        // Notify App.js — code and name come from the server's welcome message
        onConnect(msg.code, msg.name || pendingNameRef.current);
      } else if (msg.type === "error") {
        setConnecting(false);
        setError(msg.detail || "Connection error");
      } else if (msg.type === "disconnected") {
        setConnecting(false);
        onDisconnect();
      }
      // Forward every message (including welcome/error/disconnected) to App.js
      onMessage(msg);
    };

    window.electronAPI.onCollabMessage(handler);
    return () => window.electronAPI.offCollabMessage();
  }, [onConnect, onDisconnect, onMessage]);

  // ── Session actions ───────────────────────────────────────────────────────

  const createSession = async () => {
    setError(null);
    setConnecting(true);
    pendingNameRef.current = name;
    try {
      // null sessionCode → server creates a new session and returns a welcome
      await window.electronAPI.collabConnect("127.0.0.1", 8002, name, null);
    } catch (e) {
      setConnecting(false);
      setError("Could not connect to collaboration server");
    }
  };

  const joinSession = async () => {
    if (joinCode.length !== 6) return;
    setError(null);
    setConnecting(true);
    pendingNameRef.current = name;
    try {
      // Pass the code → server joins the existing session
      await window.electronAPI.collabConnect("127.0.0.1", 8002, name, joinCode.toUpperCase());
    } catch (e) {
      setConnecting(false);
      setError("Connection failed");
    }
  };

  const disconnect = () => {
    window.electronAPI?.collabDisconnect();
  };

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <div style={{ padding:"8px 12px", borderBottom:"1px solid #3e3e42" }}>
        <span style={{ fontSize:"11px", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:"#bbbbbb" }}>Collaborate</span>
        {connecting && <span style={{ marginLeft:"8px", fontSize:"10px", color:"#858585" }}>Connecting…</span>}
      </div>

      <div style={{ flex:1, overflowY:"auto" }}>
        {/* Display name */}
        <div style={sectionStyle}>
          <div style={labelStyle}>Your Display Name</div>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} disabled={connected || connecting} />
          {connected && (
            <div style={{ marginTop:"6px", display:"flex", alignItems:"center", gap:"6px" }}>
              <div style={{ width:"8px", height:"8px", borderRadius:"50%", backgroundColor: colorForName(myName || name), flexShrink:0 }} />
              <span style={{ fontSize:"11px", color:"#858585" }}>Connected as <strong style={{ color:"#cccccc" }}>{myName || name}</strong></span>
            </div>
          )}
        </div>

        {!connected ? (
          <>
            <div style={sectionStyle}>
              <button onClick={createSession} disabled={connecting} style={{ ...btnPrimary, opacity: connecting ? 0.6 : 1 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                {connecting ? "Connecting…" : "Create Session"}
              </button>
            </div>

            <div style={sectionStyle}>
              <div style={labelStyle}>Join Existing Session</div>
              <input
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
                placeholder="Enter 6-character code"
                maxLength={6}
                style={{ ...inputStyle, textAlign:"center", letterSpacing:"0.3em", fontFamily:"monospace", fontSize:"14px", marginBottom:"6px" }}
                disabled={connecting}
              />
              <button
                onClick={joinSession}
                disabled={joinCode.length !== 6 || connecting}
                style={{ ...btnSecondary, opacity: (joinCode.length !== 6 || connecting) ? 0.5 : 1 }}
              >
                Join Session
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Session code */}
            <div style={sectionStyle}>
              <div style={labelStyle}>Session Code</div>
              <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"10px" }}>
                <div style={{ flex:1, backgroundColor:"#3c3c3c", border:"1px solid #555", borderRadius:"3px", padding:"8px", fontFamily:"monospace", fontSize:"18px", letterSpacing:"0.3em", textAlign:"center", color:"#4ec9b0", fontWeight:700 }}>
                  {code}
                </div>
                <button onClick={copyCode} style={{ background:"none", border:"1px solid #555", borderRadius:"3px", color: copied ? "#73c991" : "#858585", padding:"8px", cursor:"pointer", fontSize:"11px", flexShrink:0 }}>
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <div style={{ fontSize:"11px", color:"#858585", marginBottom:"10px" }}>Share this code with collaborators</div>
              <button onClick={disconnect} style={{ ...btnSecondary, borderColor:"#f44747", color:"#f44747" }}>
                Disconnect
              </button>
            </div>

            {/* Participants */}
            <div style={sectionStyle}>
              <div style={labelStyle}>Participants ({participants.length})</div>
              {participants.map((p, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:"8px", padding:"5px 0", fontSize:"12px", color:"#cccccc" }}>
                  <div style={{ width:"10px", height:"10px", borderRadius:"50%", backgroundColor: colorForName(p.name), flexShrink:0, border:"1px solid rgba(255,255,255,0.15)" }} />
                  {p.name} {p.name === (myName || name) ? <span style={{ color:"#858585", fontSize:"11px" }}>(you)</span> : null}
                </div>
              ))}
            </div>

            {/* Info */}
            <div style={{ padding:"8px 12px" }}>
              <div style={{ fontSize:"10px", color:"#555", lineHeight:"1.6" }}>
                Cursors shown in editor with matching colors.<br />
                File tree and edits sync in real time via TCP socket.
              </div>
            </div>
          </>
        )}

        {error && <div style={{ padding:"8px 12px", color:"#f44747", fontSize:"12px" }}>{error}</div>}
      </div>
    </div>
  );
}
