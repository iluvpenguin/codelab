import React, { useCallback, useRef, useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import api, { BACKEND_URL } from "../api";
import { colorForName } from "./CollabPanel";

const RUNNABLE_EXTS = new Set(["py","js","ts","rb","php","go","java","sh","bat","c","cpp","rs","kt","r","swift","cs"]);

function getLanguage(filename) {
  if (!filename) return "plaintext";
  const ext = filename.split(".").pop().toLowerCase();
  const map = {
    js:"javascript",jsx:"javascript",ts:"typescript",tsx:"typescript",
    py:"python",json:"json",html:"html",css:"css",scss:"scss",
    md:"markdown",yaml:"yaml",yml:"yaml",xml:"xml",sh:"shell",
    bat:"bat",c:"c",cpp:"cpp",cs:"csharp",java:"java",
    go:"go",rs:"rust",php:"php",rb:"ruby",swift:"swift",
    kt:"kotlin",r:"r",sql:"sql",toml:"ini",env:"ini",
  };
  return map[ext] || "plaintext";
}

function isRunnable(filename) {
  if (!filename) return false;
  return RUNNABLE_EXTS.has(filename.split(".").pop().toLowerCase());
}

function getRunCommand(filename, filePath) {
  if (!filename) return null;
  const ext = filename.split(".").pop().toLowerCase();
  const map = {
    py:`python "${filePath}"`,js:`node "${filePath}"`,ts:`npx ts-node "${filePath}"`,
    rb:`ruby "${filePath}"`,php:`php "${filePath}"`,go:`go run "${filePath}"`,
    java:`javac "${filePath}" && java ${filename.replace(".java","")}`,
    sh:`bash "${filePath}"`,bat:`"${filePath}"`,
    c:`gcc "${filePath}" -o out && out`,cpp:`g++ "${filePath}" -o out && out`,
    cs:`dotnet-script "${filePath}"`,rs:`rustc "${filePath}" -o out && out`,
    kt:`kotlinc "${filePath}" -include-runtime -d out.jar && java -jar out.jar`,
  };
  return map[ext] || null;
}

function getDebugCommand(filename, filePath) {
  if (!filename) return null;
  const ext = filename.split(".").pop().toLowerCase();
  const map = { py:`python -m pdb "${filePath}"`, js:`node --inspect-brk "${filePath}"` };
  return map[ext] || null;
}

function cssName(name) {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

const CloseIcon  = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
const RunIcon    = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>;
const DebugIcon  = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>;
const StopIcon   = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>;
const ChevronDown = () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>;

export default function EditorPane({
  openFiles, activeFile, setActiveFile,
  onCloseFile, onUpdateContent, onMarkSaved,
  onCursorChange, onLanguageChange,
  onNewProject, onOpenFolder, onRunOutput,
  // collab
  collabSend, collabConnected, collabEdit,
  collabCursors, collabParticipants, collabMyName,
}) {
  const editorRef    = useRef(null);
  const monacoRef    = useRef(null);
  const isSyncingRef = useRef(false);
  const cursorTimer  = useRef(null);
  const bpDecorRef   = useRef([]);
  const collabDecRef = useRef([]);

  // Stable refs so stale closures inside Monaco handlers always read fresh values
  const collabSendRef      = useRef(collabSend);
  const collabConnectedRef = useRef(collabConnected);
  const activeFileRef      = useRef(activeFile);
  collabSendRef.current      = collabSend;
  collabConnectedRef.current = collabConnected;
  activeFileRef.current      = activeFile;

  const [running, setRunning]             = useState(false);
  const [breakpoints, setBreakpoints]     = useState({});
  const [selectedRunFile, setSelectedRunFile] = useState(null);
  const [showRunDropdown, setShowRunDropdown] = useState(false);

  const activeFileObj  = openFiles.find((f) => f.path === activeFile);
  const runnableFiles  = openFiles.filter(f => isRunnable(f.name));
  const runTarget      = selectedRunFile
    ? openFiles.find(f => f.path === selectedRunFile) || runnableFiles[0]
    : (isRunnable(activeFileObj?.name) ? activeFileObj : runnableFiles[0]);

  // ── Load file content on tab switch ──────────────────────────────────────────
  useEffect(() => {
    if (!activeFileObj || (activeFileObj.content !== undefined && activeFileObj.content !== "")) return;
    api.get("/api/files/read", { params: { path: activeFileObj.path } })
      .then((res) => {
        onUpdateContent(activeFileObj.path, res.data.content);
        // Share newly loaded file with collab participants
        if (collabConnectedRef.current) {
          collabSendRef.current({ type: "open_file", path: activeFileObj.path, content: res.data.content });
        }
      })
      .catch(() => onUpdateContent(activeFileObj.path, ""));
  // eslint-disable-next-line
  }, [activeFile]);

  useEffect(() => {
    if (activeFileObj) onLanguageChange(getLanguage(activeFileObj.name));
  // eslint-disable-next-line
  }, [activeFile]);

  // ── Apply incoming remote edit ────────────────────────────────────────────────
  useEffect(() => {
    if (!collabEdit) return;
    const { path, content } = collabEdit;

    // Apply to Monaco directly when this is the active file (avoids re-mount flicker)
    if (path === activeFile && editorRef.current) {
      const model = editorRef.current.getModel();
      if (model && model.getValue() !== content) {
        isSyncingRef.current = true;
        model.setValue(content);
        isSyncingRef.current = false;
      }
    }
  // eslint-disable-next-line
  }, [collabEdit]);

  // ── Inject CSS for collab cursor colors ───────────────────────────────────────
  useEffect(() => {
    const id = "collab-cursor-styles";
    let el = document.getElementById(id);
    if (!el) { el = document.createElement("style"); el.id = id; document.head.appendChild(el); }

    const others = (collabParticipants || []).filter(p => p.name !== collabMyName);
    el.textContent = others.map(p => {
      const color = colorForName(p.name);
      const cn    = cssName(p.name);
      return `
        .cc-${cn} {
          border-left: 2px solid ${color} !important;
          margin-left: -1px;
        }
        .cc-${cn}::after {
          content: "${p.name.replace(/"/g, "'")}";
          position: absolute;
          top: -16px;
          left: -1px;
          background: ${color};
          color: #1e1e1e;
          font-size: 10px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 2px 2px 2px 0;
          white-space: nowrap;
          pointer-events: none;
          z-index: 100;
          line-height: 14px;
        }
      `;
    }).join("");
  }, [collabParticipants, collabMyName]);

  // ── Render collab cursors as Monaco decorations ───────────────────────────────
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const relevant = Object.entries(collabCursors || {})
      .filter(([name, c]) => c.path === activeFile && name !== collabMyName);

    const newDecs = relevant.map(([name, c]) => ({
      range: new monaco.Range(c.line, c.col, c.line, c.col + 1),
      options: {
        className: `cc-${cssName(name)}`,
        hoverMessage: { value: `**${name}**` },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));

    collabDecRef.current = editor.deltaDecorations(collabDecRef.current, newDecs);
  }, [collabCursors, activeFile, collabMyName]);

  // ── Breakpoint decorations ────────────────────────────────────────────────────
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const bps = breakpoints[activeFile] || new Set();
    const newDecs = Array.from(bps).map(line => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true, className: "breakpoint-line",
        glyphMarginClassName: "breakpoint-glyph",
        overviewRuler: { color: "#f44747", position: monaco.editor.OverviewRulerLane.Left },
      },
    }));
    bpDecorRef.current = editor.deltaDecorations(bpDecorRef.current, newDecs);
  // eslint-disable-next-line
  }, [breakpoints, activeFile]);

  // ── Run code ──────────────────────────────────────────────────────────────────
  const runCode = useCallback(async (debug = false) => {
    if (!runTarget) return;
    const cmd = debug ? getDebugCommand(runTarget.name, runTarget.path) : getRunCommand(runTarget.name, runTarget.path);
    if (!cmd) {
      onRunOutput && onRunOutput([{ type:"error", text:`Cannot run .${runTarget.name.split(".").pop()} files.` }]);
      return;
    }
    setRunning(true);
    // Show the header immediately so the terminal switches to the output tab.
    // We accumulate all lines and do a single final replacement so the terminal
    // never ends up showing only the footer separator (which would be filtered
    // out by Terminal, leaving "No output yet").
    const collected = [
      { type:"system", text:`▶ ${debug ? "Debug" : "Run"}: ${runTarget.name}` },
      { type:"system", text:"─".repeat(44) },
    ];
    onRunOutput && onRunOutput([...collected]);   // switch to output tab + show header
    try {
      const cwd = runTarget.path.split(/[\\/]/).slice(0,-1).join("\\");
      const res  = await fetch(`${BACKEND_URL()}/api/files/run`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ command: cmd, cwd }),
      });
      const text  = await res.text();
      const lines = text.split("\n").map(line => ({
        type: line.startsWith("[stderr]") || line.startsWith("[Error]") || line.startsWith("[Exit code:") ? "error" : "output",
        text: line,
      })).filter(l => l.text.trim() !== "");
      collected.push(...lines);
    } catch (e) {
      collected.push({ type:"error", text:`Error: ${e.message}` });
    } finally {
      setRunning(false);
      collected.push({ type:"system", text:"─".repeat(44) });
      onRunOutput && onRunOutput(collected);      // replace with full output (header + body + footer)
    }
  }, [runTarget, onRunOutput]);

  const stopCode = useCallback(() => {
    setRunning(false);
    onRunOutput && onRunOutput([{ type:"error", text:"■ Stopped" }]);
  }, [onRunOutput]);

  useEffect(() => {
    window.__runCode   = () => runCode(false);
    window.__debugCode = () => runCode(true);
    window.__stopCode  = stopCode;
  }, [runCode, stopCode]);

  // ── Monaco mount ──────────────────────────────────────────────────────────────
  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current    = editor;
    monacoRef.current    = monaco;
    bpDecorRef.current   = [];
    collabDecRef.current = [];

    editor.onDidChangeCursorPosition((e) => {
      onCursorChange({ line: e.position.lineNumber, col: e.position.column });
      // Send cursor position to collab participants (debounced)
      clearTimeout(cursorTimer.current);
      cursorTimer.current = setTimeout(() => {
        if (collabConnectedRef.current && activeFileRef.current) {
          collabSendRef.current({
            type: "cursor",
            path: activeFileRef.current,
            line: e.position.lineNumber,
            col:  e.position.column,
          });
        }
      }, 60);
    });

    editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
          e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
        const line = e.target.position?.lineNumber;
        if (!line) return;
        setBreakpoints(prev => {
          const cur = new Set(prev[activeFile] || []);
          if (cur.has(line)) cur.delete(line); else cur.add(line);
          return { ...prev, [activeFile]: cur };
        });
      }
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async () => {
      const file = openFiles.find((f) => f.path === activeFile);
      if (!file) return;
      try { await api.post("/api/files/write", { path: file.path, content: file.content }); onMarkSaved(file.path); }
      catch (e) { console.error("Save failed", e); }
    });
    editor.addCommand(monaco.KeyCode.F5, () => runCode(false));
    editor.addCommand(monaco.KeyCode.F6, () => runCode(true));
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F5, stopCode);
  // eslint-disable-next-line
  }, [activeFile, openFiles]);

  // ── Content change ────────────────────────────────────────────────────────────
  const handleChange = useCallback((value) => {
    if (!activeFile) return;
    onUpdateContent(activeFile, value || "");
    // Broadcast to collab participants (skip if this change came from a remote edit)
    if (!isSyncingRef.current && collabConnectedRef.current) {
      collabSendRef.current({ type: "edit", path: activeFile, content: value || "" });
    }
  // eslint-disable-next-line
  }, [activeFile]);

  // ── Empty state ───────────────────────────────────────────────────────────────
  if (openFiles.length === 0) {
    return (
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", backgroundColor:"#1e1e1e", color:"#858585", userSelect:"none" }}>
        <div style={{ marginBottom:"24px", opacity:0.12 }}>
          <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#cccccc" strokeWidth="0.8"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </div>
        <h1 style={{ fontSize:"24px", fontWeight:300, color:"#cccccc", marginBottom:"6px" }}>Welcome to CodeLab</h1>
        <p style={{ fontSize:"13px", color:"#858585", marginBottom:"32px" }}>A modern code editor for developers</p>
        <div style={{ display:"flex", flexDirection:"column", gap:"10px", width:"260px" }}>
          <button onClick={onNewProject} style={{ display:"flex", alignItems:"center", gap:"10px", backgroundColor:"#0078d4", border:"none", borderRadius:"4px", color:"#fff", padding:"10px 16px", cursor:"pointer", fontSize:"13px", fontWeight:500 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Create New Project
          </button>
          <button onClick={onOpenFolder} style={{ display:"flex", alignItems:"center", gap:"10px", backgroundColor:"transparent", border:"1px solid #3e3e42", borderRadius:"4px", color:"#cccccc", padding:"10px 16px", cursor:"pointer", fontSize:"13px" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>
            Open File / Folder
          </button>
        </div>
        <div style={{ marginTop:"40px", fontSize:"12px", color:"#444", textAlign:"center", lineHeight:"1.8" }}>
          <div>F5 — Run &nbsp;|&nbsp; F6 — Debug &nbsp;|&nbsp; Ctrl+S — Save</div>
          <div>Click gutter to toggle breakpoints</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden" }}>
      {/* Tabs + Run toolbar */}
      <div style={{ display:"flex", alignItems:"center", backgroundColor:"#252526", borderBottom:"1px solid #1e1e1e", flexShrink:0, height:"35px" }}>
        <div style={{ display:"flex", flex:1, overflowX:"auto", height:"100%" }}>
          {openFiles.map((file) => (
            <div key={file.path} onClick={() => setActiveFile(file.path)}
              style={{ display:"flex", alignItems:"center", gap:"6px", padding:"0 12px", cursor:"pointer", flexShrink:0, maxWidth:"180px", borderRight:"1px solid #1e1e1e", backgroundColor: file.path === activeFile ? "#1e1e1e" : "#2d2d2d", color: file.path === activeFile ? "#ffffff" : "#969696", borderTop: file.path === activeFile ? "1px solid #0078d4" : "1px solid transparent", fontSize:"13px", height:"100%" }}>
              {file.isDirty && <span style={{ color:"#e2c08d", fontSize:"8px" }}>●</span>}
              {breakpoints[file.path]?.size > 0 && <span style={{ color:"#f44747", fontSize:"8px" }}>⬤</span>}
              <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{file.name}</span>
              <button onClick={(e) => { e.stopPropagation(); onCloseFile(file.path); }}
                style={{ background:"none", border:"none", color:"#858585", cursor:"pointer", padding:"2px", display:"flex", alignItems:"center" }}
                onMouseEnter={e => e.currentTarget.style.color="#ffffff"}
                onMouseLeave={e => e.currentTarget.style.color="#858585"}>
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>

        {runnableFiles.length > 0 && (
          <div style={{ display:"flex", alignItems:"center", gap:"2px", padding:"0 6px", flexShrink:0, borderLeft:"1px solid #3e3e42" }}>
            <div style={{ position:"relative" }}>
              <button onClick={() => setShowRunDropdown(d => !d)}
                style={{ display:"flex", alignItems:"center", gap:"4px", background:"#2d2d2d", border:"1px solid #3e3e42", borderRadius:"3px", color:"#cccccc", cursor:"pointer", padding:"3px 8px", fontSize:"12px", maxWidth:"140px" }}>
                <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{runTarget?.name || "Select file"}</span>
                <ChevronDown />
              </button>
              {showRunDropdown && (
                <div style={{ position:"absolute", top:"100%", right:0, backgroundColor:"#2d2d2d", border:"1px solid #3e3e42", borderRadius:"3px", zIndex:100, minWidth:"180px", boxShadow:"0 4px 12px rgba(0,0,0,0.4)" }}>
                  {runnableFiles.map(f => (
                    <div key={f.path} onClick={() => { setSelectedRunFile(f.path); setShowRunDropdown(false); }}
                      style={{ padding:"6px 12px", cursor:"pointer", fontSize:"12px", color: runTarget?.path === f.path ? "#ffffff" : "#cccccc", backgroundColor: runTarget?.path === f.path ? "#0078d420" : "transparent", display:"flex", alignItems:"center", gap:"6px" }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor="#37373d"}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = runTarget?.path === f.path ? "#0078d420" : "transparent"}>
                      <span style={{ color:"#4ec9b0", fontSize:"10px" }}>{f.name.split(".").pop()}</span>
                      {f.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => { setShowRunDropdown(false); runCode(false); }} disabled={running} title="Run (F5)"
              style={{ display:"flex", alignItems:"center", gap:"5px", background:"none", border:"none", color: running ? "#555" : "#4ec9b0", cursor: running ? "default" : "pointer", padding:"4px 10px", fontSize:"12px", borderRadius:"3px" }}
              onMouseEnter={e => { if (!running) e.currentTarget.style.backgroundColor="#2a2d2e"; }}
              onMouseLeave={e => e.currentTarget.style.backgroundColor="transparent"}>
              <RunIcon /> Run
            </button>
            {runTarget && getDebugCommand(runTarget.name, runTarget.path) && (
              <button onClick={() => { setShowRunDropdown(false); runCode(true); }} disabled={running} title="Debug (F6)"
                style={{ display:"flex", alignItems:"center", gap:"5px", background:"none", border:"none", color: running ? "#555" : "#e2c08d", cursor: running ? "default" : "pointer", padding:"4px 10px", fontSize:"12px", borderRadius:"3px" }}
                onMouseEnter={e => { if (!running) e.currentTarget.style.backgroundColor="#2a2d2e"; }}
                onMouseLeave={e => e.currentTarget.style.backgroundColor="transparent"}>
                <DebugIcon /> Debug
              </button>
            )}
            {running && (
              <button onClick={stopCode} title="Stop (Shift+F5)"
                style={{ display:"flex", alignItems:"center", gap:"5px", background:"none", border:"none", color:"#f44747", cursor:"pointer", padding:"4px 10px", fontSize:"12px", borderRadius:"3px" }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor="#2a2d2e"}
                onMouseLeave={e => e.currentTarget.style.backgroundColor="transparent"}>
                <StopIcon /> Stop
              </button>
            )}
          </div>
        )}
      </div>

      {/* Monaco Editor */}
      <div style={{ flex:1, overflow:"hidden" }} onClick={() => setShowRunDropdown(false)}>
        {activeFileObj && (
          <Editor
            key={activeFileObj.path}
            height="100%"
            language={getLanguage(activeFileObj.name)}
            value={activeFileObj.content || ""}
            theme="vs-dark"
            onChange={handleChange}
            onMount={handleEditorMount}
            options={{
              fontSize:14, fontFamily:"Consolas, Monaco, 'Courier New', monospace",
              minimap:{ enabled:true }, wordWrap:"off", scrollBeyondLastLine:false,
              automaticLayout:true, tabSize:2, insertSpaces:true,
              renderWhitespace:"selection", guides:{ indentation:true },
              smoothScrolling:true, cursorBlinking:"smooth",
              lineNumbers:"on", folding:true, glyphMargin:true,
            }}
          />
        )}
      </div>

      <style>{`
        .breakpoint-line { background: rgba(244,71,71,0.12) !important; }
        .breakpoint-glyph::before { content:"●"; color:#f44747; font-size:14px; line-height:19px; }
      `}</style>
    </div>
  );
}
