import React from "react";

const ChevronRight = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
);
const ChevronDown = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
);
const FolderIcon = ({ open }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={open ? "#dcb67a" : "none"} stroke={open ? "#dcb67a" : "#c09553"} strokeWidth="1.5">
    <path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
  </svg>
);
const FileIcon = ({ ext }) => {
  const color = {
    js: "#f1d05e", jsx: "#61dafb", ts: "#3178c6", tsx: "#61dafb",
    py: "#3572a5", json: "#cbcb41", html: "#e44d26", css: "#563d7c",
    md: "#519aba", yml: "#cb171e", yaml: "#cb171e", sh: "#89e051",
    rs: "#dea584", go: "#00acd7", java: "#b07219", rb: "#701516",
  }[ext] || "#858585";

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  );
};

export default function TreeItems({ nodes, expanded, onToggle, onOpenFile, activeFilePath }) {
  const visible = [];
  let idx = 0;
  while (idx < nodes.length) {
    const node = nodes[idx];
    if (node.depth === 0) {
      visible.push(node);
    } else {
      let show = true;
      let d = node.depth;
      for (let b = idx - 1; b >= 0; b--) {
        if (nodes[b].depth < d) {
          if (!expanded[nodes[b].path]) { show = false; break; }
          d = nodes[b].depth;
          if (d === 0) break;
        }
      }
      if (show) visible.push(node);
    }
    idx++;
  }

  return (
    <div data-testid="tree-items">
      {visible.map((node) => {
        const isDir = node.type === "directory";
        const isExp = expanded[node.path];
        const isActive = node.path === activeFilePath;
        const indent = node.depth * 12 + 8;
        const ext = node.name.split(".").pop().toLowerCase();

        return (
          <div
            key={node.path}
            data-testid={`tree-node-${node.name}`}
            onClick={() => isDir ? onToggle(node.path) : onOpenFile({ path: node.path, name: node.name })}
            style={{
              display: "flex", alignItems: "center", gap: "4px",
              paddingLeft: `${indent}px`, paddingRight: "8px",
              height: "22px", cursor: "pointer", userSelect: "none", fontSize: "13px",
              backgroundColor: isActive ? "#37373d" : "transparent",
              color: isActive ? "#ffffff" : "#cccccc",
            }}
            onMouseEnter={e => { if (!isActive) e.currentTarget.style.backgroundColor = "#2a2d2e"; }}
            onMouseLeave={e => { if (!isActive) e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <span style={{ width: "12px", flexShrink: 0, color: "#858585" }}>
              {isDir ? (isExp ? <ChevronDown /> : <ChevronRight />) : null}
            </span>
            <span style={{ flexShrink: 0 }}>
              {isDir ? <FolderIcon open={isExp} /> : <FileIcon ext={ext} />}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {node.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
