import { auth, db, PUBLIC_SITE_BASE_URL } from "./firebase-config.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection, addDoc, doc, getDoc, getDocs, query, where, orderBy, limit,
  serverTimestamp, writeBatch, onSnapshot, updateDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const loginScreen = document.getElementById("login-screen");
const dashboard = document.getElementById("dashboard");
const loginError = document.getElementById("login-error");
const main = document.getElementById("main");

// Unread pills always show an exact count (1-8) or "9+" — matches the
// admin panel's own badge exactly so both apps read the same way.
function formatCount(n) { return n >= 9 ? "9+" : String(n); }

// Same admin whitelist as the main admin panel (admins/{uid} in Firestore)
// — this tool writes into the same shared "messages"/"reviews" data, so
// it's gated the same way.
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.style.display = "none";
  try {
    await signInWithEmailAndPassword(auth, document.getElementById("a-email").value, document.getElementById("a-pass").value);
  } catch {
    loginError.textContent = "Sign-in failed. Check the email and password.";
    loginError.style.display = "block";
  }
});

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

// ---------- Phone-screen side drawer ----------
const sidebarEl = document.getElementById("sidebar");
const sidebarOverlayEl = document.getElementById("sidebar-overlay");
function closeDrawer() { sidebarEl.classList.remove("open"); sidebarOverlayEl.classList.remove("open"); }
document.getElementById("menu-toggle").addEventListener("click", () => {
  sidebarEl.classList.toggle("open");
  sidebarOverlayEl.classList.toggle("open");
});
sidebarOverlayEl.addEventListener("click", closeDrawer);

// ---------- Push notifications ----------
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

document.getElementById("enable-push-btn").addEventListener("click", async () => {
  const btn = document.getElementById("enable-push-btn");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("Push notifications aren't supported in this browser.");
    return;
  }
  if (Notification.permission === "denied") {
    alert("Notifications were previously blocked for this app. Browsers won't re-prompt once blocked — re-enable them from your browser/OS notification settings for this app, then try again.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "Enabling…";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");

    const keyRes = await fetch(`${PUBLIC_SITE_BASE_URL}/api/vapid-public-key`);
    const keyData = await keyRes.json();
    if (!keyRes.ok) throw new Error(keyData.error || "Could not fetch push key");

    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
    });

    const idToken = await auth.currentUser.getIdToken();
    const saveRes = await fetch(`${PUBLIC_SITE_BASE_URL}/api/admin/save-push-subscription`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ app: "training", subscription: subscription.toJSON() })
    });
    const saveData = await saveRes.json();
    if (!saveRes.ok) throw new Error(saveData.error || "Could not save subscription");

    btn.textContent = "Notifications on ✓";
  } catch (err) {
    console.error("Enable notifications failed:", err);
    btn.disabled = false;
    btn.textContent = "Enable notifications";
    alert("Could not enable notifications: " + err.message);
  }
});

