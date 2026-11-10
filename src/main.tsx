import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { PairingPage } from "./components/camera/PairingPage";

/**
 * Two entry views:
 *  - `?pair=<sessionId>&token=<token>` → mobile camera pairing page (phone)
 *  - everything else                   → the existing BHARAT-AV dashboard
 */
const params = new URLSearchParams(window.location.search);
const isPairingView = params.has("pair") && params.has("token");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isPairingView ? <PairingPage /> : <App />}</StrictMode>
);
