import React, { useState, useRef, useEffect } from "react";
import { BACKEND_URL } from "../api";

export default function Terminal({ open, onToggle, height, rootPath, externalLines, setExternalLines, activeTab, setActiveTab }) {
  const [lines, setLines] = useState([{ type: "system", text: "CodeLab Terminal — ready" }]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const bottomRef = useRef(null);
  const outputBottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [lines]);
  useEffect(() => { outputBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [externalLines]);

  const runCommand = async (cmd) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    setHistory(h => [trimmed, ...h]);
    setHistIdx(-1);
    setLines(l => [...l, { type: "input", text: `$ ${trimmed}` }]);
    if (trimmed === "clear" || trimmed === "cls") {
      setLines([{ type: "system", text: "CodeLab Terminal — ready" }]);
      return;
    }
    try {
      const res = await fetch(`${BACKEND_URL()}/api/files/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, cwd: rootPath }),
      });
      const text = await res.text();
      text.split("\n").filter(Boolean).forEach(line => {
        setLines(l => [...l, { type: "output", text: line }]);
      });
    } catch (e) {
      setLines(l => [...l, { type: "error", text: `Error: ${e.message}` }]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { runCommand(input); setInput(""); }
    else if (e.key === "ArrowUp") { const idx = Math.min(histIdx + 1, history.length - 1); setHistIdx(idx); setInput(history[idx] || ""); }
    else if (e.key === "ArrowDown") { const idx = Math.max(histIdx - 1, -1); setHistIdx(idx); setInput(idx === -1 ? "" : history[idx]); }
  };

  const lineColor = (type) => {
    if (type === "input") return "#569cd6";
    if (type === "error") return "#f44747";
    if (type === "system") return "#4ec9b0";
    return "#cccccc";
  };

  // Only show output and error lines in OUTPUT tab
  const outputLines = (externalLines || []).filter(l => l.type === "output" || l.type === "error");
  const errorCount = outputLines.filter(l => l.type === "error").length;

  const tabStyle = (isActive) => ({
    background: "none", border: "none",
    color: isActive ? "#ffffff" : "#858585",
    fontSize: "12px", cursor: "pointer",
    padding: "0 14px", height: "100%",
    borderBottom: isActive ? "1px solid #0078d4" : "1px solid transparent",
    letterSpacing: "0.05em",
    display: "flex", alignItems: "center", gap: "5px",
  });

  return (
    <div style={{ backgroundColor: "#1e1e1e", borderTop: "1px solid #3e3e42", flexShrink: 0 }}>
      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", backgroundColor: "#252526", borderBottom: "1px solid #3e3e42", height: "35px" }}>
        <button style={tabStyle(activeTab === "terminal")} onClick={() => setActiveTab("terminal")}>TERMINAL</button>
        <button style={tabStyle(activeTab === "output")} onClick={() => setActiveTab("output")}>
          OUTPUT
          {errorCount > 0 && <span style={{ backgroundColor: "#f44747", color: "#fff", borderRadius: "10px", fontSize: "10px", padding: "0 5px", minWidth: "16px", textAlign: "center" }}>{errorCount}</span>}
        </button>
        <button style={tabStyle(activeTab === "problems")} onClick={() => setActiveTab("problems")}>PROBLEMS</button>
        <div style={{ flex: 1 }} />
        {activeTab === "output" && outputLines.length > 0 && (
          <button onClick={() => setExternalLines && setExternalLines([])} style={{ background: "none", border: "none", color: "#858585", cursor: "pointer", fontSize: "13px", padding: "0 8px" }} title="Clear output">✕</button>
        )}
        {activeTab === "terminal" && (
          <button onClick={() => setLines([{ type: "system", text: "CodeLab Terminal — ready" }])} style={{ background: "none", border: "none", color: "#858585", cursor: "pointer", fontSize: "13px", padding: "0 8px" }} title="Clear">✕</button>
        )}
        <button onClick={onToggle} style={{ background: "none", border: "none", color: "#858585", cursor: "pointer", fontSize: "16px", padding: "0 10px" }} title={open ? "Minimize" : "Expand"}>
          {open ? "⌄" : "⌃"}
        </button>
      </div>

      {open && (
        <div style={{ height: `${height}px`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* TERMINAL */}
          {activeTab === "terminal" && (
            <>
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontFamily: "Consolas, Monaco, monospace", fontSize: "13px" }}
                onClick={() => inputRef.current?.focus()}>
                {lines.map((line, i) => (
                  <div key={i} style={{ color: lineColor(line.type), lineHeight: "1.6", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line.text}</div>
                ))}
                <div ref={bottomRef} />
              </div>
              <div style={{ display: "flex", alignItems: "center", padding: "4px 12px", borderTop: "1px solid #3e3e42" }}>
                <span style={{ color: "#4ec9b0", fontFamily: "Consolas, monospace", fontSize: "13px", marginRight: "8px" }}>
                  {rootPath ? rootPath.split(/[\\/]/).pop() : "~"}$
                </span>
                <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#cccccc", fontFamily: "Consolas, monospace", fontSize: "13px" }}
                  autoFocus spellCheck={false} />
              </div>
            </>
          )}

          {/* OUTPUT */}
          {activeTab === "output" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontFamily: "Consolas, Monaco, monospace", fontSize: "13px" }}>
              {outputLines.length === 0 ? (
                <div style={{ color: "#555", fontStyle: "italic" }}>No output yet. Run a file with F5 or the Run button.</div>
              ) : outputLines.map((line, i) => (
                <div key={i} style={{ color: lineColor(line.type), lineHeight: "1.6", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line.text}</div>
              ))}
              <div ref={outputBottomRef} />
            </div>
          )}

          {/* PROBLEMS */}
          {activeTab === "problems" && (
            <div style={{ flex: 1, padding: "16px 12px", color: "#858585", fontSize: "13px", fontStyle: "italic" }}>
              No problems detected.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
