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
