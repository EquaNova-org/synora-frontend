import { useState, useRef, useEffect } from "react";
import { SignedIn, SignedOut, SignInButton, UserButton, useAuth } from "@clerk/clerk-react";

const API_BASE = "https://web-production-85687.up.railway.app";
const API_KEY = "b992ade888f7ab84daa201652affebc979e7458cb631d31d79fdb70b0c1a6883"; // same value as APP_API_KEY in Railway

const STEP_LABELS = {
  classify_intent: "Understanding your question",
  check_emergency: "Checking for urgent symptoms",
  retrieve: "Retrieving medical sources",
  analyze: "Analyzing patterns",
  verify_analysis_evidence: "Verifying evidence",
  recommend: "Generating recommendations",
  verify_recommendation_evidence: "Double-checking evidence",
  communicate: "Preparing your response",
  emergency_response: "Preparing urgent guidance",
  fallback: "Reviewing available evidence",
};

function App() {
  const { getToken } = useAuth();

  const [audience, setAudience] = useState("individual");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [uploadedFileName, setUploadedFileName] = useState(null);
  const [uploading, setUploading] = useState(false);

  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Only PDF files are supported.", error: true },
      ]);
      return;
    }

    setUploading(true);

    const formData = new FormData();
    formData.append("file", file);
    if (sessionId) formData.append("session_id", sessionId);

    try {
      const token = await getToken();

      const res = await fetch(`${API_BASE}/api/upload`, {
        method: "POST",
        headers: {
          "X-API-Key": API_KEY,
          "Authorization": `Bearer ${token}`,
        },
        body: formData,
      });

      if (!res.ok) throw new Error("Upload failed");

      const data = await res.json();
      setSessionId(data.session_id);
      setUploadedFileName(data.filename);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Added "${data.filename}" (${data.chunks_added} sections). Ask me anything about it.`,
          system: true,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Couldn't upload that file. Please try again.", error: true },
      ]);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const sendMessage = async () => {
    const question = input.trim();
    if (!question || loading) return;

    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setInput("");
    setLoading(true);
    setCurrentStep(null);

    try {
      const token = await getToken();

      const res = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ question, audience, session_id: sessionId }),
      });

      if (!res.ok || !res.body) throw new Error("Request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalPayload = null;
      const stepQueue = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = JSON.parse(line.slice(6));

          if (payload.step === "error") {
            throw new Error(payload.error || "Stream error");
          }

          stepQueue.push(payload.step);
          finalPayload = payload;
        }
      }

      const MIN_STEP_DISPLAY_MS = 500;
      for (const step of stepQueue) {
        setCurrentStep(step);
        await new Promise((resolve) => setTimeout(resolve, MIN_STEP_DISPLAY_MS));
      }

      if (finalPayload) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: finalPayload.response,
            severity: finalPayload.analysis?.severity_signal,
            triage: finalPayload.analysis?.triage_recommendation,
            emergency: finalPayload.emergency_type,
          },
        ]);
      }
    } catch (err) {
      console.error("STREAM ERROR:", err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Something went wrong. Please try again.", error: true },
        ]);
    } finally {
      setLoading(false);
      setCurrentStep(null);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={styles.page}>
      <GlobalStyle />

      <SignedOut>
        <div style={styles.container}>
          <div style={styles.header}>
            <div style={styles.logo}>S</div>
            <h1 style={styles.title}>Synora</h1>
            <p style={styles.subtitle}>Evidence-grounded health guidance</p>
          </div>
          <p style={{ textAlign: "center", fontSize: "13px", color: "#7c8b87", marginBottom: "1rem" }}>
            Please sign in to continue.
          </p>
          <SignInButton mode="modal">
            <button style={styles.sendButton}>Sign In</button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        <div style={{ ...styles.container, position: "relative" }}>
          <div style={{ position: "absolute", top: "1rem", right: "1rem" }}>
            <UserButton />
          </div>

          <div style={styles.header}>
            <div style={styles.logo}>S</div>
            <h1 style={styles.title}>Synora</h1>
            <p style={styles.subtitle}>Evidence-grounded health guidance</p>
          </div>

          <div style={styles.audienceBox}>
            <p style={styles.audienceLabel}>Who are you checking in as?</p>
            <div style={styles.audienceButtons}>
              {["individual", "employee", "doctor"].map((option) => (
                <button
                  key={option}
                  onClick={() => setAudience(option)}
                  style={{
                    ...styles.audienceButton,
                    ...(audience === option ? styles.audienceButtonActive : {}),
                  }}
                >
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {uploadedFileName && (
            <div style={styles.fileChip}>
              <span>📄 {uploadedFileName}</span>
              <button
                onClick={() => { setSessionId(null); setUploadedFileName(null); }}
                style={styles.fileChipRemove}
              >
                ×
              </button>
            </div>
          )}

          <div style={styles.chatWindow}>
            {messages.length === 0 && (
              <p style={styles.emptyState}>Ask a health question to get started.</p>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  ...styles.bubble,
                  ...(msg.role === "user" ? styles.userBubble : styles.assistantBubble),
                }}
              >
                {msg.text}
                {msg.role === "assistant" && (msg.severity || msg.triage) && (
                  <div style={styles.badgeRow}>
                    {msg.severity && (
                      <span style={styles.badge}>Severity: {msg.severity}</span>
                    )}
                    {msg.triage && (
                      <span style={styles.badge}>Triage: {msg.triage.replaceAll("_", " ")}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <p style={styles.loadingText}>
                {currentStep ? STEP_LABELS[currentStep] || "Processing..." : "Starting..."}
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          <div style={styles.inputRow}>
            <input
              type="file"
              accept="application/pdf"
              ref={fileInputRef}
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
            <button
              onClick={() => fileInputRef.current.click()}
              style={styles.uploadButton}
              disabled={uploading}
              title="Upload a document"
            >
              +
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a health question"
              style={styles.input}
            />
            <button onClick={sendMessage} style={styles.sendButton} disabled={loading}>
              Send
            </button>
          </div>

          <p style={styles.disclaimer}>Not a substitute for professional medical advice.</p>
        </div>
      </SignedIn>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f7f6f3 0%, #eef1f0 100%)",
    display: "flex",
    justifyContent: "center",
    padding: "3rem 1rem",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
  container: {
    width: "100%",
    maxWidth: "480px",
    background: "#ffffff",
    borderRadius: "20px",
    padding: "1.75rem",
    boxShadow: "0 4px 24px rgba(20, 40, 40, 0.06)",
    border: "1px solid #eceae4",
  },
  header: { textAlign: "center", marginBottom: "1.5rem" },
  logo: {
    width: "40px",
    height: "40px",
    margin: "0 auto 10px",
    borderRadius: "12px",
    background: "linear-gradient(135deg, #2f6f65, #3f8f7f)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "16px",
    fontWeight: 600,
  },
  title: { fontSize: "19px", fontWeight: 600, margin: 0, color: "#1c2b28", letterSpacing: "-0.2px" },
  subtitle: { fontSize: "13px", color: "#7c8b87", margin: "4px 0 0" },
  audienceBox: {
    background: "#f6f8f7",
    border: "1px solid #e6e9e7",
    borderRadius: "14px",
    padding: "1rem",
    marginBottom: "1rem",
  },
  audienceLabel: { fontSize: "12px", color: "#7c8b87", margin: "0 0 8px", fontWeight: 500 },
  audienceButtons: { display: "flex", gap: "8px" },
  audienceButton: {
    flex: 1,
    fontSize: "13px",
    padding: "9px",
    border: "1px solid #e0e4e2",
    borderRadius: "10px",
    background: "#fff",
    cursor: "pointer",
    transition: "all 0.15s ease",
    color: "#4a5754",
  },
  audienceButtonActive: {
    border: "1px solid #2f6f65",
    background: "#eaf4f1",
    color: "#215048",
    fontWeight: 500,
  },
  fileChip: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#eaf4f1",
    border: "1px solid #cfe6df",
    borderRadius: "10px",
    padding: "7px 12px",
    fontSize: "12px",
    marginBottom: "1rem",
    color: "#215048",
  },
  fileChipRemove: {
    background: "none",
    border: "none",
    cursor: "pointer",
    fontSize: "15px",
    color: "#5a6d68",
  },
  chatWindow: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    marginBottom: "1rem",
    minHeight: "220px",
    maxHeight: "440px",
    overflowY: "auto",
    padding: "2px",
  },
  emptyState: { fontSize: "13px", color: "#a8b3af", textAlign: "center", marginTop: "3rem" },
  bubble: {
    maxWidth: "85%",
    padding: "12px 16px",
    borderRadius: "16px",
    fontSize: "14px",
    lineHeight: 1.65,
    whiteSpace: "pre-wrap",
    animation: "fadeSlideIn 0.25s ease",
  },
  userBubble: {
    alignSelf: "flex-end",
    background: "#215048",
    color: "#ffffff",
    borderBottomRightRadius: "4px",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    background: "#f6f8f7",
    border: "1px solid #e6e9e7",
    color: "#2a3532",
    borderBottomLeftRadius: "4px",
  },
  badgeRow: { display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap" },
  badge: {
    fontSize: "11px",
    padding: "4px 9px",
    borderRadius: "8px",
    background: "#fdf1de",
    color: "#8a5a1f",
    fontWeight: 500,
  },
  loadingText: {
    fontSize: "13px",
    color: "#5f8f83",
    fontStyle: "italic",
    animation: "pulse 1.4s ease-in-out infinite",
  },
  inputRow: { display: "flex", gap: "8px" },
  uploadButton: {
    width: "42px",
    fontSize: "18px",
    background: "#f6f8f7",
    border: "1px solid #e6e9e7",
    borderRadius: "10px",
    cursor: "pointer",
    color: "#4a5754",
  },
  input: {
    flex: 1,
    padding: "11px 14px",
    fontSize: "14px",
    border: "1px solid #e0e4e2",
    borderRadius: "10px",
    outline: "none",
  },
  sendButton: {
    padding: "10px 18px",
    fontSize: "14px",
    background: "#215048",
    color: "#fff",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
    fontWeight: 500,
  },
  disclaimer: {
    fontSize: "11px",
    color: "#a8b3af",
    textAlign: "center",
    marginTop: "12px",
  },
};

const GlobalStyle = () => (
  <style>{`
    @keyframes fadeSlideIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }
  `}</style>
);

export default App;
