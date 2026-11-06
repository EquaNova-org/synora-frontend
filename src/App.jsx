import { useState, useRef, useEffect } from "react";
import { SignInButton, UserButton, useAuth } from "@clerk/clerk-react";

const API_BASE = "https://web-production-85687.up.railway.app";
const API_KEY = import.meta.env.VITE_APP_API_KEY;
// Where the desktop app sends the system browser to sign in (see
// DesktopAuthHandoff.jsx) -- must match one of api.py's verify_clerk_user
// authorized_parties entries.
const WEB_FRONTEND_URL = "https://synora-frontend-swart.vercel.app";

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

// Audiences that require their own paid subscription. Individual is free.
// The server enforces this (402); the frontend only mirrors it for UX.
const PAID_TIERS = ["employee", "doctor"];

const TIER_COPY = {
  employee: {
    title: "Employee Tier",
    blurb: "Workplace-aware guidance, recurring check-ins, and a downloadable desktop app.",
  },
  doctor: {
    title: "Doctor Tier",
    blurb: "Research-grade answers grounded in a curated library of peer-reviewed medical literature.",
  },
};

function App() {
  const { getToken, isSignedIn: isSignedInClerk } = useAuth();

  const [audience, setAudience] = useState("individual");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [uploadedFileName, setUploadedFileName] = useState(null);
  const [uploading, setUploading] = useState(false);

  // Chat history. Each audience keeps its own list of past chats on the server;
  // `conversations` is the list for the audience currently selected.
  const [conversations, setConversations] = useState([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState(null); // null = a new, unsaved chat
  const [openingConversation, setOpeningConversation] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer only
  const [libraryTab, setLibraryTab] = useState("chats"); // "chats" | "sources"
  const [traceSteps, setTraceSteps] = useState([]); // agent steps of the latest turn

  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("synora-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("synora-theme", theme);
    } catch {
      /* storage unavailable (private mode); the theme just won't persist */
    }
  }, [theme]);

  const [employeeProfile, setEmployeeProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);
  const [checkinSubmitting, setCheckinSubmitting] = useState(false);

  // Subscription status per paid tier: { employee: {status, plan}, doctor: {...} }.
  // `subscription` is the one belonging to the audience currently selected.
  const [subscriptions, setSubscriptions] = useState({});
  const subscription = subscriptions[audience] || null;
  const isPaidAudience = PAID_TIERS.includes(audience);
  const hasAccess = !isPaidAudience || subscription?.status === "active";
  const employeeActive = subscriptions.employee?.status === "active";
  // Desktop's checkout return (synora://checkout) carries only a status, not
  // the tier, so remember which tier the user was buying.
  const checkoutTierRef = useRef("employee");
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(null); // "monthly" | "annual" | null
  const [downloadLoading, setDownloadLoading] = useState(null); // "win" | "mac" | null
  const [pendingCheckout, setPendingCheckout] = useState(false); // true after a successful redirect, until status confirms active
  // Electron's preload.js exposes window.electronAPI; absent in the web build.
  const isDesktop = typeof window !== "undefined" && !!window.electronAPI;

  // Desktop's own backend-issued token (see desktop_auth.py) -- NOT a Clerk
  // session. Clerk's own session/cookie persistence doesn't survive inside
  // the app:// origin, so the desktop app authenticates with the backend
  // using this instead, loaded from secure OS-keychain storage on launch.
  const [desktopToken, setDesktopToken] = useState(null);
  const [desktopTokenLoaded, setDesktopTokenLoaded] = useState(!isDesktop); // web has nothing to load

  // Unified signed-in flag: Clerk's own state for web, our token for desktop.
  const signedIn = isDesktop ? !!desktopToken : isSignedInClerk;

  // A single place that decides which kind of token to send with API calls,
  // so every existing getToken() call site below just becomes getAuthToken().
  // The deep-link callbacks below (checkout return) are registered once and
  // keep the first render's closure, where desktopToken was still null. Going
  // through a ref means they always send the current token.
  const desktopTokenRef = useRef(null);
  desktopTokenRef.current = desktopToken;

  const getAuthToken = async () => {
    if (isDesktop) return desktopTokenRef.current;
    return getToken();
  };

  useEffect(() => {
    if (!isDesktop) return;
    window.electronAPI.getStoredAuthToken().then((token) => {
      setDesktopToken(token || null);
      setDesktopTokenLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);

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
      const token = await getAuthToken();

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
      const token = await getAuthToken();
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
      const token = await getAuthToken();
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
      const token = await getAuthToken();
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

  const fetchSubscriptionStatus = async (tier) => {
    setSubscriptionLoading(true);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API_BASE}/api/billing/subscription-status?tier=${tier}`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSubscriptions((prev) => ({ ...prev, [tier]: data }));
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
  const pollSubscriptionStatus = async (tier, attempt = 0) => {
    setSubscriptionLoading(true);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API_BASE}/api/billing/subscription-status?tier=${tier}`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSubscriptions((prev) => ({ ...prev, [tier]: data }));
        if (data.status === "active") {
          setSubscriptionLoading(false);
          setPendingCheckout(false);
          return;
        }
      }
    } catch (err) {
      console.error("Failed to load subscription status:", err);
    }
    if (attempt >= 5) {
      // Gave up automatically retrying -- leave pendingCheckout on so
      // the manual "Refresh status" fallback stays visible. (The cap now
      // also applies when a request fails, not only when it succeeds but
      // isn't active yet, so a failing request can't poll forever.)
      setSubscriptionLoading(false);
      return;
    }
    setTimeout(() => pollSubscriptionStatus(tier, attempt + 1), 1500 * (attempt + 1));
  };

  const refreshSubscriptionStatus = async (tier) => {
    setSubscriptionLoading(true);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API_BASE}/api/billing/subscription-status?tier=${tier}`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSubscriptions((prev) => ({ ...prev, [tier]: data }));
        if (data.status === "active") setPendingCheckout(false);
      }
    } catch (err) {
      console.error("Failed to load subscription status:", err);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  const startCheckout = async (plan, tier) => {
    setCheckoutLoading(plan);
    checkoutTierRef.current = tier;
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API_BASE}/api/billing/create-checkout-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ plan, tier, client: isDesktop ? "desktop" : "web" }),
      });

      if (res.status === 409) {
        // Already subscribed to this tier -- just refresh so the UI unlocks.
        await fetchSubscriptionStatus(tier);
        setCheckoutLoading(null);
        return;
      }

      if (!res.ok) throw new Error("Failed to start checkout");

      const data = await res.json();
      if (isDesktop) {
        // Open in the system browser -- never navigate the packaged app's
        // own window, or it would be replaced by the web tier on redirect.
        await window.electronAPI.openExternal(data.checkout_url);
        setCheckoutLoading(null); // no in-app redirect to wait through; the deep-link listener below handles the return
      } else {
        window.location.href = data.checkout_url; // redirect to Stripe's hosted page
      }
    } catch (err) {
      console.error("Checkout failed:", err);
      setCheckoutLoading(null);
    }
  };

  const fetchDownloadLink = async (platform, tier) => {
    setDownloadLoading(platform);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API_BASE}/api/download?platform=${platform}&tier=${tier}`, {
        headers: { "X-API-Key": API_KEY, "Authorization": `Bearer ${token}` },
      });

      if (res.status === 404) {
        // The installer for this tier hasn't been published yet.
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "The desktop app for this plan isn't available yet. We'll let you know when it is.", error: true },
        ]);
        return;
      }

      if (res.status === 402) {
        // Subscription lapsed -- re-check so the pricing panel shows.
        await fetchSubscriptionStatus(tier);
        return;
      }

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

  // Switching to a paid audience checks that tier's subscription.
  useEffect(() => {
    if (PAID_TIERS.includes(audience)) {
      fetchSubscriptionStatus(audience);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  // The employee profile endpoints are subscription-gated server-side now, so
  // only load the profile once the employee subscription is known to be active.
  useEffect(() => {
    if (audience === "employee" && employeeActive) {
      fetchEmployeeProfile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, employeeActive]);

  // Desktop build: Stripe redirects the system browser to synora://checkout,
  // which main.js intercepts and forwards here instead of a URL param.
  useEffect(() => {
    if (!isDesktop) return;
    const unsubscribe = window.electronAPI.onCheckoutCallback((status) => {
      const tier = checkoutTierRef.current;
      setAudience(tier);
      if (status === "success") {
        setPendingCheckout(true);
        pollSubscriptionStatus(tier);
      } else {
        fetchSubscriptionStatus(tier);
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);

  // Desktop build: sign-in happens in the system browser (Clerk's own
  // cookie-based flow doesn't work inside the app:// origin -- see
  // DesktopAuthHandoff.jsx on the web frontend for why). The browser hands
  // back our own backend-issued token via synora://auth -- not a Clerk
  // session -- which we just store and use directly.
  useEffect(() => {
    if (!isDesktop) return;
    const unsubscribe = window.electronAPI.onAuthCallback(async (token) => {
      if (!token) return;
      await window.electronAPI.setStoredAuthToken(token);
      setDesktopToken(token);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop]);

  const handleDesktopSignIn = () => {
    window.electronAPI.openExternal(`${WEB_FRONTEND_URL}/desktop-auth`);
  };

  const handleDesktopSignOut = async () => {
    await window.electronAPI.clearStoredAuthToken();
    setDesktopToken(null);
    // Conversations, subscriptions and the audience are reset by the
    // signed-in -> signed-out effect below, which also covers web sign-out.
  };

  // After returning from Stripe Checkout, the URL carries ?checkout=success
  // or ?checkout=canceled. Re-check status (webhook may take a moment to
  // land) and clean the URL either way.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutResult = params.get("checkout");
    if (checkoutResult) {
      // The page just reloaded after the Stripe redirect, so `audience` is
      // back at its initial "individual" state no matter what it was before
      // checkout. The backend puts the tier in the return URL (&tier=...), so
      // send the user back to the audience they were buying and poll status
      // until the webhook lands. Missing/unknown tier -> employee, which is
      // what every checkout was before doctor tier existed.
      const tierParam = params.get("tier");
      const tier = PAID_TIERS.includes(tierParam) ? tierParam : "employee";
      setAudience(tier);
      window.history.replaceState({}, "", window.location.pathname);

      if (checkoutResult === "success") {
        setPendingCheckout(true);
        pollSubscriptionStatus(tier);
      } else {
        fetchSubscriptionStatus(tier);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------
  // Chat history
  // ---------------------------------------------------------------------
  // Refs give async callbacks the *current* values rather than the render
  // they were created in, so a slow response can't land in the wrong audience.
  const audienceRef = useRef(audience);
  audienceRef.current = audience;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const messagesCountRef = useRef(messages.length);
  messagesCountRef.current = messages.length;
  const listSeqRef = useRef(0); // newest list request wins
  const openSeqRef = useRef(0); // newest "open chat" request wins
  const autoOpenedRef = useRef({}); // audience -> already auto-opened its latest chat
  const wasSignedInRef = useRef(false);

  const historyHeaders = async () => ({
    "X-API-Key": API_KEY,
    "Authorization": `Bearer ${await getAuthToken()}`,
  });

  const clearChatView = () => {
    setMessages([]);
    setActiveConversationId(null);
    setSessionId(null);
    setUploadedFileName(null);
    setTraceSteps([]);
  };

  const fetchConversations = async (forAudience) => {
    const seq = ++listSeqRef.current;
    setConversationsLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/conversations?audience=${encodeURIComponent(forAudience)}`,
        { headers: await historyHeaders() }
      );
      if (seq !== listSeqRef.current) return null; // stale
      if (!res.ok) return null;
      const data = await res.json();
      if (seq !== listSeqRef.current) return null;
      setConversations(data);
      return data;
    } catch (err) {
      console.error("HISTORY LIST ERROR:", err);
      return null;
    } finally {
      if (seq === listSeqRef.current) setConversationsLoading(false);
    }
  };

  const openConversation = async (id) => {
    if (loadingRef.current) return;
    if (id === activeConversationIdRef.current) {
      setSidebarOpen(false);
      return;
    }
    const forAudience = audienceRef.current;
    const seq = ++openSeqRef.current;
    setOpeningConversation(true);
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, {
        headers: await historyHeaders(),
      });
      if (seq !== openSeqRef.current) return;
      if (res.status === 404) {
        // Deleted elsewhere (e.g. on the other app). Drop it from the list.
        setConversations((prev) => prev.filter((c) => c.id !== id));
        return;
      }
      if (res.status === 402) {
        await fetchSubscriptionStatus(forAudience);
        return;
      }
      if (!res.ok) throw new Error("Request failed");
      const data = await res.json();
      if (seq !== openSeqRef.current || data.audience !== audienceRef.current) return;
      setMessages(
        data.messages.map((m) => ({
          role: m.role,
          text: m.text,
          severity: m.severity,
          triage: m.triage,
          emergency: m.emergency,
        }))
      );
      setActiveConversationId(data.id);
      setSessionId(null);
      setUploadedFileName(null);
      setTraceSteps([]);
      setSidebarOpen(false);
    } catch (err) {
      console.error("HISTORY OPEN ERROR:", err);
      if (seq === openSeqRef.current) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "Couldn't load that chat. Please try again.", error: true },
        ]);
      }
    } finally {
      if (seq === openSeqRef.current) setOpeningConversation(false);
    }
  };

  const newConversation = () => {
    if (loadingRef.current) return;
    openSeqRef.current++;
    setOpeningConversation(false);
    clearChatView();
    setSidebarOpen(false);
  };

  const deleteConversation = async (id) => {
    if (loadingRef.current) return;
    if (!window.confirm("Delete this chat? This can't be undone.")) return;
    try {
      const res = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: await historyHeaders(),
      });
      if (!res.ok && res.status !== 404) throw new Error("Request failed");
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConversationIdRef.current === id) {
        openSeqRef.current++;
        setOpeningConversation(false);
        clearChatView();
      }
    } catch (err) {
      console.error("HISTORY DELETE ERROR:", err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Couldn't delete that chat. Please try again.", error: true },
      ]);
    }
  };

  // Switching audience starts from a clean slate: the chat on screen belongs
  // to the previous audience and must never show under the new one.
  useEffect(() => {
    listSeqRef.current++;
    openSeqRef.current++;
    setOpeningConversation(false);
    setConversationsLoading(false);
    setConversations([]);
    clearChatView();
    setSidebarOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  // Load this audience's chat list once the user is signed in and entitled to
  // it, and reopen the most recent chat the first time the audience is shown
  // (this is what makes a page reload restore where you left off).
  useEffect(() => {
    if (!signedIn || !hasAccess) {
      setConversations([]);
      return;
    }
    const forAudience = audience;
    (async () => {
      const list = await fetchConversations(forAudience);
      if (
        list && list.length > 0 &&
        !autoOpenedRef.current[forAudience] &&
        audienceRef.current === forAudience &&
        activeConversationIdRef.current === null &&
        messagesCountRef.current === 0 &&
        !loadingRef.current
      ) {
        autoOpenedRef.current[forAudience] = true;
        openConversation(list[0].id);
      } else if (list) {
        autoOpenedRef.current[forAudience] = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, hasAccess, audience]);

  // Signing out (web via Clerk's UserButton, desktop via our button) must not
  // leave the previous account's chats or subscriptions on screen.
  useEffect(() => {
    if (wasSignedInRef.current && !signedIn) {
      listSeqRef.current++;
      openSeqRef.current++;
      autoOpenedRef.current = {};
      setConversations([]);
      setSubscriptions({});
      setEmployeeProfile(null);
      clearChatView();
      setAudience("individual");
    }
    wasSignedInRef.current = signedIn;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  const sendMessage = async () => {
    const question = input.trim();
    if (!question || loading || openingConversation || !hasAccess) return;

    const sendAudience = audience;
    let savedConversationId = null;

    setMessages((prev) => [...prev, { role: "user", text: question }]);
    setInput("");
    setLoading(true);
    setCurrentStep(null);
    setTraceSteps([]);

    try {
      const token = await getAuthToken();

      const res = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          question,
          audience: sendAudience,
          session_id: sessionId,
          // Opt in to server-side history; older builds omit this and nothing is saved.
          save_history: true,
          conversation_id: activeConversationId,
        }),
      });

      if (res.status === 404 && activeConversationId) {
        // The chat we were continuing no longer exists (deleted on another device).
        setActiveConversationId(null);
        fetchConversations(sendAudience);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "This chat no longer exists, so your message wasn't sent. Send it again to start a new chat.", error: true },
        ]);
        return;
      }

      if (res.status === 402) {
        // The server says this audience needs a subscription we don't have
        // (e.g. it lapsed mid-session). Re-check so the pricing panel appears.
        await fetchSubscriptionStatus(audience);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "This audience needs an active subscription. Choose a plan above to continue.", error: true },
        ]);
        return;
      }

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

          // Even failed turns carry the id: the question was saved, so a retry
          // should continue the same chat instead of starting another.
          if (payload.conversation_id) savedConversationId = payload.conversation_id;

          if (payload.step === "error") {
            throw new Error(payload.error || "Stream error");
          }

          stepQueue.push(payload.step);
          finalPayload = payload;
        }
      }

      const MIN_STEP_DISPLAY_MS = 500;
      for (const [stepIndex, step] of stepQueue.entries()) {
        setCurrentStep(step);
        setTraceSteps(stepQueue.slice(0, stepIndex + 1));
        await new Promise((resolve) => setTimeout(resolve, MIN_STEP_DISPLAY_MS));
      }

      // The user may have switched audience while this was running; never show
      // an answer under the wrong audience.
      if (finalPayload && audienceRef.current === sendAudience) {
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
      if (audienceRef.current === sendAudience) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "Something went wrong. Please try again.", error: true },
        ]);
      }
    } finally {
      setLoading(false);
      setCurrentStep(null);
      if (savedConversationId && audienceRef.current === sendAudience) {
        setActiveConversationId(savedConversationId);
        fetchConversations(sendAudience);
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const audienceLabel = audience.charAt(0).toUpperCase() + audience.slice(1);
  const planActive = isPaidAudience && subscription?.status === "active";

  const stepStatus = (i) => (loading && i === traceSteps.length - 1 ? "active" : "done");

  return (
    <div className="synora-app" data-theme={theme}>
      <GlobalStyle />

      {desktopTokenLoaded && !signedIn && (
        <div className="synora-auth-wrap">
          <div className="synora-auth-card">
            <div className="synora-brand synora-brand-center">
              <SynoraMark size={44} />
              <h1 className="synora-wordmark">Synora</h1>
            </div>
            <p className="synora-muted" style={{ textAlign: "center", margin: "6px 0 18px" }}>
              Evidence-grounded health guidance
            </p>
            <p className="synora-muted" style={{ textAlign: "center", marginBottom: "1rem" }}>
              Please sign in to continue.
            </p>
            {isDesktop ? (
              <button style={{ ...styles.sendButton, width: "100%" }} onClick={handleDesktopSignIn}>
                Sign In
              </button>
            ) : (
              <SignInButton mode="modal">
                <button style={{ ...styles.sendButton, width: "100%" }}>Sign In</button>
              </SignInButton>
            )}
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
        </div>
      )}

      {desktopTokenLoaded && signedIn && (
        <div className="synora-shell">
          {/* ---------- Left: library ---------- */}
          <aside className={`synora-sidebar${sidebarOpen ? " open" : ""}`} aria-label="Library">
            <div className="synora-brand">
              <SynoraMark size={34} />
              <span className="synora-wordmark">Synora</span>
            </div>

            <div role="group" aria-label="Library view" className="synora-segwrap">
              <button className="seg" aria-pressed={libraryTab === "sources"} onClick={() => setLibraryTab("sources")}>
                Sources
              </button>
              <button className="seg" aria-pressed={libraryTab === "chats"} onClick={() => setLibraryTab("chats")}>
                Chats
              </button>
            </div>

            {libraryTab === "sources" && (
              <div className="synora-tabbody">
                {audience === "doctor" && (
                  <div className="synora-group">
                    <span className="synora-eyebrow">Knowledge base</span>
                    <div className="synora-card synora-card-accent">
                      <span className="synora-card-title">Doctor knowledge base</span>
                      <span className="synora-muted-sm">Clinical guidelines and specialty content. Always used for Doctor answers.</span>
                    </div>
                  </div>
                )}

                <div className="synora-group">
                  <div className="synora-row-between">
                    <span className="synora-eyebrow">Your documents</span>
                    <button
                      className="synora-linkbtn"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                    >
                      <PaperclipIcon size={14} />
                      {uploading ? "Adding..." : "Add PDF"}
                    </button>
                  </div>
                  {uploadedFileName ? (
                    <div className="synora-card">
                      <div className="synora-row-between">
                        <span className="synora-card-title" style={{ wordBreak: "break-word" }}>{uploadedFileName}</span>
                        <button
                          className="synora-x"
                          onClick={() => { setSessionId(null); setUploadedFileName(null); }}
                          aria-label="Stop using this document"
                          title="Stop using this document"
                        >
                          ×
                        </button>
                      </div>
                      <span className="synora-muted-sm">Used in this chat</span>
                    </div>
                  ) : (
                    <p className="synora-muted-sm" style={{ margin: 0, lineHeight: 1.5 }}>
                      No documents added yet. Add a PDF and answers can draw on it.
                    </p>
                  )}
                </div>

                <div className="synora-group">
                  <span className="synora-eyebrow">Folders on this computer</span>
                  <div className="synora-card synora-card-dashed">
                    <span className="synora-muted-sm" style={{ lineHeight: 1.5 }}>
                      Organizing a folder into a private library is coming to the desktop app. You will choose each folder.
                    </span>
                  </div>
                </div>
              </div>
            )}

            {libraryTab === "chats" && (
              <div className="synora-tabbody synora-chatlist">
                <button
                  className="synora-primary-wide"
                  onClick={newConversation}
                  disabled={loading || openingConversation || !hasAccess}
                >
                  <PlusIcon size={14} />
                  New chat
                </button>
                <span className="synora-eyebrow" style={{ paddingTop: 6 }}>{audienceLabel} chats</span>
                <div className="synora-sidebar-list">
                  {!hasAccess ? (
                    <p className="synora-sidebar-empty">
                      Subscribe to the {audience} plan to start and keep chats here.
                    </p>
                  ) : conversationsLoading && conversations.length === 0 ? (
                    <p className="synora-sidebar-empty">Loading chats...</p>
                  ) : conversations.length === 0 ? (
                    <p className="synora-sidebar-empty">
                      No saved chats yet. Ask a question and it will appear here.
                    </p>
                  ) : (
                    conversations.map((c) => (
                      <div
                        key={c.id}
                        className={`synora-chat-row${c.id === activeConversationId ? " active" : ""}`}
                      >
                        <button
                          className="synora-chat-open"
                          onClick={() => openConversation(c.id)}
                          disabled={loading || openingConversation}
                          title={c.title}
                        >
                          <span className="synora-chat-name">{c.title}</span>
                          <span className="synora-chat-date">{formatChatDate(c.updated_at)}</span>
                        </button>
                        <button
                          className="synora-chat-del"
                          onClick={() => deleteConversation(c.id)}
                          disabled={loading || openingConversation}
                          aria-label="Delete chat"
                          title="Delete chat"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            <div style={{ flexGrow: 1 }} />

            {/* Profile: moved here from the top bar, directly above the plan card */}
            {isDesktop ? (
              <button className="synora-profile" onClick={handleDesktopSignOut} aria-label="Sign out">
                <span className="synora-avatar"><SignOutIcon size={16} /></span>
                <span className="synora-profile-text">
                  <span className="synora-card-title">Sign out</span>
                  <span className="synora-muted-sm">End this session</span>
                </span>
              </button>
            ) : (
              <div className="synora-profile">
                <UserButton />
                <span className="synora-profile-text">
                  <span className="synora-card-title">Profile</span>
                  <span className="synora-muted-sm">Account and settings</span>
                </span>
              </div>
            )}

            <div className="synora-plan">
              <div className="synora-row-between">
                <span className="synora-card-title">{audienceLabel} plan</span>
                <span className={`synora-pill${isPaidAudience && !planActive ? " synora-pill-muted" : ""}`}>
                  {!isPaidAudience ? "Free" : planActive ? "Active" : subscriptionLoading ? "Checking" : "Not active"}
                </span>
              </div>
              {planActive && !isDesktop && (
                <>
                  <div className="synora-dl-row">
                    <button
                      className="synora-ghostbtn"
                      onClick={() => fetchDownloadLink("win", audience)}
                      disabled={downloadLoading !== null}
                    >
                      {downloadLoading === "win" ? "Preparing..." : "Windows"}
                    </button>
                    <button
                      className="synora-ghostbtn"
                      onClick={() => fetchDownloadLink("mac", audience)}
                      disabled={downloadLoading !== null}
                    >
                      {downloadLoading === "mac" ? "Preparing..." : "Mac"}
                    </button>
                  </div>
                  <span className="synora-muted-sm" style={{ textAlign: "center" }}>
                    {audience === "doctor" ? "Download the doctor desktop app" : "Download the desktop app"}
                  </span>
                </>
              )}
              {planActive && isDesktop && (
                <span className="synora-muted-sm" style={{ textAlign: "center" }}>You are using the desktop app</span>
              )}
              {!isPaidAudience && (
                <span className="synora-muted-sm" style={{ textAlign: "center" }}>
                  Employee and Doctor plans unlock the desktop app
                </span>
              )}
              {isPaidAudience && !planActive && !subscriptionLoading && (
                <span className="synora-muted-sm" style={{ textAlign: "center" }}>Choose a plan to unlock this audience</span>
              )}
            </div>
          </aside>
          {sidebarOpen && <div className="synora-backdrop" onClick={() => setSidebarOpen(false)} />}

          {/* ---------- Center: conversation ---------- */}
          <main className="synora-main">
            <div className="synora-topbar">
              <button className="synora-chats-toggle" onClick={() => setSidebarOpen(true)}>Library</button>
              <div role="group" aria-label="Who are you checking in as" className="synora-audience">
                {["individual", "employee", "doctor"].map((option) => (
                  <button
                    key={option}
                    onClick={() => setAudience(option)}
                    disabled={loading}
                    aria-pressed={audience === option}
                    className="synora-audience-btn"
                  >
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </div>
              <div role="group" aria-label="Theme" className="synora-segwrap synora-theme">
                <button className="seg" aria-pressed={theme === "light"} aria-label="Light theme" onClick={() => setTheme("light")}>
                  <SunIcon size={17} />
                </button>
                <button className="seg" aria-pressed={theme === "dark"} aria-label="Dark theme" onClick={() => setTheme("dark")}>
                  <MoonIcon size={17} />
                </button>
              </div>
            </div>

            <div className="synora-scroll">
              <div className="synora-column">
                {isPaidAudience && subscriptionLoading && (
                  <p style={styles.emptyState}>Checking your subscription...</p>
                )}

                {isPaidAudience && !subscriptionLoading && subscription?.status !== "active" && (
                  <PricingPanel
                    tier={audience}
                    onSelectPlan={(plan) => startCheckout(plan, audience)}
                    loadingPlan={checkoutLoading}
                    showRefresh={pendingCheckout}
                    onRefresh={() => refreshSubscriptionStatus(audience)}
                    refreshing={subscriptionLoading}
                    isDesktop={isDesktop}
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

                {messages.length === 0 && hasAccess && (
                  <div className="synora-empty">
                    <h1 className="synora-h1">Ask a health question to get started.</h1>
                    <p className="synora-muted">
                      Answers are grounded in the sources you have selected, and each one goes through evidence checks.
                    </p>
                  </div>
                )}

                {messages.map((msg, i) =>
                  msg.role === "user" ? (
                    <div key={i} className="synora-q">
                      <span className="synora-eyebrow">Question</span>
                      <h2 className="synora-h2">{msg.text}</h2>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={`synora-a${msg.error ? " synora-a-error" : ""}${msg.system ? " synora-a-system" : ""}`}
                    >
                      {msg.text}
                      {(msg.emergency || msg.severity || msg.triage) && (
                        <div className="synora-badges">
                          {msg.emergency && <span className="synora-badge synora-badge-urgent">Urgent guidance</span>}
                          {msg.severity && <span className="synora-badge">Severity: {msg.severity}</span>}
                          {msg.triage && <span className="synora-badge">Triage: {String(msg.triage).replaceAll("_", " ")}</span>}
                        </div>
                      )}
                    </div>
                  )
                )}

                {loading && (
                  <p className="synora-loading">
                    {currentStep ? STEP_LABELS[currentStep] || "Processing..." : "Starting..."}
                  </p>
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            <div className="synora-composer-wrap">
              <div className="synora-composer">
                <input
                  type="file"
                  accept="application/pdf"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  style={{ display: "none" }}
                />
                <button
                  onClick={() => fileInputRef.current.click()}
                  className="synora-iconbtn"
                  disabled={uploading}
                  aria-label="Attach a PDF"
                  title="Attach a PDF"
                >
                  <PaperclipIcon size={20} />
                </button>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={hasAccess ? "Ask a health question" : "Subscribe to use this audience"}
                  aria-label="Ask a health question"
                  className="synora-input"
                  disabled={!hasAccess}
                />
                <button
                  onClick={sendMessage}
                  className="synora-send"
                  aria-label="Send"
                  disabled={loading || openingConversation || !hasAccess}
                >
                  <ArrowUpIcon size={20} />
                </button>
              </div>
              <p className="synora-muted-sm" style={{ textAlign: "center", margin: "10px 0 0" }}>
                Not a substitute for professional medical advice.
              </p>
              <Footer />
            </div>
          </main>

          {/* ---------- Right: agent trace ---------- */}
          <aside className="synora-trace" aria-label="Agent trace">
            <div className="synora-row-between">
              <span style={{ fontSize: 15, fontWeight: 700 }}>Agent trace</span>
              {traceSteps.length > 0 && (
                <span className="synora-mono" style={{ color: "var(--accent-text)" }}>
                  {loading ? `${traceSteps.length} so far` : `${traceSteps.length} done`}
                </span>
              )}
            </div>

            {traceSteps.length === 0 ? (
              <p className="synora-muted-sm" style={{ lineHeight: 1.55, margin: 0 }}>
                Send a question to watch the agents work through it, step by step.
              </p>
            ) : (
              <div className="synora-steps">
                {traceSteps.map((step, i) => {
                  const status = stepStatus(i);
                  const last = i === traceSteps.length - 1;
                  return (
                    <div key={`${step}-${i}`} className="synora-step">
                      <div className="synora-step-rail">
                        <span className={`synora-dot ${status}`}>
                          {status === "done" && <CheckIcon size={10} />}
                        </span>
                        {!last && <span className="synora-line" />}
                      </div>
                      <div className="synora-step-body" style={{ paddingBottom: last ? 0 : 14 }}>
                        <span className="synora-mono" style={{ color: "var(--accent-text)" }}>{step}</span>
                        <span style={{ fontSize: 13 }}>{STEP_LABELS[step] || step}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ flexGrow: 1 }} />
            <span className="synora-muted-sm" style={{ lineHeight: 1.55 }}>
              Each citation in an answer should point to a passage the agents retrieved. If one can't be matched to a source, Synora falls back to a cautious answer instead.
            </span>
          </aside>
        </div>
      )}
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

const PricingPanel = ({ tier, onSelectPlan, loadingPlan, showRefresh, onRefresh, refreshing, isDesktop }) => (
  <div style={styles.pricingPanel}>
    <p style={styles.formTitle}>{TIER_COPY[tier].title}</p>
    <p style={styles.formSubtitle}>{TIER_COPY[tier].blurb}</p>

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
      {isDesktop
        ? "You'll be redirected to Stripe's secure checkout in your browser. Cancel anytime."
        : "You'll be redirected to Stripe's secure checkout. Cancel anytime."}
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

// ---------------------------------------------------------------------
// Logo and icons
// ---------------------------------------------------------------------
// Synora mark: two overlapping circles (sources that agree) with the overlap
// filled and a plus cut out of it. Colors come from the theme variables so it
// works in light and dark.
const SynoraMark = ({ size = 34 }) => (
  <div
    role="img"
    aria-label="Synora"
    style={{
      width: size,
      height: size,
      flex: "none",
      borderRadius: Math.round(size * 0.265),
      background: "var(--accent)",
      color: "var(--accent-ink)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    <svg
      width={Math.round(size * 0.7)}
      height={Math.round(size * 0.7)}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="24" r="11.5" strokeWidth="3.4" />
      <circle cx="30" cy="24" r="11.5" strokeWidth="3.4" />
      <path d="M24 14.2A11.5 11.5 0 0 1 24 33.8A11.5 11.5 0 0 1 24 14.2Z" fill="currentColor" stroke="none" />
      <path d="M24 19.5V28.5M19.5 24H28.5" strokeWidth="2.8" style={{ stroke: "var(--accent)" }} />
    </svg>
  </div>
);

const Icon = ({ size = 16, sw = 2, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const PaperclipIcon = ({ size }) => (
  <Icon size={size}><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.8-8.8a3.7 3.7 0 0 1 5.2 5.2l-8.8 8.8a1.8 1.8 0 0 1-2.6-2.6l8-8" /></Icon>
);
const PlusIcon = ({ size }) => (<Icon size={size} sw={2.6}><path d="M12 5v14M5 12h14" /></Icon>);
const ArrowUpIcon = ({ size }) => (<Icon size={size} sw={2.6}><path d="M12 19V5M5 12l7-7 7 7" /></Icon>);
const CheckIcon = ({ size }) => (<Icon size={size} sw={3.2}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>);
const SunIcon = ({ size }) => (
  <Icon size={size}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>
);
const MoonIcon = ({ size }) => (<Icon size={size}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Icon>);
const SignOutIcon = ({ size }) => (<Icon size={size}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Icon>);

const styles = {
  emptyState: { fontSize: "13px", color: "var(--muted)", textAlign: "center", margin: "1.5rem 0" },
  audienceButtons: { display: "flex", gap: "8px", flexWrap: "wrap" },
  audienceButton: {
    flex: 1,
    fontSize: "13px",
    padding: "9px",
    border: "1px solid var(--border-strong)",
    borderRadius: "10px",
    background: "var(--surface)",
    cursor: "pointer",
    color: "var(--muted)",
    fontFamily: "inherit",
  },
  audienceButtonActive: {
    border: "1px solid var(--accent)",
    background: "var(--accent-soft)",
    color: "var(--accent-text)",
    fontWeight: 600,
  },
  sendButton: {
    padding: "10px 18px",
    fontSize: "14px",
    background: "var(--accent)",
    color: "var(--accent-ink)",
    border: "none",
    borderRadius: "10px",
    cursor: "pointer",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  legalConsent: {
    fontSize: "12px",
    color: "var(--muted)",
    textAlign: "center",
    marginTop: "14px",
    lineHeight: 1.6,
  },
  legalLink: { color: "var(--accent-text)", textDecoration: "underline" },
  footer: {
    display: "flex",
    justifyContent: "center",
    gap: "8px",
    marginTop: "10px",
    fontSize: "12px",
    color: "var(--muted)",
  },
  footerDot: { color: "var(--border-strong)" },
  employeeBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    flexWrap: "wrap",
    background: "var(--accent-soft)",
    border: "1px solid var(--accent-border)",
    borderRadius: "12px",
    padding: "10px 14px",
    fontSize: "13px",
    marginBottom: "1rem",
    color: "var(--accent-text)",
  },
  employeeBarText: { fontWeight: 600 },
  employeeBarButton: {
    fontSize: "12px",
    padding: "6px 12px",
    background: "var(--accent)",
    color: "var(--accent-ink)",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  employeeBarButtonGhost: {
    fontSize: "12px",
    padding: "6px 12px",
    background: "transparent",
    color: "var(--accent-text)",
    border: "1px solid var(--accent-border)",
    borderRadius: "8px",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  formPanel: {
    background: "var(--surface2)",
    border: "1px solid var(--border)",
    borderRadius: "14px",
    padding: "1.1rem",
    marginBottom: "1rem",
  },
  formTitle: { fontSize: "15px", fontWeight: 700, color: "var(--text)", margin: "0 0 4px" },
  formSubtitle: { fontSize: "12.5px", color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.5 },
  formLabel: { fontSize: "12.5px", color: "var(--muted)", fontWeight: 600, display: "block", margin: "10px 0 6px" },
  formInput: {
    width: "100%",
    padding: "9px 12px",
    fontSize: "14px",
    border: "1px solid var(--border-strong)",
    borderRadius: "10px",
    outline: "none",
    boxSizing: "border-box",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  formActions: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" },
  formCancelButton: {
    padding: "10px 16px",
    fontSize: "13px",
    background: "transparent",
    color: "var(--muted)",
    border: "1px solid var(--border-strong)",
    borderRadius: "10px",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  sliderLabelRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  sliderValue: { fontSize: "12.5px", color: "var(--accent-text)", fontWeight: 700 },
  pricingPanel: {
    background: "var(--surface2)",
    border: "1px solid var(--border)",
    borderRadius: "14px",
    padding: "1.25rem",
    marginBottom: "1rem",
  },
  pricingCards: { display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap" },
  pricingCard: {
    flex: "1 1 160px",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "12px",
    padding: "14px",
    textAlign: "center",
    position: "relative",
  },
  pricingCardHighlighted: { border: "1.5px solid var(--accent)" },
  pricingBadge: {
    position: "absolute",
    top: "-9px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "var(--accent)",
    color: "var(--accent-ink)",
    fontSize: "10.5px",
    fontWeight: 700,
    padding: "3px 8px",
    borderRadius: "6px",
    margin: 0,
  },
  pricingPlanName: { fontSize: "14px", fontWeight: 700, color: "var(--text)", margin: "6px 0 2px" },
  pricingPrice: { fontSize: "12.5px", color: "var(--muted)", margin: "0 0 12px" },
  pricingNote: { fontSize: "12px", color: "var(--muted)", textAlign: "center", marginTop: "12px" },
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

// "3:42 PM" for today, "Oct 25" otherwise. Empty string if the date is unusable.
const formatChatDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:wght@400;500;600&family=Public+Sans:wght@400;500;600;700&display=swap');

    .synora-app[data-theme="light"] {
      --bg:#f3f6f5; --surface:#ffffff; --surface2:#f7faf9; --border:#dbe4e1; --border-strong:#c3d0cc;
      --text:#14211e; --muted:#4a5b57; --accent:#0f766e; --accent-ink:#ffffff; --accent-soft:#e3f2ef;
      --accent-text:#0b4f49; --accent-border:#bfe0da; --seg-bg:#e6ecea; --warn-bg:#fdf1d8;
      --warn-text:#6a4a12; --warn-border:#f0dba8; --danger:#b3402f; --danger-bg:#fbe9e5;
    }
    .synora-app[data-theme="dark"] {
      --bg:#0b100e; --surface:#0f1513; --surface2:#121a17; --border:#1f2b27; --border-strong:#2a3a35;
      --text:#e6efec; --muted:#93a8a1; --accent:#62e3b1; --accent-ink:#04211a; --accent-soft:#0f2b23;
      --accent-text:#8ff0cb; --accent-border:#1d4a3a; --seg-bg:#121a17; --warn-bg:#2a2310;
      --warn-text:#fbbf24; --warn-border:#5b4514; --danger:#f08a78; --danger-bg:#2c1612;
    }
    body { margin: 0; }
    .synora-app {
      min-height: 100vh; background: var(--bg); color: var(--text);
      font-family: 'Public Sans', system-ui, sans-serif; font-size: 14px;
    }
    .synora-app *, .synora-app *::before, .synora-app *::after { box-sizing: border-box; }
    .synora-app button { font-family: inherit; }
    .synora-app button:focus-visible, .synora-app input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .synora-app button:disabled { cursor: default; }

    .synora-shell { display: flex; min-height: 100vh; }

    /* shared bits */
    .synora-brand { display: flex; align-items: center; gap: 10px; }
    .synora-brand-center { justify-content: center; flex-direction: column; gap: 12px; }
    .synora-wordmark { font-family: 'Newsreader', Georgia, serif; font-size: 22px; font-weight: 600; letter-spacing: -0.2px; margin: 0; }
    .synora-eyebrow { font-size: 12px; font-weight: 700; color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; }
    .synora-muted { color: var(--muted); font-size: 14px; }
    .synora-muted-sm { color: var(--muted); font-size: 12px; }
    .synora-mono { font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
    .synora-row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .synora-group { display: flex; flex-direction: column; gap: 10px; }
    .synora-card { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); background: var(--surface2); border-radius: 10px; padding: 11px 12px; }
    .synora-card-accent { border-color: var(--accent-border); background: var(--accent-soft); }
    .synora-card-dashed { border: 1px dashed var(--border-strong); }
    .synora-card-title { font-size: 13.5px; font-weight: 600; }
    .synora-pill { font-size: 12px; font-weight: 600; color: var(--accent-text); background: var(--accent-soft); border-radius: 999px; padding: 3px 10px; }
    .synora-pill-muted { color: var(--muted); background: var(--seg-bg); }
    .synora-linkbtn { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--accent-text); background: transparent; border: none; cursor: pointer; padding: 2px 0; }
    .synora-linkbtn:disabled { opacity: 0.6; }
    .synora-x { background: none; border: none; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .synora-ghostbtn { flex: 1; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--accent-border); background: var(--surface); color: var(--accent-text); font-size: 13px; font-weight: 600; cursor: pointer; }
    .synora-ghostbtn:disabled { opacity: 0.6; }
    .synora-dl-row { display: flex; gap: 8px; }

    /* segmented controls */
    .synora-segwrap { display: flex; background: var(--seg-bg); border-radius: 10px; padding: 3px; gap: 2px; }
    .synora-app .seg { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; border: none; cursor: pointer; background: transparent; color: var(--muted); border-radius: 8px; padding: 8px; font-size: 13px; font-weight: 600; }
    .synora-app .seg[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-text); box-shadow: inset 0 0 0 1px var(--accent-border); }
    .synora-theme { flex: none; }
    .synora-theme .seg { width: 36px; height: 30px; padding: 0; flex: none; }

    /* sidebar */
    .synora-sidebar {
      width: 300px; flex: none; background: var(--surface); border-right: 1px solid var(--border);
      padding: 22px 18px; display: flex; flex-direction: column; gap: 20px;
      position: sticky; top: 0; height: 100vh; overflow-y: auto;
    }
    .synora-tabbody { display: flex; flex-direction: column; gap: 20px; }
    .synora-chatlist { gap: 10px; min-height: 0; }
    .synora-primary-wide { width: 100%; padding: 10px 12px; border-radius: 10px; background: var(--accent); color: var(--accent-ink); border: none; font-size: 13.5px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; }
    .synora-primary-wide:disabled { opacity: 0.5; }
    .synora-sidebar-list { display: flex; flex-direction: column; gap: 2px; }
    .synora-sidebar-empty { font-size: 12.5px; color: var(--muted); margin: 8px 2px; line-height: 1.5; }
    .synora-chat-row { display: flex; align-items: center; border: 1px solid transparent; border-radius: 10px; }
    .synora-chat-row:hover { background: var(--surface2); }
    .synora-chat-row.active { background: var(--accent-soft); border-color: var(--accent-border); }
    .synora-chat-open { flex: 1; min-width: 0; text-align: left; background: none; border: none; cursor: pointer; color: var(--text); padding: 9px 12px; display: flex; flex-direction: column; gap: 2px; }
    .synora-chat-name { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .synora-chat-row.active .synora-chat-name { font-weight: 600; }
    .synora-chat-date { font-size: 12px; color: var(--muted); }
    .synora-chat-del { background: none; border: none; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 6px 10px; border-radius: 8px; opacity: 0; }
    .synora-chat-row:hover .synora-chat-del, .synora-chat-row.active .synora-chat-del, .synora-chat-del:focus-visible { opacity: 1; }
    .synora-chat-del:hover { color: var(--danger); }
    .synora-chat-open:disabled, .synora-chat-del:disabled { opacity: 0.5; }
    @media (hover: none) { .synora-chat-del { opacity: 1; } }

    /* profile row (above the plan card) */
    .synora-profile { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; border: 1px solid transparent; background: transparent; color: var(--text); text-align: left; margin-bottom: -8px; }
    button.synora-profile { cursor: pointer; }
    button.synora-profile:hover { background: var(--surface2); border-color: var(--border); }
    .synora-profile-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .synora-avatar { width: 34px; height: 34px; flex: none; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: flex; align-items: center; justify-content: center; }

    .synora-plan { border: 1px solid var(--border); background: var(--surface2); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }

    /* main */
    .synora-main { flex: 1 1 auto; min-width: 0; height: 100vh; display: flex; flex-direction: column; }
    .synora-topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 22px 40px 0; }
    .synora-audience { display: flex; gap: 8px; flex-wrap: wrap; }
    .synora-audience-btn { padding: 7px 16px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--muted); font-size: 13px; font-weight: 500; cursor: pointer; }
    .synora-audience-btn[aria-pressed="true"] { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); font-weight: 600; }
    .synora-audience-btn:disabled { opacity: 0.6; }
    .synora-scroll { flex: 1 1 auto; overflow-y: auto; padding: 24px 40px 8px; }
    .synora-column { max-width: 760px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
    .synora-h1 { margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 32px; line-height: 1.2; font-weight: 500; letter-spacing: -0.3px; }
    .synora-h2 { margin: 0; font-family: 'Newsreader', Georgia, serif; font-size: 26px; line-height: 1.25; font-weight: 500; letter-spacing: -0.2px; }
    .synora-empty { display: flex; flex-direction: column; gap: 10px; padding-top: 8vh; }
    .synora-q { display: flex; flex-direction: column; gap: 8px; animation: fadeSlideIn 0.25s ease; }
    .synora-a { font-family: 'Newsreader', Georgia, serif; font-size: 19.5px; line-height: 1.65; white-space: pre-wrap; animation: fadeSlideIn 0.25s ease; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
    .synora-a-system { font-family: 'Public Sans', system-ui, sans-serif; font-size: 13.5px; color: var(--muted); border-bottom: none; padding-bottom: 0; }
    .synora-a-error { font-family: 'Public Sans', system-ui, sans-serif; font-size: 13.5px; color: var(--danger); background: var(--danger-bg); border-radius: 10px; padding: 10px 14px; border-bottom: none; }
    .synora-badges { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; font-family: 'Public Sans', system-ui, sans-serif; }
    .synora-badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: var(--warn-bg); color: var(--warn-text); border: 1px solid var(--warn-border); }
    .synora-badge-urgent { background: var(--danger-bg); color: var(--danger); border-color: var(--danger); }
    .synora-loading { margin: 0; font-size: 13px; color: var(--accent-text); font-style: italic; animation: pulse 1.4s ease-in-out infinite; }

    .synora-composer-wrap { padding: 8px 40px 20px; }
    .synora-composer { max-width: 760px; margin: 0 auto; display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 16px; padding: 8px 8px 8px 10px; }
    .synora-composer-wrap > p, .synora-composer-wrap > div:last-child { max-width: 760px; margin-left: auto; margin-right: auto; }
    .synora-iconbtn { width: 40px; height: 40px; flex: none; border-radius: 10px; border: none; background: transparent; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .synora-input { flex: 1; min-width: 0; padding: 10px 6px; font-family: inherit; font-size: 15px; border: none; background: transparent; color: var(--text); outline: none; }
    .synora-input::placeholder { color: var(--muted); }
    .synora-send { width: 42px; height: 42px; flex: none; border-radius: 50%; border: none; background: var(--accent); color: var(--accent-ink); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .synora-send:disabled { opacity: 0.45; }

    /* agent trace */
    .synora-trace { width: 320px; flex: none; background: var(--surface); border-left: 1px solid var(--border); padding: 22px 22px 26px; display: flex; flex-direction: column; gap: 18px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
    .synora-steps { display: flex; flex-direction: column; }
    .synora-step { display: flex; gap: 12px; }
    .synora-step-rail { display: flex; flex-direction: column; align-items: center; }
    .synora-step-body { display: flex; flex-direction: column; gap: 2px; }
    .synora-dot { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--accent); display: flex; align-items: center; justify-content: center; flex: none; }
    .synora-dot.done { background: var(--accent-soft); color: var(--accent-text); }
    .synora-dot.active { border-style: dashed; animation: pulse 1.2s ease-in-out infinite; }
    .synora-line { width: 2px; flex-grow: 1; min-height: 14px; background: var(--border); }

    /* signed-out */
    .synora-auth-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem 1rem; }
    .synora-auth-card { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 2rem 1.75rem; }

    .synora-chats-toggle, .synora-backdrop { display: none; }
    .synora-chats-toggle { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--accent-text); font-size: 13px; font-weight: 600; cursor: pointer; }

    @media (max-width: 1180px) { .synora-trace { display: none; } }
    @media (max-width: 820px) {
      .synora-sidebar {
        position: fixed; top: 0; left: 0; bottom: 0; height: auto; z-index: 50;
        width: 300px; max-width: 88vw; transform: translateX(-105%); transition: transform 0.2s ease;
      }
      .synora-sidebar.open { transform: none; }
      .synora-backdrop { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); z-index: 40; }
      .synora-chats-toggle { display: block; }
      .synora-topbar { padding: 16px 16px 0; }
      .synora-scroll { padding: 18px 16px 8px; }
      .synora-composer-wrap { padding: 8px 16px 16px; }
      .synora-h1 { font-size: 26px; }
      .synora-h2 { font-size: 22px; }
      .synora-a { font-size: 18px; }
    }
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
