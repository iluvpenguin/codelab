import React, { useState, useEffect } from "react";
import api from "../api";

const inputStyle = { width:"100%", backgroundColor:"#3c3c3c", border:"1px solid #555", borderRadius:"3px", color:"#cccccc", padding:"5px 8px", fontSize:"12px", outline:"none", boxSizing:"border-box" };
const labelStyle = { fontSize:"11px", color:"#858585", marginBottom:"4px", textTransform:"uppercase", letterSpacing:"0.08em", display:"block" };
const sectionStyle = { padding:"10px 12px", borderBottom:"1px solid #3e3e42" };
const btnPrimary = (disabled) => ({ width:"100%", backgroundColor: disabled ? "#555" : "#0078d4", border:"none", borderRadius:"3px", color:"#fff", padding:"7px", cursor: disabled ? "default" : "pointer", fontSize:"12px", marginTop:"6px" });
const btnSecondary = { width:"100%", backgroundColor:"transparent", border:"1px solid #555", borderRadius:"3px", color:"#cccccc", padding:"6px", cursor:"pointer", fontSize:"12px", marginTop:"6px" };
const btnDanger = { width:"100%", backgroundColor:"transparent", border:"1px solid #f44747", borderRadius:"3px", color:"#f44747", padding:"6px", cursor:"pointer", fontSize:"12px", marginTop:"6px" };

