import React, { useState, useEffect, useCallback } from "react";
import api from "../api";
import TreeItems from "./TreeItems";

const RECENT_KEY = "codelab_recent_projects";

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}

function addRecent(path) {
  const recent = getRecent().filter(p => p !== path);
  recent.unshift(path);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 10)));
}

async function pickFolder() {
  if (window.electronAPI?.openFolder) return await window.electronAPI.openFolder();
  return window.prompt("Enter folder path:");
}

const Btn = ({ onClick, title, children }) => (
  <button onClick={onClick} title={title}
    style={{ background:"none", border:"none", cursor:"pointer", color:"#858585", display:"flex", alignItems:"center", padding:"3px", borderRadius:"3px" }}
    onMouseEnter={e => e.currentTarget.style.color="#cccccc"}
    onMouseLeave={e => e.currentTarget.style.color="#858585"}>
    {children}
  </button>
);

const icons = {
  Plus: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  NewFile: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>,
  NewFolder: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>,
  Open: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>,
  Refresh: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Recent: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  ChevronDown: () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>,
};

export default function FileTree({ rootPath, setRootPath, onOpenFile, activeFilePath, onNewProject }) {
  const [nodes, setNodes] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showRecent, setShowRecent] = useState(false);
  const [recent, setRecent] = useState(getRecent);

  const loadTree = useCallback(async (path) => {
    if (!path) return;
    setLoading(true); setError(null);
    try {
      const res = await api.get("/api/files/list", { params: { path } });
      setNodes(res.data.nodes || []);
    } catch { setError("Failed to load directory"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (rootPath) { loadTree(rootPath); addRecent(rootPath); setRecent(getRecent()); }
  }, [rootPath, loadTree]);

  const handleOpenFolder = async () => {
    const path = await pickFolder();
    if (path?.trim()) { setRootPath(path.trim()); setExpanded({}); }
  };

  const handleNewFile = async () => {
    if (!rootPath) return;
    const name = window.prompt("New file name:");
    if (!name?.trim()) return;
    const path = rootPath + "\\" + name.trim();
    await api.post("/api/files/write", { path, content: "" });
    loadTree(rootPath);
    onOpenFile({ path, name: name.trim(), content: "" });
  };

  const handleNewFolder = async () => {
    if (!rootPath) return;
    const name = window.prompt("New folder name:");
    if (!name?.trim()) return;
    await api.post("/api/files/mkdir", { path: rootPath + "\\" + name.trim() });
    loadTree(rootPath);
  };

  const toggleExpand = (path) => setExpanded(p => ({ ...p, [path]: !p[path] }));

  const openRecent = (path) => {
    setRootPath(path);
    setExpanded({});
    setShowRecent(false);
  };

  const removeRecent = (e, path) => {
    e.stopPropagation();
    const updated = getRecent().filter(p => p !== path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    setRecent(updated);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 12px 6px", borderBottom:"1px solid #3e3e42" }}>
        <span style={{ fontSize:"11px", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:"#bbbbbb" }}>Explorer</span>
        <div style={{ display:"flex", gap:"1px" }}>
          <Btn onClick={onNewProject} title="New Project"><icons.Plus /></Btn>
          <Btn onClick={handleNewFile} title="New File"><icons.NewFile /></Btn>
          <Btn onClick={handleNewFolder} title="New Folder"><icons.NewFolder /></Btn>
          <Btn onClick={handleOpenFolder} title="Open Folder"><icons.Open /></Btn>
          <Btn onClick={() => setShowRecent(s => !s)} title="Recent Projects"><icons.Recent /></Btn>
          <Btn onClick={() => loadTree(rootPath)} title="Refresh"><icons.Refresh /></Btn>
        </div>
      </div>

      {/* Recent projects dropdown */}
      {showRecent && (
        <div style={{ borderBottom:"1px solid #3e3e42", backgroundColor:"#1e1e1e" }}>
          <div style={{ padding:"6px 12px 4px", fontSize:"11px", color:"#858585", textTransform:"uppercase", letterSpacing:"0.08em" }}>
            Recent Projects
          </div>
          {recent.length === 0 && (
            <div style={{ padding:"8px 12px", fontSize:"12px", color:"#555", fontStyle:"italic" }}>No recent projects</div>
          )}
          {recent.map(path => (
            <div key={path} onClick={() => openRecent(path)}
              style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"5px 12px", cursor:"pointer", fontSize:"12px" }}
              onMouseEnter={e => e.currentTarget.style.backgroundColor="#2a2d2e"}
              onMouseLeave={e => e.currentTarget.style.backgroundColor="transparent"}>
              <div style={{ overflow:"hidden" }}>
                <div style={{ color: path === rootPath ? "#0078d4" : "#cccccc", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {path.split(/[\\/]/).pop()}
                </div>
                <div style={{ color:"#555", fontSize:"11px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{path}</div>
              </div>
              <button onClick={(e) => removeRecent(e, path)}
                style={{ background:"none", border:"none", color:"#555", cursor:"pointer", fontSize:"14px", padding:"2px 4px", flexShrink:0 }}
                onMouseEnter={e => e.currentTarget.style.color="#f44747"}
                onMouseLeave={e => e.currentTarget.style.color="#555"}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Root label */}
      {rootPath && (
        <div style={{ padding:"4px 12px", fontSize:"11px", color:"#858585", borderBottom:"1px solid #3e3e42", textTransform:"uppercase", fontWeight:700, letterSpacing:"0.05em", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span>{rootPath.split(/[\\/]/).pop()}</span>
        </div>
      )}

      {/* Tree */}
      <div style={{ flex:1, overflowY:"auto" }}>
        {!rootPath && (
          <div style={{ padding:"24px 16px", textAlign:"center", color:"#858585", fontSize:"12px" }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ margin:"0 auto 12px", display:"block", opacity:0.4 }}>
              <path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
            </svg>
            <p style={{ marginBottom:"12px" }}>No folder open</p>
            <button onClick={onNewProject} style={{ display:"block", width:"100%", backgroundColor:"#0078d4", color:"#fff", border:"none", borderRadius:"3px", padding:"6px", cursor:"pointer", fontSize:"12px", marginBottom:"6px" }}>
              New Project
            </button>
            <button onClick={handleOpenFolder} style={{ display:"block", width:"100%", backgroundColor:"transparent", color:"#cccccc", border:"1px solid #555", borderRadius:"3px", padding:"6px", cursor:"pointer", fontSize:"12px", marginBottom:"6px" }}>
              Open Folder
            </button>
            {recent.length > 0 && (
              <button onClick={() => setShowRecent(s => !s)} style={{ display:"block", width:"100%", backgroundColor:"transparent", color:"#858585", border:"1px solid #3e3e42", borderRadius:"3px", padding:"6px", cursor:"pointer", fontSize:"12px" }}>
                Recent Projects ({recent.length})
              </button>
            )}
          </div>
        )}
        {loading && <div style={{ padding:"12px", textAlign:"center", color:"#858585", fontSize:"12px" }}>Loading...</div>}
        {error && <div style={{ padding:"12px", textAlign:"center", color:"#f44747", fontSize:"12px" }}>{error}</div>}
        {!loading && !error && rootPath && (
          <TreeItems nodes={nodes} expanded={expanded} onToggle={toggleExpand} onOpenFile={onOpenFile} activeFilePath={activeFilePath} />
        )}
      </div>
    </div>
  );
}
