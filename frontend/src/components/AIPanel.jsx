import React, { useState, useRef, useEffect } from "react";
import { BACKEND_URL } from "../api";

const SendIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
const ClearIcon = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>;

export default function AIPanel({ activeFile, language }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const q = input.trim();
    setInput("");
    setMessages(m => [...m, { role: "user", text: q }]);
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL()}/api/ai/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, file: activeFile?.path, language }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Request failed");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      setMessages(m => [...m, { role: "assistant", text: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        setMessages(m => { const n = [...m]; n[n.length - 1] = { role: "assistant", text }; return n; });
      }
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `Error: ${e.message}`, isError: true }]);
    } finally { setLoading(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #3e3e42" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#bbbbbb" }}>AI Assistant</span>
        <button onClick={() => setMessages([])} style={{ background: "none", border: "none", color: "#858585", cursor: "pointer", display: "flex" }}
          onMouseEnter={e => e.currentTarget.style.color = "#cccccc"} onMouseLeave={e => e.currentTarget.style.color = "#858585"} title="Clear chat">
          <ClearIcon />
        </button>
      </div>

      {/* Context badge */}
      {activeFile && (
        <div style={{ padding: "4px 12px", backgroundColor: "#2d2d2d", borderBottom: "1px solid #3e3e42", fontSize: "11px", color: "#858585", display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ color: "#4ec9b0" }}>●</span> {activeFile.name}
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#555", fontSize: "12px", marginTop: "30px", padding: "0 12px" }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1" style={{ margin: "0 auto 10px", display: "block" }}>
              <path d="M12 2a5 5 0 0 1 5 5v3a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5z"/>
              <path d="M15 13a6 6 0 0 1-6 0M12 17v4M8 21h8"/>
            </svg>
            <p style={{ marginBottom: "8px" }}>Ask me anything about your code</p>
            {!activeFile && <p style={{ color: "#444" }}>Open a file for context-aware help</p>}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            marginBottom: "8px",
            display: "flex",
            flexDirection: "column",
            alignItems: msg.role === "user" ? "flex-end" : "flex-start",
          }}>
            <div style={{
              maxWidth: "90%", padding: "8px 10px", borderRadius: "6px", fontSize: "12px",
              lineHeight: "1.6", whiteSpace: "pre-wrap", wordBreak: "break-word",
              backgroundColor: msg.role === "user" ? "#0078d4" : msg.isError ? "#3c1f1f" : "#2d2d2d",
              color: msg.isError ? "#f44747" : "#cccccc",
            }}>
              {msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 0", color: "#858585", fontSize: "12px" }}>
            <span style={{ animation: "pulse 1s infinite" }}>●●●</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "8px", borderTop: "1px solid #3e3e42" }}>
        <div style={{ display: "flex", gap: "6px", backgroundColor: "#3c3c3c", border: "1px solid #555", borderRadius: "4px", padding: "6px 8px" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask about your code... (Enter to send)"
            rows={2}
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "#cccccc", fontSize: "12px", resize: "none", fontFamily: "inherit" }}
          />
          <button onClick={send} disabled={!input.trim() || loading}
            style={{ background: "none", border: "none", color: input.trim() && !loading ? "#0078d4" : "#555", cursor: input.trim() && !loading ? "pointer" : "default", display: "flex", alignItems: "flex-end", padding: "2px" }}>
            <SendIcon />
          </button>
        </div>
        <div style={{ fontSize: "10px", color: "#444", marginTop: "4px", textAlign: "center" }}>
          Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}