export default function GitHubPanel({ onOpenFile, rootPath }) {
  const [token, setToken] = useState("");
  const [user, setUser] = useState(null);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDest, setCloneDest] = useState(rootPath || "");
  const [cloning, setCloning] = useState(false);
  const [cloneMsg, setCloneMsg] = useState(null);
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [repoDesc, setRepoDesc] = useState("");
  const [repoPrivate, setRepoPrivate] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushMsg, setPushMsg] = useState(null);
  const [tokenInput, setTokenInput] = useState("");

  // Check saved auth on mount
  useEffect(() => {
    api.get("/api/github/auth/status").then(res => {
      if (res.data.authenticated) {
        setUser(res.data.user);
        setToken(res.data.token);
        loadRepos(res.data.token);
      }
    }).catch(() => {});
  }, []);

  const loadRepos = async (t) => {
    try {
      const res = await api.get("/api/github/repos", { params: { token: t } });
      setRepos(Array.isArray(res.data.repos) ? res.data.repos : []);
    } catch {
      setRepos([]);
    }
  };

  const handleLogin = async () => {
    if (!tokenInput.trim()) return;
    setLoading(true); setError(null);
    try {
      const res = await api.post("/api/github/auth/login", { token: tokenInput.trim() });
      setUser(res.data.user);
      setToken(tokenInput.trim());
      setTokenInput("");
      await loadRepos(tokenInput.trim());
    } catch (e) {
      setError(e.response?.data?.detail || "Invalid token. Generate one at github.com/settings/tokens");
    } finally { setLoading(false); }
  };

  const handleLogout = async () => {
    await api.post("/api/github/auth/logout");
    setUser(null); setToken(""); setRepos([]);
  };

  const handleClone = async () => {
    if (!cloneUrl || !cloneDest) return;
    setCloning(true); setCloneMsg(null);
    try {
      await api.get("/api/github/clone", { params: { url: cloneUrl, dest: cloneDest, token } });
      setCloneMsg({ ok: true, text: "Cloned successfully!" });
    } catch (e) {
      setCloneMsg({ ok: false, text: "Clone failed: " + (e.response?.data?.detail || e.message) });
    } finally { setCloning(false); }
  };

  const handleCreateAndPush = async () => {
    if (!repoName.trim() || !rootPath) return;
    setPushing(true); setPushMsg(null);
    try {
      const res = await api.post("/api/github/repo/create-and-push", {
        token, name: repoName.trim(), description: repoDesc, private: repoPrivate, local_path: rootPath,
      });
      setPushMsg({ ok: true, text: `Published! View at ${res.data.repo_url}` });
      setShowCreateRepo(false);
      await loadRepos(token);
    } catch (e) {
      setPushMsg({ ok: false, text: e.response?.data?.detail || "Failed to publish" });
    } finally { setPushing(false); }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      <div style={{ padding:"8px 12px", borderBottom:"1px solid #3e3e42" }}>
        <span style={{ fontSize:"11px", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:"#bbbbbb" }}>GitHub</span>
      </div>

      <div style={{ flex:1, overflowY:"auto" }}>
        {/* Not logged in */}
        {!user && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Personal Access Token</label>
            <input type="password" value={tokenInput} onChange={e => setTokenInput(e.target.value)}
              placeholder="ghp_..." style={inputStyle}
              onKeyDown={e => e.key === "Enter" && handleLogin()} />
            <button onClick={handleLogin} disabled={!tokenInput.trim() || loading}
              style={btnPrimary(!tokenInput.trim() || loading)}>
              {loading ? "Connecting..." : "Sign in to GitHub"}
            </button>
            {error && <div style={{ color:"#f44747", fontSize:"11px", marginTop:"6px" }}>{error}</div>}
            <div style={{ marginTop:"8px", fontSize:"11px", color:"#555" }}>
              Generate a token at{" "}
              <span style={{ color:"#0078d4", cursor:"pointer" }}
                onClick={() => window.electronAPI?.openExternal("https://github.com/settings/tokens/new?scopes=repo,read:user")}>
                github.com/settings/tokens
              </span>
              {" "}with <code style={{ backgroundColor:"#3c3c3c", padding:"1px 4px", borderRadius:"2px" }}>repo</code> scope.
            </div>
          </div>
        )}

        {/* Logged in */}
        {user && (
          <>
            {/* User card */}
            <div style={{ ...sectionStyle, display:"flex", alignItems:"center", gap:"10px" }}>
              <img src={user.avatar_url} alt="" style={{ width:"36px", height:"36px", borderRadius:"50%", flexShrink:0 }} />
              <div style={{ flex:1, overflow:"hidden" }}>
                <div style={{ fontSize:"13px", color:"#cccccc", fontWeight:500 }}>{user.name || user.login}</div>
                <div style={{ fontSize:"11px", color:"#858585" }}>@{user.login}</div>
                {user.email && <div style={{ fontSize:"11px", color:"#858585" }}>{user.email}</div>}
              </div>
            </div>

            {/* Actions */}
            <div style={sectionStyle}>
              {rootPath && (
                <>
                  <button onClick={() => setShowCreateRepo(s => !s)} style={btnSecondary}>
                    {showCreateRepo ? "Cancel" : "⬆ Publish Project to GitHub"}
                  </button>
                  {showCreateRepo && (
                    <div style={{ marginTop:"10px" }}>
                      <label style={labelStyle}>Repository Name</label>
                      <input value={repoName} onChange={e => setRepoName(e.target.value)}
                        placeholder={rootPath.split(/[\\/]/).pop()}
                        style={{ ...inputStyle, marginBottom:"6px" }} />
                      <label style={labelStyle}>Description (optional)</label>
                      <input value={repoDesc} onChange={e => setRepoDesc(e.target.value)}
                        placeholder="My awesome project" style={{ ...inputStyle, marginBottom:"6px" }} />
                      <label style={{ display:"flex", alignItems:"center", gap:"6px", fontSize:"12px", color:"#cccccc", cursor:"pointer", marginBottom:"8px" }}>
                        <input type="checkbox" checked={repoPrivate} onChange={e => setRepoPrivate(e.target.checked)} />
                        Private repository
                      </label>
                      <button onClick={handleCreateAndPush} disabled={!repoName.trim() || pushing}
                        style={btnPrimary(!repoName.trim() || pushing)}>
                        {pushing ? "Publishing..." : "Create & Push"}
                      </button>
                      {pushMsg && <div style={{ fontSize:"11px", marginTop:"6px", color: pushMsg.ok ? "#73c991" : "#f44747" }}>{pushMsg.text}</div>}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Clone */}
            <div style={sectionStyle}>
              <label style={labelStyle}>Clone Repository</label>
              <input value={cloneUrl} onChange={e => setCloneUrl(e.target.value)}
                placeholder="https://github.com/user/repo" style={{ ...inputStyle, marginBottom:"6px" }} />
              <input value={cloneDest} onChange={e => setCloneDest(e.target.value)}
                placeholder="Destination path" style={inputStyle} />
              <button onClick={handleClone} disabled={!cloneUrl || !cloneDest || cloning}
                style={btnPrimary(!cloneUrl || !cloneDest || cloning)}>
                {cloning ? "Cloning..." : "Clone"}
              </button>
              {cloneMsg && <div style={{ fontSize:"11px", marginTop:"6px", color: cloneMsg.ok ? "#73c991" : "#f44747" }}>{cloneMsg.text}</div>}
            </div>

            {/* Repos */}
            {repos.length > 0 && (
              <div>
                <div style={{ padding:"8px 12px 4px", fontSize:"11px", color:"#858585", textTransform:"uppercase", letterSpacing:"0.08em" }}>
                  Your Repositories ({repos.length})
                </div>
                {repos.map(repo => (
                  <div key={repo.full_name} onClick={() => setCloneUrl(repo.clone_url)}
                    style={{ padding:"8px 12px", borderBottom:"1px solid #2a2a2a", cursor:"pointer" }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor="#2a2d2e"}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor="transparent"}>
                    <div style={{ display:"flex", alignItems:"center", gap:"6px", marginBottom:"2px" }}>
                      <span style={{ fontSize:"12px", color:"#cccccc", fontWeight:500 }}>{repo.name}</span>
                      {repo.private && <span style={{ fontSize:"10px", color:"#858585", border:"1px solid #555", borderRadius:"10px", padding:"0 4px" }}>private</span>}
                    </div>
                    {repo.description && <div style={{ fontSize:"11px", color:"#858585", marginBottom:"4px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{repo.description}</div>}
                    <div style={{ display:"flex", gap:"10px", fontSize:"11px", color:"#858585" }}>
                      {repo.language && <span style={{ color:"#4ec9b0" }}>{repo.language}</span>}
                      <span>★ {repo.stars}</span>
                      <span>⑂ {repo.forks}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Sign out / switch */}
            <div style={sectionStyle}>
              <button onClick={handleLogout} style={btnDanger}>Sign Out / Switch Account</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
