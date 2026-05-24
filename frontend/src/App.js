import React, { useState, useCallback, useRef, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import EditorPane from "./components/EditorPane";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import GitHubPanel from "./components/GitHubPanel";
import CollabPanel, { colorForName } from "./components/CollabPanel";
import AIPanel from "./components/AIPanel";
import GitPanel from "./components/GitPanel";
import Terminal from "./components/Terminal";
import NewProjectDialog from "./components/NewProjectDialog";
import TitleBar from "./components/TitleBar";
import SettingsPanel from "./components/SettingsPanel";

async function pickFolder() {
  if (window.electronAPI?.openFolder) return await window.electronAPI.openFolder();
  return window.prompt("Enter folder path:");
}

export default function App() {
  const [activePanel, setActivePanel]     = useState("explorer");
  const [openFiles, setOpenFiles]         = useState([]);
  const [activeFile, setActiveFile]       = useState(null);
  const [rootPath, setRootPath]           = useState(null);
  const [branch, setBranch]               = useState("main");
  const [cursorPos, setCursorPos]         = useState({ line:1, col:1 });
  const [language, setLanguage]           = useState("plaintext");
  const [terminalOpen, setTerminalOpen]   = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(200);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showSettings, setShowSettings]   = useState(false);
  const [terminalLines, setTerminalLines] = useState([]);
  const [activeTerminalTab, setActiveTerminalTab] = useState("terminal");
  const dragging = useRef(false);

  // ── Collab state ─────────────────────────────────────────────────────────────
  // No WebSocket ref — real-time collab now uses a raw TCP socket managed by
  // Electron main.js.  Messages arrive via window.electronAPI.onCollabMessage.
  const [collabConnected, setCollabConnected] = useState(false);
  const [collabCode, setCollabCode]           = useState("");
  const [collabMyName, setCollabMyName]       = useState("");
  const [collabParticipants, setCollabParticipants] = useState([]);
  const [collabCursors, setCollabCursors]     = useState({});
  // collabEdit: { path, content, from, _ts } — latest received remote edit
  const [collabEdit, setCollabEdit]           = useState(null);

  // ── File helpers ──────────────────────────────────────────────────────────────
  const openFile = useCallback((file) => {
    setOpenFiles((prev) => {
      if (prev.find((f) => f.path === file.path)) {
        // update content if provided
        if (file.content !== undefined) {
          return prev.map(f => f.path === file.path ? { ...f, content: file.content } : f);
        }
        return prev;
      }
      return [...prev, { ...file, isDirty: false }];
    });
    setActiveFile(file.path);
  }, []);

  const closeFile = useCallback((path) => {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      setActiveFile(next.length > 0 ? next[next.length - 1].path : null);
      return next;
    });
  }, []);

  const updateFileContent = useCallback((path, content) => {
    setOpenFiles((prev) => prev.map((f) => f.path === path ? { ...f, content, isDirty: true } : f));
  }, []);

  const markFileSaved = useCallback((path) => {
    setOpenFiles((prev) => prev.map((f) => f.path === path ? { ...f, isDirty: false } : f));
  }, []);

  const handleOpenFolder = async () => {
    const path = await pickFolder();
    if (path?.trim()) { setRootPath(path.trim()); setActivePanel("explorer"); }
  };

  const handleRunOutput = useCallback((lines) => {
    setTerminalOpen(true);
    setActiveTerminalTab("output");
    setTerminalLines(prev => [...prev, ...lines]);
  }, []);

  // ── Collab helpers ────────────────────────────────────────────────────────────

  // Send a JSON message through Electron main → TCP socket → Python server.
  const collabSend = useCallback((msg) => {
    if (collabConnected && window.electronAPI?.collabSend) {
      window.electronAPI.collabSend(msg);
    }
  }, [collabConnected]);

  // Called by CollabPanel when the server sends a "welcome" message,
  // confirming the session was created or joined successfully.
  // No WebSocket argument — the socket lives in Electron main.js.
  const onCollabConnect = useCallback((code, name) => {
    setCollabConnected(true);
    setCollabCode(code);
    setCollabMyName(name);
  }, []);

  const onCollabDisconnect = useCallback(() => {
    setCollabConnected(false);
    setCollabCode("");
    setCollabMyName("");
    setCollabParticipants([]);
    setCollabCursors({});
  }, []);

  // Central message handler — called by CollabPanel for every incoming WS message
  const handleCollabMessage = useCallback((msg) => {
    if (msg.type === "welcome" || msg.type === "presence") {
      setCollabParticipants((msg.participants || []).map(n => ({ name: n })));
    }

    if (msg.type === "welcome") {
      // Open all files the host already has open
      const fileState = msg.file_state || {};
      for (const [path, content] of Object.entries(fileState)) {
        const filename = path.replace(/\\/g, "/").split("/").pop();
        setOpenFiles(prev => {
          if (prev.find(f => f.path === path)) return prev.map(f => f.path === path ? { ...f, content } : f);
          return [...prev, { name: filename, path, content, isDirty: false }];
        });
        setActiveFile(path);
      }
      // Restore host's root path
      if (msg.root_path) setRootPath(msg.root_path);
    }

    if (msg.type === "file_tree" && msg.rootPath) {
      setRootPath(msg.rootPath);
    }

    if (msg.type === "open_file" && msg.path) {
      const filename = msg.path.replace(/\\/g, "/").split("/").pop();
      setOpenFiles(prev => {
        if (prev.find(f => f.path === msg.path)) return prev.map(f => f.path === msg.path ? { ...f, content: msg.content || "" } : f);
        return [...prev, { name: filename, path: msg.path, content: msg.content || "", isDirty: false }];
      });
      setActiveFile(msg.path);
    }

    if (msg.type === "edit" && msg.path) {
      // Pass to EditorPane for Monaco update; also update App state for inactive tabs
      setCollabEdit({ path: msg.path, content: msg.content || "", from: msg.from, _ts: msg.timestamp });
      setOpenFiles(prev => prev.map(f => f.path === msg.path ? { ...f, content: msg.content || "" } : f));
    }

    if (msg.type === "cursor" && msg.from) {
      setCollabCursors(prev => ({
        ...prev,
        [msg.from]: { path: msg.path, line: msg.line, col: msg.col },
      }));
    }

    if (msg.type === "presence" && msg.event === "leave" && msg.name) {
      setCollabCursors(prev => { const n = { ...prev }; delete n[msg.name]; return n; });
    }
  }, []);

  // Broadcast rootPath when it changes (host shares file tree with participants)
  useEffect(() => {
    if (!collabConnected || !rootPath) return;
    collabSend({ type: "file_tree", rootPath });
  }, [rootPath, collabConnected, collabSend]);

  // ── Resize drag ───────────────────────────────────────────────────────────────
  const onDragStart = (e) => {
    dragging.current = true;
    const startY = e.clientY;
    const startH = terminalHeight;
    const onMove = (ev) => { if (dragging.current) setTerminalHeight(Math.max(80, Math.min(500, startH + startY - ev.clientY))); };
    const onUp   = () => { dragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const activeFileObj = openFiles.find((f) => f.path === activeFile) || null;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh", width:"100vw", overflow:"hidden", backgroundColor:"#1e1e1e", color:"#cccccc" }}>
      <TitleBar />

      {showNewProject && (
        <NewProjectDialog
          onClose={() => setShowNewProject(false)}
          onCreated={(path) => { setRootPath(path); setShowNewProject(false); setActivePanel("explorer"); }}
        />
      )}

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <div style={{ display:"flex", flex:1, overflow:"hidden" }}>
        <Sidebar activePanel={activePanel} setActivePanel={setActivePanel} onOpenSettings={() => setShowSettings(true)} />

        <div style={{ display:"flex", flexDirection:"column", width:"240px", minWidth:"160px", backgroundColor:"#252526", borderRight:"1px solid #3e3e42", overflow:"hidden", flexShrink:0 }}>
          <div style={{ display: activePanel === "explorer" ? "flex" : "none", flexDirection:"column", height:"100%", overflow:"hidden" }}><FileTree rootPath={rootPath} setRootPath={setRootPath} onOpenFile={openFile} activeFilePath={activeFile} onNewProject={() => setShowNewProject(true)} /></div>
          <div style={{ display: activePanel === "git"      ? "flex" : "none", flexDirection:"column", height:"100%", overflow:"hidden" }}><GitPanel rootPath={rootPath} branch={branch} setBranch={setBranch} /></div>
          <div style={{ display: activePanel === "github"   ? "flex" : "none", flexDirection:"column", height:"100%", overflow:"hidden" }}><GitHubPanel onOpenFile={openFile} rootPath={rootPath} /></div>
          <div style={{ display: activePanel === "collab"   ? "flex" : "none", flexDirection:"column", height:"100%", overflow:"hidden" }}>
            <CollabPanel
              connected={collabConnected}
              code={collabCode}
              participants={collabParticipants}
              myName={collabMyName}
              onConnect={onCollabConnect}
              onDisconnect={onCollabDisconnect}
              onMessage={handleCollabMessage}
            />
          </div>
          <div style={{ display: activePanel === "ai"       ? "flex" : "none", flexDirection:"column", height:"100%", overflow:"hidden" }}><AIPanel activeFile={activeFileObj} language={language} /></div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden" }}>
          <div style={{ flex:1, overflow:"hidden", display:"flex" }}>
            <EditorPane
              openFiles={openFiles}
              activeFile={activeFile}
              setActiveFile={setActiveFile}
              onCloseFile={closeFile}
              onUpdateContent={updateFileContent}
              onMarkSaved={markFileSaved}
              onCursorChange={setCursorPos}
              onLanguageChange={setLanguage}
              onNewProject={() => setShowNewProject(true)}
              onOpenFolder={handleOpenFolder}
              onRunOutput={handleRunOutput}
              collabSend={collabSend}
              collabConnected={collabConnected}
              collabEdit={collabEdit}
              collabCursors={collabCursors}
              collabParticipants={collabParticipants}
              collabMyName={collabMyName}
            />
          </div>

          {terminalOpen && (
            <div onMouseDown={onDragStart} style={{ height:"4px", backgroundColor:"#3e3e42", cursor:"ns-resize", flexShrink:0 }}
              onMouseEnter={e => e.currentTarget.style.backgroundColor="#0078d4"}
              onMouseLeave={e => e.currentTarget.style.backgroundColor="#3e3e42"} />
          )}

          <Terminal
            open={terminalOpen}
            onToggle={() => setTerminalOpen(o => !o)}
            height={terminalHeight}
            rootPath={rootPath}
            externalLines={terminalLines}
            setExternalLines={setTerminalLines}
            activeTab={activeTerminalTab}
            setActiveTab={setActiveTerminalTab}
          />
        </div>
      </div>

      <StatusBar branch={branch} cursorPos={cursorPos} language={language} activeFile={activeFile} />
    </div>
  );
}