// Pings the admin panel's subscribers — fire-and-forget, never blocks or
// throws on the caller's side (a reply is already saved regardless).
function notifyAdminPanel(text, threadId) {
  auth.currentUser?.getIdToken().then(idToken => {
    fetch(`${PUBLIC_SITE_BASE_URL}/api/admin/send-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        targetApp: "admin",
        title: "New reply in a demo thread",
        body: text,
        url: `./?tab=messages&thread=${encodeURIComponent(threadId)}`
      })
    }).catch(err => console.error("notifyAdminPanel failed:", err));
  }).catch(err => console.error("notifyAdminPanel failed:", err));
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { loginScreen.style.display = "flex"; dashboard.style.display = "none"; if (inboxBadgeUnsub) inboxBadgeUnsub(); return; }
  const adminDoc = await getDoc(doc(db, "admins", user.uid));
  if (!adminDoc.exists()) {
    loginError.textContent = "This account is not authorized for the training tool.";
    loginError.style.display = "block";
    await signOut(auth);
    return;
  }
  loginScreen.style.display = "none";
  dashboard.style.display = "block";
  document.getElementById("signed-in-as").textContent = `Signed in as: ${user.email}`;
  watchInboxBadge();

  // A push notification opened this page with ?tab=inbox&thread=... (see
  // notificationclick in sw.js) — jump straight to that conversation.
  const deepLinkParams = new URLSearchParams(location.search);
  const deepLinkTab = deepLinkParams.get("tab");
  const deepLinkThread = deepLinkParams.get("thread");
  history.replaceState({}, "", location.pathname); // don't re-trigger this on a plain refresh

  const startTab = deepLinkTab === "seeding" ? "seeding" : "inbox";
  if (startTab === "inbox" && deepLinkThread) pendingDeepLinkThreadId = deepLinkThread;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelector(`.tab-btn[data-tab="${startTab}"]`)?.classList.add("active");
  renderTab(startTab);
});

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderTab(btn.dataset.tab);
    closeDrawer();
  });
});

function renderTab(tab) {
  if (tab === "seeding") return renderSeeding();
  return renderInbox();
}

// ==========================================================================
// Inbox — this tool now has its own chat view, scoped to demo (demo:true)
// threads only. It plays the "guest" side; the real admin panel plays the
// "admin" side. Both sides show an unread pill (1-8, or "9+") so whoever's
// running a training exercise can tell at a glance when the other side has
// replied.
// ==========================================================================
let inboxUnsub = null;
let inboxBadgeUnsub = null;
let typingUnsub = null;
let typingListenerThreadId = null;
let pendingDeepLinkThreadId = null; // set from a push notification's ?thread= param

// Kept alive across tabs so the sidebar badge is accurate even while the
// Seeding tab is open, not just while Inbox itself is rendered.
function watchInboxBadge() {
  if (inboxBadgeUnsub) inboxBadgeUnsub();
  const badgeEl = document.getElementById("inbox-tab-badge");
  inboxBadgeUnsub = onSnapshot(
    query(collection(db, "messages"), where("demo", "==", true)),
    (snap) => {
      const n = snap.docs.filter(d => {
        const m = d.data();
        return m.senderType === "admin" && !m.readByGuest;
      }).length;
      badgeEl.style.display = n > 0 ? "" : "none";
      badgeEl.textContent = formatCount(n);
    },
    () => { badgeEl.style.display = "none"; }
  );
}

function threadMetaFor(threadId, msgs) {
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  return {
    threadId,
    kind: first?.kind || (threadId.startsWith("general-") ? "general" : "listing"),
    listingId: first?.listingId ?? msgs.find(m => m.listingId)?.listingId ?? null,
    listingLabel: first?.listingLabel || msgs.find(m => m.listingLabel)?.listingLabel || null,
    senderName: msgs.find(m => m.senderType !== "admin")?.senderName || "Guest",
    guestSenderId: msgs.find(m => m.senderType !== "admin")?.senderId || threadId,
    lastText: last?.text || "",
    lastAt: last?.createdAt,
    unreadCount: msgs.filter(m => m.senderType === "admin" && !m.readByGuest).length
  };
}

function renderInbox() {
  main.innerHTML = `
    <h1>Inbox</h1>
    <p style="font-family:var(--font-mono); font-size:0.78rem; color:var(--muted); line-height:1.6; margin:-14px 0 22px;">
      Plays the guest/buyer side of every seeded demo conversation. Reply from here to practice; the real
      admin replies from the admin panel's Messages tab. Only demo (<span class="badge demo" style="font-size:0.6rem;">DEMO</span>) threads show up here — this is not a general inbox.
    </p>
    <div class="msg-layout" id="msg-layout">
      <div class="panel thread-list-panel" style="padding:0; max-height:70vh; overflow-y:auto;">
        <div id="thread-list"><p style="padding:16px; font-family:var(--font-mono); font-size:0.8rem; color:var(--muted);">Loading…</p></div>
      </div>
      <div class="panel thread-detail-panel" id="thread-detail" style="min-height:300px;">
        <p style="font-family:var(--font-mono); font-size:0.85rem; color:var(--muted);">Select a conversation to view it.</p>
      </div>
    </div>`;

  if (inboxUnsub) inboxUnsub();

  const threadListEl = document.getElementById("thread-list");
  let activeThreadId = null;

  // No orderBy alongside where() here — same reasoning as the public site's
  // js/messaging.js and the admin panel: avoids needing a Firestore
  // composite index. Sorted client-side instead.
  inboxUnsub = onSnapshot(query(collection(db, "messages"), where("demo", "==", true)), (snap) => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    const byThread = {};
    all.forEach(m => { (byThread[m.threadId] ||= []).push(m); });

    const threads = Object.entries(byThread)
      .map(([id, msgs]) => threadMetaFor(id, msgs))
      .sort((a, b) => {
        const bUnread = b.unreadCount > 0 ? 1 : 0, aUnread = a.unreadCount > 0 ? 1 : 0;
        if (bUnread !== aUnread) return bUnread - aUnread; // unread threads first
        return (b.lastAt?.toMillis?.() || 0) - (a.lastAt?.toMillis?.() || 0); // then most-recent-first
      });

    threadListEl.innerHTML = threads.length ? threads.map(t => `
      <div class="thread-row ${t.threadId === activeThreadId ? "active" : ""}" data-thread="${t.threadId}" style="padding:14px 16px; border-bottom:1px solid var(--line); cursor:pointer; ${t.threadId === activeThreadId ? "background:var(--panel-2);" : ""}">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <strong style="font-size:0.9rem;">${t.senderName}</strong>
          <span class="badge demo" style="font-size:0.6rem;">DEMO</span>
        </div>
        <div style="font-family:var(--font-mono); font-size:0.72rem; color:var(--muted); margin-top:3px;">${t.kind === "listing" ? `Re: ${t.listingLabel || "a listing"}` : "General"}</div>
        <div style="font-size:0.82rem; color:var(--muted); margin-top:4px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${t.lastText}</span>
          ${t.unreadCount ? `<span class="badge count" style="flex-shrink:0;">${formatCount(t.unreadCount)}</span>` : ""}
        </div>
      </div>
    `).join("") : `<p style="padding:16px; font-family:var(--font-mono); font-size:0.8rem; color:var(--muted);">No demo conversations yet — seed some from the Seeding tab.</p>`;

    threadListEl.querySelectorAll(".thread-row").forEach(row => {
      row.addEventListener("click", () => openThread(row.dataset.thread, byThread[row.dataset.thread]));
    });

    if (activeThreadId && byThread[activeThreadId]) {
      renderThreadDetail(activeThreadId, byThread[activeThreadId]);
    } else if (pendingDeepLinkThreadId && byThread[pendingDeepLinkThreadId]) {
      const target = pendingDeepLinkThreadId;
      pendingDeepLinkThreadId = null;
      openThread(target, byThread[target]);
    }
  });

  function openThread(threadId, msgs) {
    activeThreadId = threadId;
    document.querySelectorAll(".thread-row").forEach(r => r.classList.toggle("active", r.dataset.thread === threadId));
    renderThreadDetail(threadId, msgs);
    document.getElementById("msg-layout")?.classList.add("detail-open");
    // mark the admin's replies as seen by the guest side
    msgs.filter(m => m.senderType === "admin" && !m.readByGuest).forEach(m => updateDoc(doc(db, "messages", m.id), { readByGuest: true }).catch(() => {}));
  }

  function renderThreadDetail(threadId, msgs) {
    const detail = document.getElementById("thread-detail");
    const meta = threadMetaFor(threadId, msgs);
    detail.innerHTML = `
      <button type="button" class="btn outline small thread-back-btn" id="thread-back-btn">← Back</button>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <div>
          <h3 style="text-transform:none; font-family:var(--font-body); font-size:1.05rem; margin:0;">${meta.senderName} <span class="badge demo" style="font-size:0.6rem; margin-left:6px;">DEMO</span></h3>
          <p style="font-family:var(--font-mono); font-size:0.76rem; color:var(--muted); margin:4px 0 0;">${meta.kind === "listing" ? `About: ${meta.listingLabel || "a listing"}` : "General enquiry"}</p>
        </div>
      </div>
      <div id="thread-transcript" style="max-height:360px; overflow-y:auto; display:flex; flex-direction:column; gap:8px; margin-bottom:14px;">
        ${msgs.map(m => `
          <div style="align-self:${m.senderType === "admin" ? "flex-start" : "flex-end"}; max-width:80%; padding:9px 12px; font-size:0.87rem; background:${m.senderType === "admin" ? "var(--panel-2)" : "var(--brass)"}; color:${m.senderType === "admin" ? "var(--parchment)" : "var(--ink)"};">
            ${m.text}
          </div>`).join("")}
      </div>
      <p class="typing-indicator" id="typing-indicator"></p>
      <form id="reply-form" style="display:flex; gap:8px;">
        <input id="reply-input" type="text" placeholder="Reply as ${meta.senderName}…" style="flex:1; padding:10px 12px; background:var(--panel-2); border:1px solid var(--line); color:var(--parchment);">
        <button class="btn" type="submit">Send</button>
      </form>`;

    const transcriptEl = document.getElementById("thread-transcript");
    transcriptEl.scrollTop = transcriptEl.scrollHeight;

    document.getElementById("thread-back-btn").addEventListener("click", () => {
      document.getElementById("msg-layout")?.classList.remove("detail-open");
    });

    // Subscribe to this thread's typing status once per thread — the
    // inbox listener above re-runs renderThreadDetail on every new message
    // too, and we don't want a fresh typing listener stacking up each time.
    if (typingListenerThreadId !== threadId) {
      if (typingUnsub) typingUnsub();
      typingListenerThreadId = threadId;
      typingUnsub = onSnapshot(doc(db, "typingStatus", threadId), (snap) => {
        const indicatorEl = document.getElementById("typing-indicator");
        if (!indicatorEl) return; // thread panel has moved on
        const t = snap.data();
        const fresh = t?.adminTypingAt && (Date.now() - (t.adminTypingAt.toMillis?.() || 0) < 8000);
        indicatorEl.textContent = (t?.adminTyping && fresh) ? "Admin is typing…" : "";
      }, () => {});
    }

    let typingClearTimeout = null;
    const replyInput = document.getElementById("reply-input");
    replyInput.addEventListener("input", () => {
      setDoc(doc(db, "typingStatus", threadId), { guestTyping: true, guestTypingAt: serverTimestamp() }, { merge: true }).catch(() => {});
      clearTimeout(typingClearTimeout);
      typingClearTimeout = setTimeout(() => {
        setDoc(doc(db, "typingStatus", threadId), { guestTyping: false }, { merge: true }).catch(() => {});
      }, 3000);
    });

    document.getElementById("reply-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("reply-input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      clearTimeout(typingClearTimeout);
      setDoc(doc(db, "typingStatus", threadId), { guestTyping: false }, { merge: true }).catch(() => {});
      await addDoc(collection(db, "messages"), {
        threadId,
        kind: meta.kind,
        listingId: meta.listingId,
        listingLabel: meta.listingLabel,
        senderType: "guest",
        senderId: meta.guestSenderId,
        senderName: meta.senderName,
        senderEmail: null,
        text,
        demo: true,
        createdAt: serverTimestamp(),
        read: false,
        readByGuest: true
      });
      notifyAdminPanel(`${meta.senderName}: ${text}`, threadId);
    });
  }
}

// ==========================================================================
// Seeding — this tool now owns ALL demo seeding (messages + reviews), not
// the admin panel. Both draw from a Firestore "pool" of not-yet-used seed
// entries (seedMessagePool / seedReviewPool): seeding pulls N unused
// entries, writes them into messages/reviews, then marks those specific
// pool entries used:true — so a given seed profile or review is only ever
// sent once, never re-seeded. When a pool runs dry, upload a new JSON file
// to top it back up (format described inline below).
// ==========================================================================
async function renderSeeding() {
  main.innerHTML = `
    <h1>Seeding</h1>

    <div class="panel" style="margin-bottom:20px;">
      <h3 style="margin:0 0 8px; font-family:var(--font-body); font-weight:600; text-transform:none; font-size:1.05rem;">1. Load starter pack</h3>
      <p style="font-family:var(--font-mono); font-size:0.78rem; color:var(--muted); margin:0 0 14px;">
        One-time (or repeatable) generator: adds 220 varied simulated buyer profiles and 220 varied
        reviews into the two pools below. None are fake accounts (guests never need one to message),
        and none assert a payment as already-completed fact — see the README for why.
      </p>
      <button class="btn outline" id="starter-pack-btn">Generate starter pack (220 + 220)</button>
      <p id="starter-status" style="font-family:var(--font-mono); font-size:0.78rem; margin-top:12px;"></p>
    </div>

    <div class="panel" style="margin-bottom:20px;">
      <h3 style="margin:0 0 8px; font-family:var(--font-body); font-weight:600; text-transform:none; font-size:1.05rem;">2. Seed message conversations</h3>
      <p class="pool-status" id="message-pool-status">Checking pool…</p>
      <div class="seed-count-row">
        <div class="field"><label>How many</label><input type="number" id="seed-msg-count" value="20" min="1"></div>
        <button class="btn" id="seed-msg-btn">Seed conversations</button>
      </div>
      <p id="seed-msg-status" style="font-family:var(--font-mono); font-size:0.78rem; margin-top:12px;"></p>
      <div id="message-upload-block" style="display:none; margin-top:16px; border-top:1px solid var(--line); padding-top:16px;">
        <p style="font-family:var(--font-mono); font-size:0.78rem; color:var(--rust); margin:0 0 10px;">
          <strong>Pool is empty.</strong> Ask Claude to generate a JSON file of new conversation profiles, then upload it here to keep seeding.
        </p>
        <p style="font-family:var(--font-mono); font-size:0.72rem; color:var(--muted); margin:0 0 10px;">
          Format: a JSON array of objects — <code>{"senderName": "...", "kind": "general"|"listing", "listingLabel": "..." (optional), "messages": [{"from": "guest"|"admin", "text": "..."}]}</code>
        </p>
        <div class="upload-row">
          <input type="file" id="message-pool-upload" accept="application/json">
          <span id="message-upload-status" style="font-family:var(--font-mono); font-size:0.78rem;"></span>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:20px;">
      <h3 style="margin:0 0 8px; font-family:var(--font-body); font-weight:600; text-transform:none; font-size:1.05rem;">3. Seed reviews</h3>
      <p class="pool-status" id="review-pool-status">Checking pool…</p>
      <div class="seed-count-row">
        <div class="field"><label>How many</label><input type="number" id="seed-review-count" value="20" min="1"></div>
        <button class="btn" id="seed-review-btn">Seed reviews</button>
      </div>
      <p id="seed-review-status" style="font-family:var(--font-mono); font-size:0.78rem; margin-top:12px;"></p>
      <div id="review-upload-block" style="display:none; margin-top:16px; border-top:1px solid var(--line); padding-top:16px;">
        <p style="font-family:var(--font-mono); font-size:0.78rem; color:var(--rust); margin:0 0 10px;">
          <strong>Pool is empty.</strong> Ask Claude to generate a JSON file of new reviews, then upload it here to keep seeding.
        </p>
        <p style="font-family:var(--font-mono); font-size:0.72rem; color:var(--muted); margin:0 0 10px;">
          Format: a JSON array of objects — <code>{"displayName": "First L.", "rating": 1-5, "propertyLabel": "...", "text": "...", "adminReply": "" (optional)}</code>
        </p>
        <div class="upload-row">
          <input type="file" id="review-pool-upload" accept="application/json">
          <span id="review-upload-status" style="font-family:var(--font-mono); font-size:0.78rem;"></span>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3 style="margin:0 0 8px; font-family:var(--font-body); font-weight:600; text-transform:none; font-size:1.05rem;">4. Clear demo data</h3>
      <p style="font-family:var(--font-mono); font-size:0.78rem; color:var(--muted); margin:0 0 16px;">
        Deletes every demo thread/review this tool created (already-used pool entries stay used — clearing
        does not return them to the pool). Run this before real traffic starts using the admin panel.
      </p>
      <div style="display:flex; gap:10px;">
        <button class="btn danger" id="clear-msg-btn">Clear demo conversations</button>
        <button class="btn danger" id="clear-review-btn">Clear demo reviews</button>
      </div>
      <p id="clear-status" style="font-family:var(--font-mono); font-size:0.78rem; margin-top:12px;"></p>
    </div>
  `;

  document.getElementById("starter-pack-btn").addEventListener("click", loadStarterPack);
  document.getElementById("seed-msg-btn").addEventListener("click", seedMessages);
  document.getElementById("seed-review-btn").addEventListener("click", seedReviews);
  document.getElementById("message-pool-upload").addEventListener("change", (e) => uploadPool(e, "seedMessagePool", "message-upload-status", validateMessagePoolEntry));
  document.getElementById("review-pool-upload").addEventListener("change", (e) => uploadPool(e, "seedReviewPool", "review-upload-status", validateReviewPoolEntry));
  document.getElementById("clear-msg-btn").addEventListener("click", clearDemoMessages);
  document.getElementById("clear-review-btn").addEventListener("click", clearDemoReviews);

  refreshPoolStatus();
}

async function refreshPoolStatus() {
  const [msgAvail, reviewAvail] = await Promise.all([
    countUnused("seedMessagePool"),
    countUnused("seedReviewPool")
  ]);

  const msgStatusEl = document.getElementById("message-pool-status");
  const reviewStatusEl = document.getElementById("review-pool-status");
  if (msgStatusEl) {
    msgStatusEl.innerHTML = `<strong>${msgAvail}</strong> unused conversation profile${msgAvail === 1 ? "" : "s"} available.`;
    document.getElementById("message-upload-block").style.display = msgAvail === 0 ? "block" : "none";
  }
  if (reviewStatusEl) {
    reviewStatusEl.innerHTML = `<strong>${reviewAvail}</strong> unused review${reviewAvail === 1 ? "" : "s"} available.`;
    document.getElementById("review-upload-block").style.display = reviewAvail === 0 ? "block" : "none";
  }
}

async function countUnused(collectionName) {
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("used", "==", false)));
    return snap.size;
  } catch {
    return 0;
  }
}

// ---------- Seed message conversations (pulls from seedMessagePool) ----------
async function seedMessages() {
  const statusEl = document.getElementById("seed-msg-status");
  const requested = Math.max(1, parseInt(document.getElementById("seed-msg-count").value, 10) || 0);

  if (!confirm(`This writes up to ${requested} simulated buyer conversations into the shared "messages" data for customer-service training/testing — NOT real customers. Continue?`)) return;

  statusEl.textContent = "Seeding…";
  try {
    const snap = await getDocs(query(collection(db, "seedMessagePool"), where("used", "==", false), limit(requested)));
    if (snap.empty) {
      statusEl.textContent = "No unused profiles available in the pool — upload a seed file below to continue.";
      refreshPoolStatus();
      return;
    }

    let conversationsWritten = 0;
    let messagesWritten = 0;
    const usedBatch = writeBatch(db);

    for (const poolDoc of snap.docs) {
      const convo = poolDoc.data();
      const guestId = `seed-${poolDoc.id}`;
      const threadId = convo.kind === "listing" ? `listing-demo-${guestId}` : `general-${guestId}`;
      for (const m of (convo.messages || [])) {
        await addDoc(collection(db, "messages"), {
          threadId,
          kind: convo.kind === "listing" ? "listing" : "general",
          listingId: null,
          listingLabel: convo.listingLabel || null,
          senderType: m.from === "admin" ? "admin" : "guest",
          senderId: m.from === "admin" ? "admin" : guestId,
          senderName: m.from === "admin" ? "Asante & Grove" : (convo.senderName || "Guest"),
          senderEmail: null,
          text: m.text,
          demo: true,
          createdAt: serverTimestamp(),
          read: m.from === "admin" ? true : false,
          readByGuest: true // seeded history itself isn't a "new" unread reply for either side
        });
        messagesWritten++;
      }
      usedBatch.update(poolDoc.ref, { used: true, usedAt: serverTimestamp() });
      conversationsWritten++;
    }
    await usedBatch.commit();

    const shortfall = requested - conversationsWritten;
    statusEl.textContent = shortfall > 0
      ? `Seeded ${conversationsWritten} conversation${conversationsWritten === 1 ? "" : "s"} (${messagesWritten} messages) — only that many were left in the pool. Upload more to seed the rest.`
      : `Done — seeded ${conversationsWritten} conversations (${messagesWritten} messages). Check the Inbox tab or the admin panel's Messages tab.`;
  } catch (err) {
    statusEl.textContent = "Could not seed: " + err.message;
  }
  refreshPoolStatus();
}

// ---------- Seed reviews (pulls from seedReviewPool) ----------
async function seedReviews() {
  const statusEl = document.getElementById("seed-review-status");
  const requested = Math.max(1, parseInt(document.getElementById("seed-review-count").value, 10) || 0);

  if (!confirm(`This writes up to ${requested} clearly-labeled DEMO reviews so you can preview the site under real volume. They are NOT real customers — clear them before the site goes live. Continue?`)) return;

  statusEl.textContent = "Seeding…";
  try {
    const snap = await getDocs(query(collection(db, "seedReviewPool"), where("used", "==", false), limit(requested)));
    if (snap.empty) {
      statusEl.textContent = "No unused reviews available in the pool — upload a seed file below to continue.";
      refreshPoolStatus();
      return;
    }

    let written = 0;
    const usedBatch = writeBatch(db);
    for (const poolDoc of snap.docs) {
      const r = poolDoc.data();
      await addDoc(collection(db, "reviews"), {
        displayName: r.displayName,
        rating: r.rating,
        propertyLabel: r.propertyLabel || "",
        text: r.text,
        adminReply: r.adminReply || "",
        approved: true,
        verified: true,
        demo: true,
        createdAt: serverTimestamp()
      });
      usedBatch.update(poolDoc.ref, { used: true, usedAt: serverTimestamp() });
      written++;
    }
    await usedBatch.commit();

    const shortfall = requested - written;
    statusEl.textContent = shortfall > 0
      ? `Seeded ${written} review${written === 1 ? "" : "s"} — only that many were left in the pool. Upload more to seed the rest.`
      : `Done — seeded ${written} reviews. Check the admin panel's Reviews tab.`;
  } catch (err) {
    statusEl.textContent = "Could not seed: " + err.message;
  }
  refreshPoolStatus();
}

// ---------- Upload a seed file to top up an empty (or low) pool ----------
function validateMessagePoolEntry(e) {
  return e && typeof e.senderName === "string" && Array.isArray(e.messages) && e.messages.length > 0
    && e.messages.every(m => (m.from === "guest" || m.from === "admin") && typeof m.text === "string");
}
function validateReviewPoolEntry(e) {
  return e && typeof e.displayName === "string" && Number.isInteger(e.rating) && e.rating >= 1 && e.rating <= 5 && typeof e.text === "string";
}

async function uploadPool(event, collectionName, statusElId, validate) {
  const file = event.target.files[0];
  const statusEl = document.getElementById(statusElId);
  if (!file) return;
  statusEl.textContent = "Reading file…";
  try {
    const text = await file.text();
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error("File must contain a JSON array.");
    const valid = entries.filter(validate);
    if (!valid.length) throw new Error("No valid entries found — check the format shown above.");

    let written = 0;
    for (let i = 0; i < valid.length; i += 450) {
      const chunk = valid.slice(i, i + 450);
      const batch = writeBatch(db);
      chunk.forEach(entry => {
        const ref = doc(collection(db, collectionName));
        batch.set(ref, { ...entry, used: false, addedAt: serverTimestamp() });
      });
      await batch.commit();
      written += chunk.length;
    }
    statusEl.textContent = `Added ${written} of ${entries.length} entries to the pool${valid.length < entries.length ? " (some were skipped — invalid format)" : ""}.`;
  } catch (err) {
    statusEl.textContent = "Could not upload: " + err.message;
  }
  event.target.value = "";
  refreshPoolStatus();
}

// ---------- Clear demo data ----------
async function clearDemoMessages() {
  if (!confirm("Delete every demo/training conversation? This cannot be undone. (Already-used pool entries stay used.)")) return;
  const statusEl = document.getElementById("clear-status");
  statusEl.textContent = "Clearing conversations…";
  try {
    const snap = await getDocs(query(collection(db, "messages"), where("demo", "==", true)));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    statusEl.textContent = `Done — cleared ${docs.length} demo message${docs.length === 1 ? "" : "s"}.`;
  } catch (err) {
    statusEl.textContent = "Could not clear demo conversations: " + err.message;
  }
}

async function clearDemoReviews() {
  if (!confirm("Delete every demo review? This cannot be undone. (Already-used pool entries stay used.)")) return;
  const statusEl = document.getElementById("clear-status");
  statusEl.textContent = "Clearing reviews…";
  try {
    const snap = await getDocs(query(collection(db, "reviews"), where("demo", "==", true)));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    statusEl.textContent = `Done — cleared ${docs.length} demo review${docs.length === 1 ? "" : "s"}.`;
  } catch (err) {
    statusEl.textContent = "Could not clear demo reviews: " + err.message;
  }
}

// ==========================================================================
// Starter pack generator — combinatorial, not hand-written one-by-one:
// combines name/city/property/template pools to produce 220 distinct
// message-profile pool entries and 220 distinct review pool entries in one
// click. Existing behavior/constraints preserved from the original 14-item
// seeder: no fake accounts, no message asserts a payment as completed fact
// (claims are always phrased as the buyer's claim, never as narration).
// ==========================================================================
const FIRST_NAMES = ["Karen","Meredith","Marcus","Priya","Jerome","Angela","David","Fatima","Lin","Rebecca","Oluwaseun","Grace","Tyler","Tomás","Diane","Steven","Patricia","Gerald","Linda","Robert","Susan","James","Barbara","William","Nancy","Richard","Betty","Charles","Sandra","Thomas","Donna","Joseph","Carol","Daniel","Ruth","Kenneth","Aisha","Miguel","Chioma","Noah","Yuki","Ingrid","Samuel","Elena","Victor","Priyanka","Hassan","Naledi","Diego","Freya"];
const LAST_NAMES = ["Whitfield","Cole","Bell","Patel","Washington","Brooks","Kim","Al-Sayed","Zhao","Sun","Adebayo","Miller","Rivera","Reyes","Okafor","Nguyen","Lindqvist","Haddad","Mensah","Fischer","Contreras","Osei","Kowalski","Abara","Silva","Petrov","Nakamura","Odom","Fontaine","Ibrahim"];
const CITIES = ["Austin, TX","Denver, CO","Phoenix, AZ","Tampa, FL","Charlotte, NC","Raleigh, NC","Nashville, TN","Portland, OR","San Antonio, TX","Indianapolis, IN","Sacramento, CA","Kansas City, MO","Orlando, FL","Pittsburgh, PA","Cincinnati, OH","Salt Lake City, UT","Albuquerque, NM","Richmond, VA","Boise, ID","Columbus, OH"];
const PROPERTY_TYPES = ["2-bed apartment","1-bed condo","3-bed townhome","Studio apartment","4-bed colonial","Ranch-style home","Farmhouse with 2 acres","Downtown loft","Lakefront cottage","Historic brownstone","2-bed duplex","1-bed apartment for rent","3-bed single-family home"];

function pick(arr, i) { return arr[i % arr.length]; }
function propertyLabel(i) { return `${pick(PROPERTY_TYPES, i)}, ${pick(CITIES, i + 3)}`; }
function fullName(i) { return `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i + 5)}`; }
function initialName(i) { return `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i + 5)[0]}.`; }

const MESSAGE_TEMPLATES = [
  (name) => ({ kind: "general", messages: [{ from: "guest", text: `Hi, I already paid for the agency so I'm ready to buy this house. When can I check it and complete the purchase?` }] }),
  (name, listing) => ({ kind: "listing", listingLabel: listing, messages: [
    { from: "guest", text: `I already paid for the agency and I'm ready to buy — when can I see the house and close?` },
    { from: "admin", text: `Thanks for reaching out, ${name.split(" ")[0]}! I don't see a payment on file under your name yet — could you tell me which agent or agency you worked with so I can look into it? In the meantime I'd be glad to get your viewing scheduled this week.` },
    { from: "guest", text: `Oh, I think I'm mixing this up with another property — sorry about that! Yes please, this week works great.` }
  ]}),
  (name, listing) => ({ kind: "listing", listingLabel: listing, messages: [
    { from: "guest", text: `My pre-approval came through this morning and I'm ready to move forward on this property. What are the next steps to schedule a walkthrough and close?` },
    { from: "admin", text: `Congrats on the pre-approval, ${name.split(" ")[0]}! I'll have an agent reach out today to get your walkthrough scheduled.` },
    { from: "guest", text: `Great, thank you! Is tomorrow afternoon possible?` }
  ]}),
  () => ({ kind: "general", messages: [{ from: "guest", text: "how much is deposit" }] }),
  (name, listing) => ({ kind: "listing", listingLabel: listing, messages: [{ from: "guest", text: `Already paid the agency fee through my realtor. When's the earliest I can view and finalize the purchase?` }] }),
  () => ({ kind: "general", messages: [{ from: "guest", text: "I've emailed twice with no response. I want to buy this house NOW. Is anyone actually going to help me??" }] }),
  (name, listing) => ({ kind: "listing", listingLabel: listing, messages: [
    { from: "guest", text: `Just wiring the earnest money today as discussed with my agent — excited to move forward!` },
    { from: "admin", text: `Wonderful, ${name.split(" ")[0]} — we'll confirm receipt and send next steps within 24 hours.` }
  ]}),
  () => ({ kind: "general", messages: [{ from: "guest", text: "Is this a real company? I want to make sure before I pay anything." }] }),
  () => ({ kind: "general", messages: [{ from: "guest", text: "Hello! Quick question — do you accept international wire transfers for the down payment?" }] }),
  (name, listing) => ({ kind: "listing", listingLabel: listing, messages: [
    { from: "guest", text: "Hi, still interested in this one" },
    { from: "guest", text: "Also — is the price negotiable?" }
  ]}),
  () => ({ kind: "general", messages: [{ from: "guest", text: "I paid the booking fee already, why haven't I heard back about scheduling my visit?" }] }),
  (name, listing) => ({ kind: "listing", listingLabel: listing, messages: [{ from: "guest", text: "We're relocating from out of state and won't be able to see the property in person before closing. Would a live video walkthrough be possible, and how does that affect the standard closing timeline?" }] }),
  () => ({ kind: "general", messages: [{ from: "guest", text: "buy now?" }] }),
  (name, listing) => ({ kind: "listing", listingLabel: listing, messages: [{ from: "guest", text: `I already sent payment to your agency last week for this listing. Can someone confirm you received it and tell me when I can pick up keys?` }] })
];

function generateMessageProfiles(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = fullName(i);
    const listing = propertyLabel(i);
    const built = pick(MESSAGE_TEMPLATES, i)(name, listing);
    out.push({
      senderName: name,
      kind: built.kind,
      listingLabel: built.kind === "listing" ? (built.listingLabel || listing) : null,
      messages: built.messages
    });
  }
  return out;
}

const REVIEW_THEMES = [
  (n, r, p) => ({ rating: 5, text: `The ${p.split(",")[0].toLowerCase()} I bought is exactly the way it was described and the surroundings are peaceful. The only reason I'm not perfectly at ease on speed is the paperwork took a little longer than I expected, but the team kept me updated the whole way.`, adminReply: `Thank you, ${n.split(" ")[0]} — glad the place has been everything you hoped for.` }),
  (n) => ({ rating: 4, text: `Good experience overall. The agent was responsive and the viewing was easy to book. I did have a small mix-up with the initial booking fee receipt but it was sorted within a day once I raised it.`, adminReply: "" }),
  (n) => ({ rating: 5, text: `This is my second purchase through this agency and both times the title verification gave me real peace of mind before I paid anything. The BTC payment option was a nice surprise too — settled the booking fee in about twenty minutes.`, adminReply: "" }),
  (n) => ({ rating: 3, text: `The unit itself is fine and matches the listing photos. What I'd flag for others is that the building's parking situation wasn't mentioned upfront and I had to ask directly.`, adminReply: `Fair point, ${n.split(" ")[0]} — we're updating our listing template to include parking as a standard field.` }),
  (n) => ({ rating: 4, text: `Renting through here was much smoother than I expected. Clear lease terms, no hidden charges, and the agent actually showed up on time for the viewing.`, adminReply: "" }),
  (n) => ({ rating: 5, text: `Closing took under three weeks from offer to keys, which I wasn't expecting for a first-time buyer. The agent walked me through every document before I signed anything.`, adminReply: "" }),
  (n) => ({ rating: 4, text: `Location is unbeatable and the unit is well kept. Only knock is it can get noisy on weekends since it's right above ground-floor retail — worth mentioning to anyone who works early mornings.`, adminReply: "" }),
  (n) => ({ rating: 5, text: `We specifically needed to be in a certain school district and the agent found us options within a week that fit both that and our budget. Genuinely felt like someone was listening.`, adminReply: `That means a lot, ${n.split(" ")[0]} — glad the search worked out for your family.` }),
  (n) => ({ rating: 3, text: `The apartment is as advertised, but the building's elevator has been out of service twice since I moved in three months ago, and I'm on a high floor. Building management has been slow to respond, separate from the agency.`, adminReply: `Sorry to hear this, ${n.split(" ")[0]} — we've flagged the elevator issue with the building manager on your behalf.` }),
  (n) => ({ rating: 5, text: `Every email I sent got a same-day reply, which after renting through two other agencies previously, was honestly the biggest selling point for me.`, adminReply: "" }),
  (n) => ({ rating: 2, text: `The AC unit stopped working within the first week of my lease and it took almost ten days to get someone out to fix it during a very hot stretch. The apartment itself is nice but that response time was a real problem.`, adminReply: `This isn't the experience we want for new tenants, ${n.split(" ")[0]} — we're following up with the maintenance contractor directly.` }),
  (n) => ({ rating: 5, text: `Paid the booking fee in BTC out of curiosity more than necessity and it went through faster than a bank transfer would have. Everything after that was straightforward with no last-minute fees added on.`, adminReply: "" }),
  (n) => ({ rating: 4, text: `The agent helped us negotiate the price down a bit after the inspection turned up a few minor items, which we appreciated. Communication was solid throughout, just occasionally slow on weekends.`, adminReply: "" }),
  (n) => ({ rating: 1, text: `I paid a booking fee to secure a viewing and then the listing was marked unavailable two days later with no explanation and no refund processed for almost three weeks. Had to follow up multiple times to get it resolved.`, adminReply: `${n.split(" ")[0]}, this fell short of what we expect from ourselves — we've since changed our process so refunds trigger automatically the same day a listing is pulled.` }),
  (n) => ({ rating: 5, text: `Booked a viewing on a Tuesday and was signing paperwork by Friday. I've rented through slower agencies before and the turnaround here was genuinely refreshing.`, adminReply: "" })
];

function generateReviewProfiles(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = initialName(i);
    const prop = propertyLabel(i);
    const built = pick(REVIEW_THEMES, i)(name, i, prop);
    out.push({
      displayName: name,
      rating: built.rating,
      propertyLabel: prop,
      text: built.text,
      adminReply: built.adminReply || ""
    });
  }
  return out;
}

