import React, { useState, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import EditorPane from "./components/EditorPane";
import StatusBar from "./components/StatusBar";
import FileTree from "./components/FileTree";
import GitHubPanel from "./components/GitHubPanel";
import CollabPanel from "./components/CollabPanel";
import AIPanel from "./components/AIPanel";
import GitPanel from "./components/GitPanel";

export default function App() {
  const [activePanel, setActivePanel] = useState("explorer");
  const [openFiles, setOpenFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [rootPath, setRootPath] = useState(null);
  const [branch, setBranch] = useState("main");
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [language, setLanguage] = useState("plaintext");

  const openFile = useCallback((file) => {
    setOpenFiles((prev) => {
      const exists = prev.find((f) => f.path === file.path);
      if (exists) return prev;
      return [...prev, { ...file, isDirty: false }];
    });
    setActiveFile(file.path);
  }, []);

  const closeFile = useCallback((path) => {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      setActiveFile(next.length > 0 ? next[next.length - 1].path : null);
      return next;
    });
  }, []);

  const updateFileContent = useCallback((path, content) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content, isDirty: true } : f))
    );
  }, []);

  const markFileSaved = useCallback((path) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, isDirty: false } : f))
    );
  }, []);

  const activeFileObj = openFiles.find((f) => f.path === activeFile) || null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", overflow: "hidden", backgroundColor: "#1e1e1e", color: "#cccccc" }}>
      {/* Main area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Activity bar */}
        <Sidebar activePanel={activePanel} setActivePanel={setActivePanel} />

        {/* Side panel */}
        <div style={{ display: "flex", flexDirection: "column", width: "240px", minWidth: "180px", backgroundColor: "#252526", borderRight: "1px solid #3e3e42", overflow: "hidden" }}>
          {activePanel === "explorer" && (
            <FileTree rootPath={rootPath} setRootPath={setRootPath} onOpenFile={openFile} activeFilePath={activeFile} />
          )}
          {activePanel === "git" && (
            <GitPanel rootPath={rootPath} branch={branch} setBranch={setBranch} />
          )}
          {activePanel === "github" && (
            <GitHubPanel onOpenFile={openFile} rootPath={rootPath} />
          )}
          {activePanel === "collab" && <CollabPanel />}
          {activePanel === "ai" && (
            <AIPanel activeFile={activeFileObj} language={language} />
          )}
        </div>

        {/* Editor area */}
        <EditorPane
          openFiles={openFiles}
          activeFile={activeFile}
          setActiveFile={setActiveFile}
          onCloseFile={closeFile}
          onUpdateContent={updateFileContent}
          onMarkSaved={markFileSaved}
          onCursorChange={setCursorPos}
          onLanguageChange={setLanguage}
        />
      </div>

      {/* Status bar */}
      <StatusBar branch={branch} cursorPos={cursorPos} language={language} activeFile={activeFile} />
    </div>
  );
}
