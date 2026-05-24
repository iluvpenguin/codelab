import React from "react";

export default function StatusBar({ branch, cursorPos, language, activeFile }) {
  const filename = activeFile ? activeFile.split(/[\\/]/).pop() : null;

  return (
    <div
      data-testid="status-bar"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: "22px",
        backgroundColor: "#007acc",
        color: "#ffffff",
        fontSize: "12px",
        padding: "0 10px",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <span data-testid="status-branch" style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
            <path d="M6 9v6M15.5 6.5 8.5 15.5M18 9V6a3 3 0 0 0-3-3h-2"/>
          </svg>
          {branch}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        {filename && <span data-testid="status-filename" style={{ opacity: 0.85 }}>{filename}</span>}
        <span data-testid="status-cursor">Ln {cursorPos.line}, Col {cursorPos.col}</span>
        <span data-testid="status-language" style={{ textTransform: "capitalize" }}>{language}</span>
      </div>
    </div>
  );
}