async function loadStarterPack() {
  if (!confirm("This adds 220 conversation profiles + 220 reviews to the two pools (in addition to anything already there). Continue?")) return;
  const statusEl = document.getElementById("starter-status");
  statusEl.textContent = "Generating…";
  try {
    const messageProfiles = generateMessageProfiles(220);
    const reviewProfiles = generateReviewProfiles(220);

    for (let i = 0; i < messageProfiles.length; i += 450) {
      const batch = writeBatch(db);
      messageProfiles.slice(i, i + 450).forEach(entry => {
        batch.set(doc(collection(db, "seedMessagePool")), { ...entry, used: false, addedAt: serverTimestamp() });
      });
      await batch.commit();
    }
    for (let i = 0; i < reviewProfiles.length; i += 450) {
      const batch = writeBatch(db);
      reviewProfiles.slice(i, i + 450).forEach(entry => {
        batch.set(doc(collection(db, "seedReviewPool")), { ...entry, used: false, addedAt: serverTimestamp() });
      });
      await batch.commit();
    }
    statusEl.textContent = `Done — added ${messageProfiles.length} conversation profiles and ${reviewProfiles.length} reviews to the pools.`;
  } catch (err) {
    statusEl.textContent = "Could not generate starter pack: " + err.message;
  }
  refreshPoolStatus();
}
