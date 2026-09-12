import { useState, useRef, useEffect } from "react";
import { SignedIn, SignedOut, SignInButton, UserButton, useAuth } from "@clerk/clerk-react";

const API_BASE = "https://web-production-85687.up.railway.app";
const API_KEY = import.meta.env.VITE_APP_API_KEY;

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

  const [employeeProfile, setEmployeeProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);
  const [checkinSubmitting, setCheckinSubmitting] = useState(false);

  const [subscription, setSubscription] = useState(null); // { status, plan }
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(null); // "monthly" | "annual" | null
  const [downloadLoading, setDownloadLoading] = useState(null); // "win" | "mac" | null
  const [pendingCheckout, setPendingCheckout] = useState(false); // true after a successful redirect, until status confirms active

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

  const fetchEmployeeProfile = async () => {
    setProfileLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/employee/profile`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });

      if (res.status === 404) {
        setEmployeeProfile(null);
        setShowProfileForm(true);
      } else if (res.ok) {
        const data = await res.json();
        setEmployeeProfile(data);
        setShowProfileForm(data.context_stale);
      }
    } catch (err) {
      console.error("Failed to load employee profile:", err);
    } finally {
      setProfileLoading(false);
    }
  };

  const saveEmployeeProfile = async (formValues) => {
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/employee/profile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(formValues),
      });

      if (!res.ok) throw new Error("Failed to save profile");

      const data = await res.json();
      setEmployeeProfile(data);
      setShowProfileForm(false);
    } catch (err) {
      console.error("Failed to save employee profile:", err);
    }
  };

  const submitCheckin = async (checkinValues) => {
    setCheckinSubmitting(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/employee/checkin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(checkinValues),
      });

      if (!res.ok) throw new Error("Failed to submit check-in");

      setShowCheckin(false);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Check-in recorded. Thanks for keeping this up to date.", system: true },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Couldn't submit that check-in. Please try again.", error: true },
      ]);
    } finally {
      setCheckinSubmitting(false);
    }
  };

  const fetchSubscriptionStatus = async () => {
    setSubscriptionLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/billing/subscription-status`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });
      if (res.ok) {
        setSubscription(await res.json());
      }
    } catch (err) {
      console.error("Failed to load subscription status:", err);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  // After a successful checkout, the webhook may take a second or two to
  // land on the backend. Poll subscription-status a few times with backoff
  // instead of trusting a single check right after redirect.
  const pollSubscriptionStatus = async (attempt = 0) => {
    setSubscriptionLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/billing/subscription-status`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSubscription(data);
        if (data.status === "active") {
          setSubscriptionLoading(false);
          setPendingCheckout(false);
          return;
        }
        if (attempt >= 5) {
          // Gave up automatically retrying -- leave pendingCheckout on so
          // the manual "Refresh status" fallback stays visible.
          setSubscriptionLoading(false);
          return;
        }
      }
    } catch (err) {
      console.error("Failed to load subscription status:", err);
    }
    setTimeout(() => pollSubscriptionStatus(attempt + 1), 1500 * (attempt + 1));
  };

  const refreshSubscriptionStatus = async () => {
    setSubscriptionLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/billing/subscription-status`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSubscription(data);
        if (data.status === "active") setPendingCheckout(false);
      }
    } catch (err) {
      console.error("Failed to load subscription status:", err);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  const startCheckout = async (plan) => {
    setCheckoutLoading(plan);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/billing/create-checkout-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ plan }),
      });

      if (!res.ok) throw new Error("Failed to start checkout");

      const data = await res.json();
      window.location.href = data.checkout_url; // redirect to Stripe's hosted page
    } catch (err) {
      console.error("Checkout failed:", err);
      setCheckoutLoading(null);
    }
  };

  const fetchDownloadLink = async (platform) => {
    setDownloadLoading(platform);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/employee/download?platform=${platform}`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });

      if (!res.ok) throw new Error("Failed to get download link");

      const data = await res.json();
      window.location.href = data.download_url; // triggers the browser's file download
    } catch (err) {
      console.error("Failed to fetch download link:", err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Couldn't get the download link. Please try again.", error: true },
      ]);
    } finally {
      setDownloadLoading(null);
    }
  };

  useEffect(() => {
    if (audience === "employee") {
      fetchSubscriptionStatus();
      fetchEmployeeProfile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  // After returning from Stripe Checkout, the URL carries ?checkout=success
  // or ?checkout=canceled. Re-check status (webhook may take a moment to
  // land) and clean the URL either way.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutResult = params.get("checkout");
    if (checkoutResult) {
      // The page just reloaded after the Stripe redirect, so `audience` is
      // back at its initial "individual" state no matter what it was before
      // checkout -- this flow only ever originates from the employee tier,
      // so force it back there and poll status until the webhook lands.
      setAudience("employee");
      window.history.replaceState({}, "", window.location.pathname);

      if (checkoutResult === "success") {
        setPendingCheckout(true);
        pollSubscriptionStatus();
      } else {
        fetchSubscriptionStatus();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <p style={styles.legalConsent}>
            By signing in, you agree to our{" "}
            <a href="/terms-of-service.html" target="_blank" rel="noopener noreferrer" style={styles.legalLink}>
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="/privacy-policy.html" target="_blank" rel="noopener noreferrer" style={styles.legalLink}>
              Privacy Policy
            </a>.
          </p>
          <Footer />
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

          {audience === "employee" && subscriptionLoading && (
            <p style={styles.emptyState}>Checking your subscription...</p>
          )}

          {audience === "employee" && !subscriptionLoading && subscription?.status !== "active" && (
            <PricingPanel
              onSelectPlan={startCheckout}
              loadingPlan={checkoutLoading}
              showRefresh={pendingCheckout}
              onRefresh={refreshSubscriptionStatus}
              refreshing={subscriptionLoading}
            />
          )}

          {audience === "employee" && !subscriptionLoading && subscription?.status === "active" &&
            !profileLoading && employeeProfile && !showProfileForm && (
            <div style={styles.employeeBar}>
              <span style={styles.employeeBarText}>
                {employeeProfile.job_role || "Workplace profile set"}
              </span>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={() => setShowCheckin(true)} style={styles.employeeBarButton}>
                  Check in
                </button>
                <button onClick={() => setShowProfileForm(true)} style={styles.employeeBarButtonGhost}>
                  Edit profile
                </button>
              </div>
            </div>
          )}

          {audience === "employee" && subscription?.status === "active" && (
            <div style={styles.downloadBox}>
              <p style={styles.downloadLabel}>Get the desktop app</p>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={() => fetchDownloadLink("win")}
                  style={styles.downloadButton}
                  disabled={downloadLoading !== null}
                >
                  {downloadLoading === "win" ? "Preparing..." : "Download for Windows"}
                </button>
                <button
                  onClick={() => fetchDownloadLink("mac")}
                  style={styles.downloadButton}
                  disabled={downloadLoading !== null}
                >
                  {downloadLoading === "mac" ? "Preparing..." : "Download for Mac"}
                </button>
              </div>
            </div>
          )}

          {audience === "employee" && subscription?.status === "active" && showProfileForm && (
            <EmployeeProfileForm
              initial={employeeProfile}
              onSave={saveEmployeeProfile}
              onCancel={() => employeeProfile && setShowProfileForm(false)}
            />
          )}

          {audience === "employee" && subscription?.status === "active" && showCheckin && (
            <CheckinForm
              onSubmit={submitCheckin}
              onCancel={() => setShowCheckin(false)}
              submitting={checkinSubmitting}
            />
          )}

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
          <Footer />
        </div>
      </SignedIn>
    </div>
  );
}

const SCHEDULE_OPTIONS = ["standard", "shift", "remote", "hybrid"];

const EmployeeProfileForm = ({ initial, onSave, onCancel }) => {
  const [jobRole, setJobRole] = useState(initial?.job_role || "");
  const [workSchedule, setWorkSchedule] = useState(initial?.work_schedule || "standard");
  const [workload, setWorkload] = useState(initial?.stress_factors?.workload ?? 3);
  const [hours, setHours] = useState(initial?.stress_factors?.hours ?? 3);
  const [physicalStrain, setPhysicalStrain] = useState(initial?.stress_factors?.physical_strain ?? 3);
  const [checkinInterval, setCheckinInterval] = useState(initial?.checkin_interval_days ?? 7);

  const handleSubmit = () => {
    onSave({
      job_role: jobRole.trim() || null,
      work_schedule: workSchedule,
      stress_factors: { workload, hours, physical_strain: physicalStrain },
      checkin_interval_days: Number(checkinInterval),
    });
  };

  return (
    <div style={styles.formPanel}>
      <p style={styles.formTitle}>
        {initial ? "Update your workplace profile" : "Set up your workplace profile"}
      </p>
      <p style={styles.formSubtitle}>
        This helps tailor guidance to your work context — it's never used to diagnose.
      </p>

      <label style={styles.formLabel}>Job role</label>
      <input
        type="text"
        value={jobRole}
        onChange={(e) => setJobRole(e.target.value)}
        placeholder="e.g. warehouse associate, software engineer"
        style={styles.formInput}
      />

      <label style={styles.formLabel}>Work schedule</label>
      <div style={styles.audienceButtons}>
        {SCHEDULE_OPTIONS.map((opt) => (
          <button
            key={opt}
            onClick={() => setWorkSchedule(opt)}
            style={{
              ...styles.audienceButton,
              ...(workSchedule === opt ? styles.audienceButtonActive : {}),
            }}
          >
            {opt.charAt(0).toUpperCase() + opt.slice(1)}
          </button>
        ))}
      </div>

      <SliderField label="Workload" value={workload} onChange={setWorkload} />
      <SliderField label="Hours" value={hours} onChange={setHours} />
      <SliderField label="Physical strain" value={physicalStrain} onChange={setPhysicalStrain} />

      <label style={styles.formLabel}>Check in every (days)</label>
      <input
        type="number"
        min={1}
        max={90}
        value={checkinInterval}
        onChange={(e) => setCheckinInterval(e.target.value)}
        style={styles.formInput}
      />

      <div style={styles.formActions}>
        {initial && (
          <button onClick={onCancel} style={styles.formCancelButton}>Cancel</button>
        )}
        <button onClick={handleSubmit} style={styles.sendButton}>Save</button>
      </div>
    </div>
  );
};

const CheckinForm = ({ onSubmit, onCancel, submitting }) => {
  const [energy, setEnergy] = useState(3);
  const [stress, setStress] = useState(3);
  const [sleep, setSleep] = useState(3);
  const [newSymptoms, setNewSymptoms] = useState("");

  const handleSubmit = () => {
    onSubmit({
      energy, stress, sleep,
      new_symptoms: newSymptoms.trim() || null,
    });
  };

  return (
    <div style={styles.formPanel}>
      <p style={styles.formTitle}>Quick check-in</p>

      <SliderField label="Energy" value={energy} onChange={setEnergy} />
      <SliderField label="Stress" value={stress} onChange={setStress} />
      <SliderField label="Sleep quality" value={sleep} onChange={setSleep} />

      <label style={styles.formLabel}>Anything new? (optional)</label>
      <input
        type="text"
        value={newSymptoms}
        onChange={(e) => setNewSymptoms(e.target.value)}
        placeholder="e.g. lower back ache since Tuesday"
        style={styles.formInput}
      />

      <div style={styles.formActions}>
        <button onClick={onCancel} style={styles.formCancelButton}>Cancel</button>
        <button onClick={handleSubmit} style={styles.sendButton} disabled={submitting}>
          {submitting ? "Submitting..." : "Submit"}
        </button>
      </div>
    </div>
  );
};

const PricingPanel = ({ onSelectPlan, loadingPlan, showRefresh, onRefresh, refreshing }) => (
  <div style={styles.pricingPanel}>
    <p style={styles.formTitle}>Employee Tier</p>
    <p style={styles.formSubtitle}>
      Workplace-aware guidance, recurring check-ins, and a downloadable desktop app.
    </p>

    {showRefresh && (
      <div style={styles.employeeBar}>
        <span style={styles.employeeBarText}>
          Payment received — waiting to confirm your subscription.
        </span>
        <button
          onClick={onRefresh}
          style={styles.employeeBarButton}
          disabled={refreshing}
        >
          {refreshing ? "Checking..." : "Refresh status"}
        </button>
      </div>
    )}

    <div style={styles.pricingCards}>
      <div style={styles.pricingCard}>
        <p style={styles.pricingPlanName}>Monthly</p>
        <p style={styles.pricingPrice}>Billed monthly</p>
        <button
          onClick={() => onSelectPlan("monthly")}
          style={styles.sendButton}
          disabled={loadingPlan !== null}
        >
          {loadingPlan === "monthly" ? "Redirecting..." : "Choose Monthly"}
        </button>
      </div>

      <div style={{ ...styles.pricingCard, ...styles.pricingCardHighlighted }}>
        <p style={styles.pricingBadge}>Best value</p>
        <p style={styles.pricingPlanName}>Annual</p>
        <p style={styles.pricingPrice}>Billed yearly</p>
        <button
          onClick={() => onSelectPlan("annual")}
          style={styles.sendButton}
          disabled={loadingPlan !== null}
        >
          {loadingPlan === "annual" ? "Redirecting..." : "Choose Annual"}
        </button>
      </div>
    </div>

    <p style={styles.pricingNote}>
      You'll be redirected to Stripe's secure checkout. Cancel anytime.
    </p>
  </div>
);

const SliderField = ({ label, value, onChange }) => (
  <div style={{ marginBottom: "10px" }}>
    <div style={styles.sliderLabelRow}>
      <label style={styles.formLabel}>{label}</label>
      <span style={styles.sliderValue}>{value}</span>
    </div>
    <input
      type="range"
      min={1}
      max={5}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ width: "100%" }}
    />
  </div>
);

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
  legalConsent: {
    fontSize: "11px",
    color: "#a8b3af",
    textAlign: "center",
    marginTop: "12px",
    lineHeight: 1.6,
  },
  legalLink: {
    color: "#5f8f83",
    textDecoration: "underline",
  },
  footer: {
    display: "flex",
    justifyContent: "center",
    gap: "8px",
    marginTop: "16px",
    fontSize: "11px",
    color: "#a8b3af",
  },
  footerDot: {
    color: "#c7d0cd",
  },
  employeeBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#eaf4f1",
    border: "1px solid #cfe6df",
    borderRadius: "10px",
    padding: "9px 12px",
    fontSize: "12px",
    marginBottom: "1rem",
    color: "#215048",
  },
  employeeBarText: { fontWeight: 500 },
  employeeBarButton: {
    fontSize: "11px",
    padding: "6px 10px",
    background: "#215048",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: 500,
  },
  employeeBarButtonGhost: {
    fontSize: "11px",
    padding: "6px 10px",
    background: "transparent",
    color: "#215048",
    border: "1px solid #cfe6df",
    borderRadius: "8px",
    cursor: "pointer",
  },
  formPanel: {
    background: "#f6f8f7",
    border: "1px solid #e6e9e7",
    borderRadius: "14px",
    padding: "1rem",
    marginBottom: "1rem",
  },
  formTitle: { fontSize: "14px", fontWeight: 600, color: "#1c2b28", margin: "0 0 4px" },
  formSubtitle: { fontSize: "11.5px", color: "#7c8b87", margin: "0 0 12px" },
  formLabel: { fontSize: "12px", color: "#4a5754", fontWeight: 500, display: "block", margin: "10px 0 6px" },
  formInput: {
    width: "100%",
    padding: "9px 12px",
    fontSize: "13px",
    border: "1px solid #e0e4e2",
    borderRadius: "10px",
    outline: "none",
    boxSizing: "border-box",
  },
  formActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    marginTop: "14px",
  },
  formCancelButton: {
    padding: "10px 16px",
    fontSize: "13px",
    background: "transparent",
    color: "#5a6d68",
    border: "1px solid #e0e4e2",
    borderRadius: "10px",
    cursor: "pointer",
  },
  sliderLabelRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  sliderValue: { fontSize: "12px", color: "#215048", fontWeight: 600 },
  pricingPanel: {
    background: "#f6f8f7",
    border: "1px solid #e6e9e7",
    borderRadius: "14px",
    padding: "1.25rem",
    marginBottom: "1rem",
  },
  pricingCards: {
    display: "flex",
    gap: "10px",
    marginTop: "14px",
  },
  pricingCard: {
    flex: 1,
    background: "#fff",
    border: "1px solid #e0e4e2",
    borderRadius: "12px",
    padding: "14px",
    textAlign: "center",
    position: "relative",
  },
  pricingCardHighlighted: {
    border: "1.5px solid #2f6f65",
  },
  pricingBadge: {
    position: "absolute",
    top: "-9px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#215048",
    color: "#fff",
    fontSize: "10px",
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: "6px",
  },
  pricingPlanName: { fontSize: "14px", fontWeight: 600, color: "#1c2b28", margin: "6px 0 2px" },
  pricingPrice: { fontSize: "12px", color: "#7c8b87", margin: "0 0 12px" },
  pricingNote: { fontSize: "11px", color: "#a8b3af", textAlign: "center", marginTop: "12px" },
  downloadBox: {
    background: "#eaf4f1",
    border: "1px solid #cfe6df",
    borderRadius: "10px",
    padding: "12px",
    marginBottom: "1rem",
  },
  downloadLabel: { fontSize: "12px", fontWeight: 500, color: "#215048", margin: "0 0 8px" },
  downloadButton: {
    flex: 1,
    fontSize: "12px",
    padding: "9px",
    background: "#fff",
    border: "1px solid #cfe6df",
    borderRadius: "8px",
    cursor: "pointer",
    color: "#215048",
    fontWeight: 500,
  },
};

const Footer = () => (
  <div style={styles.footer}>
    <a href="/privacy-policy.html" target="_blank" rel="noopener noreferrer" style={styles.legalLink}>
      Privacy Policy
    </a>
    <span style={styles.footerDot}>·</span>
    <a href="/terms-of-service.html" target="_blank" rel="noopener noreferrer" style={styles.legalLink}>
      Terms of Service
    </a>
  </div>
);

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
