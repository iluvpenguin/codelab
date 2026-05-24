import React from "react";

const MinIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4.5" width="10" height="1" fill="currentColor"/></svg>
);
const MaxIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
);
const CloseIcon = () => (
  <svg width="10" height="10" viewBox="0 0 10 10">
    <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/>
    <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/>
  </svg>
);

export default function TitleBar() {
  const isElectron = !!(window.electronAPI);

  if (!isElectron) return null;

  const btnStyle = (hoverBg, hoverColor = "#ffffff") => ({
    width: "46px",
    height: "30px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "#cccccc",
    cursor: "pointer",
    flexShrink: 0,
    WebkitAppRegion: "no-drag",
    transition: "background 0.1s",
  });

  return (
    <div style={{
      height: "30px",
      backgroundColor: "#252526",
      display: "flex",
      alignItems: "center",
      flexShrink: 0,
      WebkitAppRegion: "drag",
      userSelect: "none",
      borderBottom: "1px solid #1a1a1a",
      position: "relative",
      zIndex: 1000,
    }}>
      {/* App title */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", paddingLeft: "12px" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0078d4" strokeWidth="2" style={{ marginRight: "6px" }}>
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>
        <span style={{ fontSize: "12px", color: "#858585" }}>CodeLab</span>
      </div>

      {/* Window controls */}
      <div style={{ display: "flex", WebkitAppRegion: "no-drag" }}>
        <button
          style={btnStyle("#3e3e42")}
          onClick={() => window.electronAPI.minimize()}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = "#3e3e42"}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
          title="Minimize"
        >
          <MinIcon />
        </button>
        <button
          style={btnStyle("#3e3e42")}
          onClick={() => window.electronAPI.maximize()}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = "#3e3e42"}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
          title="Maximize"
        >
          <MaxIcon />
        </button>
        <button
          style={btnStyle("#e81123")}
          onClick={() => window.electronAPI.close()}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = "#e81123"; e.currentTarget.style.color = "#ffffff"; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = "transparent"; e.currentTarget.style.color = "#cccccc"; }}
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
