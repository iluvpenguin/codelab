import React, { useState, useEffect, useCallback } from "react";
import api from "../api";

const RefreshIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>;
const CommitIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>;

const sectionStyle = { padding: "8px 12px", borderBottom: "1px solid #3e3e42" };
const labelStyle = { fontSize: "11px", color: "#858585", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" };
const inputStyle = { width: "100%", backgroundColor: "#3c3c3c", border: "1px solid #555", borderRadius: "3px", color: "#cccccc", padding: "5px 8px", fontSize: "12px", outline: "none", boxSizing: "border-box" };
const btnPrimary = { width: "100%", backgroundColor: "#0078d4", border: "none", borderRadius: "3px", color: "#fff", padding: "6px", cursor: "pointer", fontSize: "12px", display: "flex", alignItems: "center", justifyContent: "center", gap: "5px" };
const btnSecondary = { width: "100%", backgroundColor: "transparent", border: "1px solid #555", borderRadius: "3px", color: "#cccccc", padding: "5px", cursor: "pointer", fontSize: "12px" };

export default function GitPanel({ rootPath, branch, setBranch }) {
  const [status, setStatus] = useState(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    setError(null);
    try {
      const [s, b] = await Promise.all([
        api.get("/api/git/status", { params: { repo: rootPath } }),
        api.get("/api/git/branches", { params: { repo: rootPath } }),
      ]);
      setStatus(s.data);
      setBranches(b.data.branches || []);
      setBranch(b.data.active || "main");
    } catch {
      setError("Not a git repository");
    } finally {
      setLoading(false);
    }
  }, [rootPath, setBranch]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleCommit = async () => {
    if (!commitMsg.trim() || !status) return;
    const files = [
      ...status.staged.map(f => f.path),
      ...status.unstaged.map(f => f.path),
      ...status.untracked.map(f => f.path),
    ];
    try {
      await api.post("/api/git/commit", { repo: rootPath, message: commitMsg, files });
      setCommitMsg("");
      loadStatus();
    } catch (e) {
      setError("Commit failed: " + (e.response?.data?.detail || e.message));
    }
  };

  const changeType = { M: "#e2c08d", A: "#73c991", D: "#f44747", "?": "#858585" };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #3e3e42" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#bbbbbb" }}>Source Control</span>
        <button onClick={loadStatus} style={{ background: "none", border: "none", color: "#858585", cursor: "pointer", display: "flex" }}
          onMouseEnter={e => e.currentTarget.style.color = "#cccccc"} onMouseLeave={e => e.currentTarget.style.color = "#858585"}>
          <RefreshIcon />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {!rootPath && (
          <div style={{ padding: "20px 16px", textAlign: "center", color: "#858585", fontSize: "12px" }}>
            Open a folder to use Source Control
          </div>
        )}
        {error && <div style={{ padding: "12px", color: "#f44747", fontSize: "12px", borderBottom: "1px solid #3e3e42" }}>{error}</div>}
        {loading && <div style={{ padding: "12px", color: "#858585", fontSize: "12px" }}>Loading...</div>}

        {status && (
          <>
            {/* Branch */}
            <div style={sectionStyle}>
              <div style={labelStyle}>Branch</div>
              <select value={branch} onChange={e => api.post("/api/git/checkout", { repo: rootPath, branch: e.target.value }).then(() => { setBranch(e.target.value); loadStatus(); })}
                style={{ ...inputStyle, cursor: "pointer" }}>
                {branches.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>

            {/* Commit */}
            <div style={sectionStyle}>
              <div style={labelStyle}>Commit Message</div>
              <textarea value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
                placeholder="Message (Ctrl+Enter to commit)"
                rows={3} style={{ ...inputStyle, resize: "none", marginBottom: "6px" }} />
              <button onClick={handleCommit} disabled={!commitMsg.trim()} style={{ ...btnPrimary, opacity: commitMsg.trim() ? 1 : 0.5 }}>
                <CommitIcon /> Commit All
              </button>
            </div>

            {/* Push/Pull */}
            <div style={{ ...sectionStyle, display: "flex", gap: "6px" }}>
              <button onClick={() => api.post("/api/git/pull", { repo: rootPath }).then(loadStatus)} style={btnSecondary}>Pull</button>
              <button onClick={() => api.post("/api/git/push", { repo: rootPath, remote: "origin", branch }).then(loadStatus)} style={btnSecondary}>Push</button>
            </div>

            {/* Changes */}
            {[
              { label: "Staged", items: status.staged, color: "#73c991" },
              { label: "Changes", items: status.unstaged, color: "#e2c08d" },
              { label: "Untracked", items: status.untracked, color: "#858585" },
            ].filter(g => g.items.length > 0).map(({ label, items, color }) => (
              <div key={label}>
                <div style={{ padding: "6px 12px 2px", fontSize: "11px", color, fontWeight: 600 }}>
                  {label} ({items.length})
                </div>
                {items.map(f => (
                  <div key={f.path} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 12px 3px 20px", fontSize: "12px", color: "#cccccc" }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = "#2a2d2e"}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{f.path.split(/[\\/]/).pop()}</span>
                    <span style={{ color: changeType[f.change] || "#858585", marginLeft: "8px", flexShrink: 0, fontWeight: 700 }}>{f.change}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
