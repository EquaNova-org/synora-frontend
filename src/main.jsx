import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App.jsx";
import DesktopAuthHandoff from "./DesktopAuthHandoff.jsx";
import "./index.css";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// /desktop-auth is opened in the system browser by the packaged desktop app
// (see electron/main.js + App.jsx's handleDesktopSignIn) -- it's a tiny
// dedicated page, not part of the main app's own navigation, so a plain path
// check is enough without pulling in a router just for this one route.
const isDesktopAuthHandoff = window.location.pathname === "/desktop-auth";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      {isDesktopAuthHandoff ? <DesktopAuthHandoff /> : <App />}
    </ClerkProvider>
  </StrictMode>
);
