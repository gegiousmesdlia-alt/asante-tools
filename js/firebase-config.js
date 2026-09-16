// ==========================================================================
// Firebase initialization — same project as the public site and admin
// panel (asantereal-estates), since this tool writes into the shared
// "messages" collection so seeded conversations show up in the real
// admin panel's Messages tab for review/reply.
// ==========================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDCu8Io222csh6wHDirTiwSL5zbv6jU0-E",
  authDomain: "asantereal-estates.firebaseapp.com",
  projectId: "asantereal-estates",
  storageBucket: "asantereal-estates.firebasestorage.app",
  messagingSenderId: "976239654869",
  appId: "1:976239654869:web:92ed0bd406508120236f5c"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// The PUBLIC SITE's deployed URL — this tool is a separate Vercel project
// with no /api functions of its own, so anything needing a serverless
// function (fetching the push VAPID public key, saving a push subscription,
// pinging the admin panel on a new guest reply) calls the public site's
// domain instead. Keep this in sync with the same constant in the admin
// panel's firebase-config.js — they should point at the same deployment.
// TODO: replace with your real public site URL once deployed, e.g.
// "https://asante-public-site.vercel.app" (no trailing slash).
export const PUBLIC_SITE_BASE_URL = "https://asante-public-site.vercel.app";
