import React, { useState, useEffect } from "react";
import api from "../api";

const SETTINGS_KEY = "codelab_settings";

export function loadSettings() {
  try { return { fontSize: 14, tabSize: 2, theme: "vs-dark", minimap: true, wordWrap: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { fontSize: 14, tabSize: 2, theme: "vs-dark", minimap: true, wordWrap: false }; }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const TOUR_STEPS = [
  { icon: "📁", title: "Explorer", desc: "Browse and manage your project files. Click the folder icon or use the clock icon to switch between recent projects." },
  { icon: "📝", title: "Editor", desc: "Full Monaco editor with syntax highlighting for 20+ languages. Ctrl+S to save. Click the gutter (left margin) to add breakpoints." },
  { icon: "▶", title: "Run & Debug", desc: "Click Run or press F5 to run the current file. Use the dropdown to choose which file to run. F6 for debug mode, Shift+F5 to stop." },
  { icon: "⬛", title: "Terminal", desc: "Built-in terminal at the bottom. Run shell commands, switch to the OUTPUT tab to see code output, PROBLEMS for errors." },
  { icon: "⎇", title: "Source Control", desc: "View git status, stage changes, commit with a message, and push/pull from the Source Control panel." },
  { icon: "🐙", title: "GitHub", desc: "Sign in with a Personal Access Token. Publish your project directly to GitHub, clone repos, and browse your repositories." },
  { icon: "👥", title: "Collaborate", desc: "Create or join a live coding session. Share the 6-character code with collaborators to edit together in real time." },
  { icon: "🤖", title: "AI Assistant", desc: "Ask anything about your code. The AI has context of the currently open file. Press Enter to send, Shift+Enter for new line." },
  { icon: "⚙", title: "Settings", desc: "Customize font size, tab size, minimap, word wrap, and manage your GitHub credentials from this panel." },
  { icon: "🕐", title: "Recent Projects", desc: "Click the clock icon in the Explorer header to quickly switch between recently opened projects." },
];

const sectionStyle = { marginBottom: "20px" };
const labelStyle = { fontSize: "12px", color: "#858585", marginBottom: "6px", display: "block" };
const inputStyle = { backgroundColor: "#3c3c3c", border: "1px solid #555", borderRadius: "3px", color: "#cccccc", padding: "5px 8px", fontSize: "13px", outline: "none" };

export default function SettingsPanel({ onClose }) {
  const [settings, setSettings] = useState(loadSettings);
  const [tab, setTab] = useState("general");
  const [githubStatus, setGithubStatus] = useState(null);
  const [tokenInput, setTokenInput] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [tourStep, setTourStep] = useState(0);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get("/api/github/auth/status").then(res => setGithubStatus(res.data)).catch(() => {});
  }, []);

  const update = (key, value) => setSettings(s => ({ ...s, [key]: value }));

  const handleSave = () => {
    saveSettings(settings);
    window.__applySettings && window.__applySettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleGitHubLogin = async () => {
    if (!tokenInput.trim()) return;
    setLoginLoading(true); setLoginError(null);
    try {
      const res = await api.post("/api/github/auth/login", { token: tokenInput.trim() });
      setGithubStatus({ authenticated: true, user: res.data.user });
      setTokenInput("");
    } catch (e) {
      setLoginError(e.response?.data?.detail || "Invalid token");
    } finally { setLoginLoading(false); }
  };

  const handleGitHubLogout = async () => {
    await api.post("/api/github/auth/logout");
    setGithubStatus({ authenticated: false });
  };

  const tabStyle = (isActive) => ({
    padding: "8px 16px", cursor: "pointer", fontSize: "13px", border: "none", background: "none",
    color: isActive ? "#ffffff" : "#858585",
    borderBottom: isActive ? "2px solid #0078d4" : "2px solid transparent",
  });

  return (
    <div style={{ position:"fixed", inset:0, backgroundColor:"rgba(0,0,0,0.7)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:2000 }}>
      <div style={{ backgroundColor:"#252526", border:"1px solid #3e3e42", borderRadius:"6px", width:"620px", maxHeight:"80vh", display:"flex", flexDirection:"column", overflow:"hidden" }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 20px", borderBottom:"1px solid #3e3e42" }}>
          <h2 style={{ margin:0, fontSize:"16px", fontWeight:600, color:"#ffffff" }}>Settings</h2>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#858585", cursor:"pointer", fontSize:"18px" }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display:"flex", borderBottom:"1px solid #3e3e42", backgroundColor:"#1e1e1e" }}>
          {["general","credentials","tutorial"].map(t => (
            <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
              {t === "general" ? "⚙ General" : t === "credentials" ? "🔑 Credentials" : "📖 Tutorial"}
            </button>
          ))}
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"20px" }}>
          {/* GENERAL */}
          {tab === "general" && (
            <>
              <div style={sectionStyle}>
                <h3 style={{ margin:"0 0 12px", fontSize:"13px", color:"#cccccc", textTransform:"uppercase", letterSpacing:"0.08em" }}>Editor</h3>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px" }}>
                  <div>
                    <label style={labelStyle}>Font Size: {settings.fontSize}px</label>
                    <input type="range" min="10" max="24" value={settings.fontSize}
                      onChange={e => update("fontSize", Number(e.target.value))}
                      style={{ width:"100%", accentColor:"#0078d4" }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Tab Size</label>
                    <select value={settings.tabSize} onChange={e => update("tabSize", Number(e.target.value))}
                      style={{ ...inputStyle, width:"100%", cursor:"pointer" }}>
                      {[2,4,8].map(n => <option key={n} value={n}>{n} spaces</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Theme</label>
                    <select value={settings.theme} onChange={e => update("theme", e.target.value)}
                      style={{ ...inputStyle, width:"100%", cursor:"pointer" }}>
                      <option value="vs-dark">Dark (default)</option>
                      <option value="vs">Light</option>
                      <option value="hc-black">High Contrast</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Word Wrap</label>
                    <select value={settings.wordWrap ? "on" : "off"} onChange={e => update("wordWrap", e.target.value === "on")}
                      style={{ ...inputStyle, width:"100%", cursor:"pointer" }}>
                      <option value="off">Off</option>
                      <option value="on">On</option>
                    </select>
                  </div>
                </div>
                <div style={{ marginTop:"12px", display:"flex", gap:"16px" }}>
                  <label style={{ display:"flex", alignItems:"center", gap:"6px", fontSize:"12px", color:"#cccccc", cursor:"pointer" }}>
                    <input type="checkbox" checked={settings.minimap} onChange={e => update("minimap", e.target.checked)} style={{ accentColor:"#0078d4" }} />
                    Show Minimap
                  </label>
                </div>
              </div>

              <div style={{ display:"flex", justifyContent:"flex-end", gap:"10px", paddingTop:"12px", borderTop:"1px solid #3e3e42" }}>
                <button onClick={onClose} style={{ backgroundColor:"transparent", border:"1px solid #555", borderRadius:"4px", color:"#cccccc", padding:"6px 16px", cursor:"pointer", fontSize:"13px" }}>Cancel</button>
                <button onClick={handleSave} style={{ backgroundColor: saved ? "#73c991" : "#0078d4", border:"none", borderRadius:"4px", color:"#fff", padding:"6px 16px", cursor:"pointer", fontSize:"13px" }}>
                  {saved ? "Saved!" : "Save Settings"}
                </button>
              </div>
            </>
          )}

          {/* CREDENTIALS */}
          {tab === "credentials" && (
            <>
              <div style={sectionStyle}>
                <h3 style={{ margin:"0 0 12px", fontSize:"13px", color:"#cccccc", textTransform:"uppercase", letterSpacing:"0.08em" }}>GitHub Account</h3>
                {githubStatus?.authenticated ? (
                  <div>
                    <div style={{ display:"flex", alignItems:"center", gap:"10px", padding:"12px", backgroundColor:"#1e1e1e", borderRadius:"4px", marginBottom:"12px" }}>
                      <img src={githubStatus.user?.avatar_url} alt="" style={{ width:"40px", height:"40px", borderRadius:"50%" }} />
                      <div>
                        <div style={{ fontSize:"13px", color:"#cccccc", fontWeight:500 }}>{githubStatus.user?.name || githubStatus.user?.login}</div>
                        <div style={{ fontSize:"11px", color:"#858585" }}>@{githubStatus.user?.login}</div>
                        {githubStatus.user?.email && <div style={{ fontSize:"11px", color:"#858585" }}>{githubStatus.user.email}</div>}
                      </div>
                      <div style={{ marginLeft:"auto" }}>
                        <span style={{ backgroundColor:"#73c99120", color:"#73c991", fontSize:"11px", padding:"2px 8px", borderRadius:"10px", border:"1px solid #73c99150" }}>Connected</span>
                      </div>
                    </div>
                    <button onClick={handleGitHubLogout}
                      style={{ backgroundColor:"transparent", border:"1px solid #f44747", borderRadius:"3px", color:"#f44747", padding:"7px 16px", cursor:"pointer", fontSize:"12px", width:"100%" }}>
                      Sign Out / Switch Account
                    </button>
                  </div>
                ) : (
                  <div>
                    <p style={{ fontSize:"12px", color:"#858585", marginBottom:"12px", lineHeight:"1.6" }}>
                      Connect your GitHub account to publish projects, clone repos, and manage your repositories directly from CodeLab.
                    </p>
                    <label style={labelStyle}>Personal Access Token</label>
                    <input type="password" value={tokenInput} onChange={e => setTokenInput(e.target.value)}
                      placeholder="ghp_..." style={{ ...inputStyle, width:"100%", marginBottom:"8px", boxSizing:"border-box" }}
                      onKeyDown={e => e.key === "Enter" && handleGitHubLogin()} />
                    <button onClick={handleGitHubLogin} disabled={!tokenInput.trim() || loginLoading}
                      style={{ backgroundColor: !tokenInput.trim() || loginLoading ? "#555" : "#0078d4", border:"none", borderRadius:"3px", color:"#fff", padding:"7px", cursor: !tokenInput.trim() || loginLoading ? "default" : "pointer", fontSize:"12px", width:"100%" }}>
                      {loginLoading ? "Connecting..." : "Connect GitHub Account"}
                    </button>
                    {loginError && <div style={{ color:"#f44747", fontSize:"11px", marginTop:"6px" }}>{loginError}</div>}
                    <div style={{ marginTop:"10px", fontSize:"11px", color:"#555", lineHeight:"1.6" }}>
                      Generate a token at github.com/settings/tokens with <strong>repo</strong> and <strong>read:user</strong> scopes. Your token is stored locally and never sent anywhere except GitHub's API.
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* TUTORIAL */}
          {tab === "tutorial" && (
            <>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"16px" }}>
                <h3 style={{ margin:0, fontSize:"13px", color:"#cccccc", textTransform:"uppercase", letterSpacing:"0.08em" }}>Feature Tour</h3>
                <span style={{ fontSize:"12px", color:"#858585" }}>{tourStep + 1} / {TOUR_STEPS.length}</span>
              </div>

              {/* Progress bar */}
              <div style={{ height:"3px", backgroundColor:"#3e3e42", borderRadius:"2px", marginBottom:"20px" }}>
                <div style={{ height:"100%", backgroundColor:"#0078d4", borderRadius:"2px", width:`${((tourStep + 1) / TOUR_STEPS.length) * 100}%`, transition:"width 0.3s" }} />
              </div>

              {/* Current step */}
              <div style={{ backgroundColor:"#1e1e1e", borderRadius:"6px", padding:"20px", marginBottom:"16px", border:"1px solid #3e3e42" }}>
                <div style={{ fontSize:"32px", marginBottom:"10px" }}>{TOUR_STEPS[tourStep].icon}</div>
                <h4 style={{ margin:"0 0 10px", fontSize:"16px", color:"#ffffff" }}>{TOUR_STEPS[tourStep].title}</h4>
                <p style={{ margin:0, fontSize:"13px", color:"#cccccc", lineHeight:"1.7" }}>{TOUR_STEPS[tourStep].desc}</p>
              </div>

              {/* All steps overview */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"6px", marginBottom:"16px" }}>
                {TOUR_STEPS.map((step, i) => (
                  <div key={i} onClick={() => setTourStep(i)}
                    style={{ display:"flex", alignItems:"center", gap:"8px", padding:"6px 10px", borderRadius:"4px", cursor:"pointer", backgroundColor: i === tourStep ? "#0078d420" : "transparent", border: i === tourStep ? "1px solid #0078d450" : "1px solid transparent" }}
                    onMouseEnter={e => { if (i !== tourStep) e.currentTarget.style.backgroundColor="#2a2d2e"; }}
                    onMouseLeave={e => { if (i !== tourStep) e.currentTarget.style.backgroundColor="transparent"; }}>
                    <span style={{ fontSize:"16px" }}>{step.icon}</span>
                    <span style={{ fontSize:"12px", color: i === tourStep ? "#ffffff" : "#858585" }}>{step.title}</span>
                  </div>
                ))}
              </div>

              {/* Navigation */}
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <button onClick={() => setTourStep(s => Math.max(0, s - 1))} disabled={tourStep === 0}
                  style={{ backgroundColor:"transparent", border:"1px solid #555", borderRadius:"4px", color: tourStep === 0 ? "#555" : "#cccccc", padding:"6px 16px", cursor: tourStep === 0 ? "default" : "pointer", fontSize:"13px" }}>
                  ← Previous
                </button>
                {tourStep < TOUR_STEPS.length - 1 ? (
                  <button onClick={() => setTourStep(s => s + 1)}
                    style={{ backgroundColor:"#0078d4", border:"none", borderRadius:"4px", color:"#fff", padding:"6px 16px", cursor:"pointer", fontSize:"13px" }}>
                    Next →
                  </button>
                ) : (
                  <button onClick={onClose}
                    style={{ backgroundColor:"#73c991", border:"none", borderRadius:"4px", color:"#fff", padding:"6px 16px", cursor:"pointer", fontSize:"13px" }}>
                    Done ✓
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
