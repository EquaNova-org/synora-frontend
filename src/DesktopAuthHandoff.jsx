import { useEffect, useState } from "react";
import { SignedIn, SignedOut, RedirectToSignIn, useAuth } from "@clerk/clerk-react";

const API_BASE = "https://web-production-85687.up.railway.app";
const API_KEY = import.meta.env.VITE_APP_API_KEY;

// Opened by the desktop app's system browser (see electron/main.js +
// App.jsx's handleDesktopSignIn) once the user clicks "Sign In" there.
// Runs on the real https origin, so Clerk's normal cookie-based sign-in
// works exactly like it does for the individual/web tier -- no app://
// origin problems here. Once signed in, mints the desktop app's own signed
// token via the backend (see desktop_auth.py) and hands it back to the
// desktop app through the synora://auth deep link. The desktop app uses
// this token directly for all its own API calls afterward -- it does not
// try to establish a Clerk session inside its own app:// origin, which is
// what caused the sign-in bounce-back loop there.
export default function DesktopAuthHandoff() {
  const { getToken } = useAuth();
  const [status, setStatus] = useState("working"); // "working" | "done" | "error"

  useEffect(() => {
    let cancelled = false;

    const handoff = async () => {
      try {
        const token = await getToken();
        const res = await fetch(`${API_BASE}/api/auth/desktop-handoff`, {
          method: "POST",
          headers: { "X-API-Key": API_KEY, Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Failed to create desktop sign-in token");
        const data = await res.json();
        if (cancelled) return;
        setStatus("done");
        window.location.href = `synora://auth?token=${encodeURIComponent(data.token)}`;
      } catch (err) {
        console.error("Desktop handoff failed:", err);
        if (!cancelled) setStatus("error");
      }
    };

    handoff();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "3rem 1.5rem", color: "#3a4a45" }}>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
      <SignedIn>
        {status === "working" && <p>Signing you into the Synora desktop app...</p>}
        {status === "done" && <p>You're signed in. You can close this tab and return to the Synora app.</p>}
        {status === "error" && (
          <p>
            Something went wrong completing sign-in. Please close this tab and try the "Sign In" button in the
            Synora app again.
          </p>
        )}
      </SignedIn>
    </div>
  );
}
