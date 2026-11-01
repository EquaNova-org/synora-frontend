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

  const fetchDownloadLink = async (platform) => {
    setDownloadLoading(platform);
    try {
      const token = await getAuthToken();
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
      for (const step of stepQueue) {
        setCurrentStep(step);
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

  return (
    <div style={styles.page}>
      <GlobalStyle />

      {desktopTokenLoaded && !signedIn && (
        <div style={styles.container}>
          <div style={styles.header}>
            <div style={styles.logo}>S</div>
            <h1 style={styles.title}>Synora</h1>
            <p style={styles.subtitle}>Evidence-grounded health guidance</p>
          </div>
          <p style={{ textAlign: "center", fontSize: "13px", color: "#7c8b87", marginBottom: "1rem" }}>
            Please sign in to continue.
          </p>
          {isDesktop ? (
            <button style={styles.sendButton} onClick={handleDesktopSignIn}>
              Sign In
            </button>
          ) : (
            <SignInButton mode="modal">
              <button style={styles.sendButton}>Sign In</button>
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
      )}

      {desktopTokenLoaded && signedIn && (
        <div className="synora-shell">
        <aside className={`synora-sidebar${sidebarOpen ? " open" : ""}`} aria-label="Chat history">
          <div className="synora-sidebar-head">
            <span className="synora-sidebar-title">
              {audience.charAt(0).toUpperCase() + audience.slice(1)} chats
            </span>
            <button
              className="synora-newchat"
              onClick={newConversation}
              disabled={loading || openingConversation || !hasAccess}
            >
              + New
            </button>
          </div>
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
        </aside>
        {sidebarOpen && <div className="synora-backdrop" onClick={() => setSidebarOpen(false)} />}

        <div style={{ ...styles.container, position: "relative", flex: "1 1 auto", minWidth: 0 }}>
          <button className="synora-chats-toggle" onClick={() => setSidebarOpen(true)}>
            Chats
          </button>
          <div style={{ position: "absolute", top: "1rem", right: "1rem" }}>
            {isDesktop ? (
              <button style={styles.signOutButton} onClick={handleDesktopSignOut}>
                Sign Out
              </button>
            ) : (
              <UserButton />
            )}
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
                  disabled={loading}
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
              placeholder={hasAccess ? "Ask a health question" : "Subscribe to use this audience"}
              style={styles.input}
              disabled={!hasAccess}
            />
            <button onClick={sendMessage} style={styles.sendButton} disabled={loading || openingConversation || !hasAccess}>
              Send
            </button>
          </div>

          <p style={styles.disclaimer}>Not a substitute for professional medical advice.</p>
          <Footer />
        </div>
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
  signOutButton: {
    padding: "6px 12px",
    fontSize: "12px",
    background: "transparent",
    color: "#5c6f69",
    border: "1px solid #d8ded9",
    borderRadius: "8px",
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
    .synora-shell {
      display: flex; gap: 16px; align-items: flex-start; justify-content: center;
      width: 100%; max-width: 760px;
    }
    .synora-sidebar {
      width: 240px; flex: none; box-sizing: border-box;
      background: #ffffff; border: 1px solid #eceae4; border-radius: 20px;
      box-shadow: 0 4px 24px rgba(20, 40, 40, 0.06);
      padding: 1rem; display: flex; flex-direction: column;
      position: sticky; top: 1.5rem; max-height: calc(100vh - 3rem);
    }
    .synora-sidebar-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .synora-sidebar-title { font-size: 13px; font-weight: 600; color: #1c2b28; }
    .synora-newchat {
      font-size: 12px; font-weight: 500; color: #2f6f65; background: #eef5f3;
      border: none; border-radius: 8px; padding: 5px 10px; cursor: pointer;
    }
    .synora-newchat:disabled, .synora-chat-open:disabled, .synora-chat-del:disabled { opacity: 0.5; cursor: default; }
    .synora-sidebar-list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
    .synora-sidebar-empty { font-size: 12px; color: #7c8b87; margin: 8px 2px; line-height: 1.5; }
    .synora-chat-row { display: flex; align-items: center; border-radius: 10px; }
    .synora-chat-row:hover { background: #f4f6f5; }
    .synora-chat-row.active { background: #e6f0ed; }
    .synora-chat-open {
      flex: 1; min-width: 0; text-align: left; background: none; border: none; cursor: pointer;
      padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; font-family: inherit;
    }
    .synora-chat-name {
      font-size: 13px; color: #1c2b28; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .synora-chat-date { font-size: 11px; color: #9aa7a3; }
    .synora-chat-del {
      background: none; border: none; color: #9aa7a3; font-size: 18px; line-height: 1;
      cursor: pointer; padding: 6px 10px; border-radius: 8px; opacity: 0;
    }
    .synora-chat-row:hover .synora-chat-del, .synora-chat-row.active .synora-chat-del,
    .synora-chat-del:focus-visible { opacity: 1; }
    .synora-chat-del:hover { color: #b3402f; }
    .synora-chats-toggle, .synora-backdrop { display: none; }
    @media (hover: none) { .synora-chat-del { opacity: 1; } }
    @media (max-width: 820px) {
      .synora-shell { display: block; max-width: 480px; }
      .synora-sidebar {
        position: fixed; top: 0; left: 0; bottom: 0; max-height: none; z-index: 50;
        width: 280px; max-width: 85vw; border-radius: 0 20px 20px 0;
        transform: translateX(-105%); transition: transform 0.2s ease;
      }
      .synora-sidebar.open { transform: none; }
      .synora-backdrop { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 40; }
      .synora-chats-toggle {
        display: block; position: absolute; top: 1rem; left: 1rem; z-index: 1;
        font-size: 12px; font-weight: 500; color: #2f6f65; background: #eef5f3;
        border: none; border-radius: 8px; padding: 6px 12px; cursor: pointer;
      }
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
