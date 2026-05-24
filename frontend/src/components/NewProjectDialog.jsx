import React, { useState } from "react";
import api from "../api";

const TEMPLATES = [
  { id: "blank", label: "Blank Project", desc: "Empty folder, start from scratch", files: [] },
  { id: "python", label: "Python App", desc: "main.py + requirements.txt", files: [
    { name: "main.py", content: '# Python App\n\ndef main():\n    print("Hello, CodeLab!")\n\nif __name__ == "__main__":\n    main()\n' },
    { name: "requirements.txt", content: "# Add your dependencies here\n" },
    { name: "README.md", content: "# My Python App\n\nCreated with CodeLab.\n" },
  ]},
  { id: "web", label: "Web App", desc: "HTML + CSS + JS starter", files: [
    { name: "index.html", content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>My Web App</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello, CodeLab!</h1>\n  <script src="app.js"></script>\n</body>\n</html>\n' },
    { name: "style.css", content: "body {\n  font-family: sans-serif;\n  margin: 40px auto;\n  max-width: 800px;\n  padding: 0 20px;\n}\n" },
    { name: "app.js", content: 'console.log("Hello from CodeLab!");\n' },
  ]},
  { id: "node", label: "Node.js App", desc: "index.js + package.json", files: [
    { name: "index.js", content: 'const http = require("http");\nconst server = http.createServer((req, res) => {\n  res.end("Hello from CodeLab!\\n");\n});\nserver.listen(3000, () => console.log("Server on port 3000"));\n' },
    { name: "package.json", content: '{\n  "name": "my-node-app",\n  "version": "1.0.0",\n  "main": "index.js",\n  "scripts": { "start": "node index.js" }\n}\n' },
    { name: "README.md", content: "# My Node.js App\n\nRun: `node index.js`\n" },
  ]},
];

export default function NewProjectDialog({ onClose, onCreated }) {
  const [name, setName] = useState("my-project");
  const [location, setLocation] = useState("");
  const [template, setTemplate] = useState("blank");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const pickLocation = async () => {
    if (window.electronAPI?.openFolder) {
      const path = await window.electronAPI.openFolder();
      if (path) setLocation(path);
    } else {
      const path = window.prompt("Enter parent directory path (e.g. H:\\Projects):");
      if (path) setLocation(path);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Please enter a project name.");
      return;
    }
    if (!location.trim()) {
      setError("Please choose a location folder. Click Browse.");
      return;
    }
    const loc = location.trim().replace(/[/\\]+$/, "");
    // Block drive root (e.g. "H:" or "C:")
    if (/^[A-Za-z]:$/.test(loc)) {
      setError("Cannot create a project on a drive root. Pick a subfolder like H:\\Projects.");
      return;
    }
    const safeName = name.trim().replace(/[<>:"/\\|?*]/g, "_");
    const sep = loc.includes("/") ? "/" : "\\";
    const projectPath = loc + sep + safeName;

    setCreating(true);
    setError(null);
    try {
      await api.post("/api/files/mkdir", { path: projectPath });
      const tpl = TEMPLATES.find(t => t.id === template);
      for (const file of tpl.files) {
        await api.post("/api/files/write", { path: projectPath + sep + file.name, content: file.content });
      }
      onCreated(projectPath);
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to create project. Check the path and permissions.");
    } finally {
      setCreating(false);
    }
  };

  const s = {
    input: { width: "100%", backgroundColor: "#3c3c3c", border: "1px solid #555", borderRadius: "4px", color: "#cccccc", padding: "6px 10px", fontSize: "13px", outline: "none", boxSizing: "border-box" },
    label: { display: "block", fontSize: "12px", color: "#858585", marginBottom: "4px" },
    row: { marginBottom: "14px" },
  };

  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ backgroundColor: "#252526", border: "1px solid #3e3e42", borderRadius: "6px", width: "500px", padding: "24px", color: "#cccccc" }}>
        <h2 style={{ margin: "0 0 20px", fontSize: "16px", fontWeight: 600, color: "#ffffff" }}>New Project</h2>

        <div style={s.row}>
          <label style={s.label}>Project Name</label>
          <input value={name} onChange={e => setName(e.target.value)} style={s.input} />
        </div>

        <div style={s.row}>
          <label style={s.label}>Location (parent folder)</label>
          <div style={{ display: "flex", gap: "8px" }}>
            <input value={location} onChange={e => setLocation(e.target.value)} placeholder="Click Browse to choose..." style={{ ...s.input, flex: 1 }} />
            <button onClick={pickLocation} style={{ backgroundColor: "#0078d4", border: "none", borderRadius: "4px", color: "#fff", padding: "6px 14px", cursor: "pointer", fontSize: "13px", flexShrink: 0 }}>
              Browse
            </button>
          </div>
          {name && location && !/^[A-Za-z]:$/.test(location.trim().replace(/[/\\]+$/, "")) && (
            <div style={{ fontSize: "11px", color: "#858585", marginTop: "4px" }}>
              Will create: {location.trim().replace(/[/\\]+$/, "")}{"\\"+name.trim()}
            </div>
          )}
        </div>

        <div style={s.row}>
          <label style={s.label}>Template</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {TEMPLATES.map(t => (
              <div key={t.id} onClick={() => setTemplate(t.id)} style={{ padding: "10px 12px", borderRadius: "4px", cursor: "pointer", border: template === t.id ? "1px solid #0078d4" : "1px solid #555", backgroundColor: template === t.id ? "#0078d420" : "#3c3c3c" }}>
                <div style={{ fontSize: "13px", fontWeight: 500, color: "#cccccc", marginBottom: "2px" }}>{t.label}</div>
                <div style={{ fontSize: "11px", color: "#858585" }}>{t.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {error && <div style={{ color: "#f44747", fontSize: "12px", marginBottom: "12px" }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
          <button onClick={onClose} style={{ backgroundColor: "transparent", border: "1px solid #555", borderRadius: "4px", color: "#cccccc", padding: "6px 16px", cursor: "pointer", fontSize: "13px" }}>Cancel</button>
          <button onClick={handleCreate} disabled={creating} style={{ backgroundColor: "#0078d4", border: "none", borderRadius: "4px", color: "#fff", padding: "6px 16px", cursor: "pointer", fontSize: "13px", opacity: creating ? 0.6 : 1 }}>
            {creating ? "Creating..." : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
