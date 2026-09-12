import { auth, db } from "./firebase-config.js";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection, addDoc, doc, getDoc, getDocs, query, where, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const loginScreen = document.getElementById("login-screen");
const dashboard = document.getElementById("dashboard");
const loginError = document.getElementById("login-error");

// Same admin whitelist as the main admin panel (admins/{uid} in Firestore)
// — this tool writes into shared data, so it's gated the same way, even
// though it has no inbox view of its own.
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

onAuthStateChanged(auth, async (user) => {
  if (!user) { loginScreen.style.display = "flex"; dashboard.style.display = "none"; return; }
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
});

// ---------- Demo training conversations ----------
// For practicing/evaluating customer-service response speed and quality
// before real traffic hits the inbox — NOT fake accounts (guests don't
// need accounts to message at all) and NOT claims of a specific completed
// payment (a demo message claiming money already changed hands is exactly
// the kind of thing that could confuse someone later if mistaken for a
// real pending transaction). Every message is tagged demo:true and shows
// a DEMO badge in the admin panel's Messages tab.
document.getElementById("seed-btn").addEventListener("click", seedDemoMessages);
document.getElementById("clear-btn").addEventListener("click", clearDemoMessages);

async function seedDemoMessages() {
  if (!confirm("This adds several simulated buyer conversations for customer-service training/testing — NOT real customers. Clear them before real traffic uses the admin inbox. Continue?")) return;

  const statusEl = document.getElementById("seed-status");
  statusEl.textContent = "Seeding…";

  const conversations = [
    {
      guestId: "demo-g01", senderName: "Karen Whitfield", kind: "general",
      messages: [
        { from: "guest", text: "Hi, I already paid for the agency so I'm ready to buy this house. When can I check it and complete the purchase?" }
      ]
    },
    {
      guestId: "demo-g02", senderName: "Meredith Cole", kind: "listing", listingLabel: "Lakefront cottage",
      messages: [
        { from: "guest", text: "I already paid for the agency and I'm ready to buy — when can I see the house and close?" },
        { from: "admin", text: "Thanks for reaching out, Meredith! I don't see a payment on file under your name yet — could you tell me which agent or agency you worked with so I can look into it? In the meantime I'd be glad to get your viewing scheduled this week." },
        { from: "guest", text: "Oh, I think I'm mixing this up with another property — sorry about that! Yes please, this week works great." }
      ]
    },
    {
      guestId: "demo-g03", senderName: "Marcus Bell", kind: "listing", listingLabel: "4-bed colonial on Maple Ave",
      messages: [
        { from: "guest", text: "My pre-approval came through this morning and I'm ready to move forward on this property. What are the next steps to schedule a walkthrough and close?" },
        { from: "admin", text: "Congrats on the pre-approval, Marcus! I'll have an agent reach out today to get your walkthrough scheduled." },
        { from: "guest", text: "Great, thank you! Is tomorrow afternoon possible?" }
      ]
    },
    { guestId: "demo-g04", senderName: "Priya Patel", kind: "general", messages: [{ from: "guest", text: "how much is deposit" }] },
    {
      guestId: "demo-g05", senderName: "Jerome Washington", kind: "listing", listingLabel: "Ranch-style home, Willow Creek",
      messages: [{ from: "guest", text: "Already paid the agency fee through my realtor. When's the earliest I can view and finalize the purchase?" }]
    },
    { guestId: "demo-g06", senderName: "Angela Brooks", kind: "general", messages: [{ from: "guest", text: "I've emailed twice with no response. I want to buy the house on 5th street NOW. Is anyone actually going to help me??" }] },
    {
      guestId: "demo-g07", senderName: "David Kim", kind: "listing", listingLabel: "2-bed condo near the river",
      messages: [
        { from: "guest", text: "Just wiring the earnest money today as discussed with my agent — excited to move forward!" },
        { from: "admin", text: "Wonderful, David — we'll confirm receipt and send next steps within 24 hours." }
      ]
    },
    { guestId: "demo-g08", senderName: "Fatima Al-Sayed", kind: "general", messages: [{ from: "guest", text: "Is this a real company? I want to make sure before I pay anything." }] },
    { guestId: "demo-g09", senderName: "Lin Zhao", kind: "general", messages: [{ from: "guest", text: "Hello! Quick question — do you accept international wire transfers for the down payment?" }] },
    {
      guestId: "demo-g10", senderName: "Rebecca Sun", kind: "listing", listingLabel: "Farmhouse with 2 acres",
      messages: [
        { from: "guest", text: "Hi, still interested in this one" },
        { from: "guest", text: "Also — is the price negotiable?" }
      ]
    },
    { guestId: "demo-g11", senderName: "Oluwaseun Adebayo", kind: "general", messages: [{ from: "guest", text: "I paid the booking fee already, why haven't I heard back about scheduling my visit?" }] },
    { guestId: "demo-g12", senderName: "Grace Miller", kind: "listing", listingLabel: "Historic brownstone downtown", messages: [{ from: "guest", text: "We're relocating from out of state and won't be able to see the property in person before closing. Would a live video walkthrough be possible, and how does that affect the standard closing timeline?" }] },
    { guestId: "demo-g13", senderName: "Tyler Brooks", kind: "general", messages: [{ from: "guest", text: "buy now?" }] },
    { guestId: "demo-g14", senderName: "Tomás Rivera", kind: "listing", listingLabel: "Downtown loft, Unit 12B", messages: [{ from: "guest", text: "I already sent payment to your agency last week for this loft. Can someone confirm you received it and tell me when I can pick up keys?" }] }
  ];

  let count = 0;
  let firstError = null;
  outer:
  for (const convo of conversations) {
    const threadId = convo.kind === "listing" ? `listing-demo-${convo.guestId}` : `general-${convo.guestId}`;
    for (const m of convo.messages) {
      try {
        await addDoc(collection(db, "messages"), {
          threadId,
          kind: convo.kind,
          listingId: null,
          listingLabel: convo.listingLabel || null,
          senderType: m.from === "admin" ? "admin" : "guest",
          senderId: m.from === "admin" ? "admin" : convo.guestId,
          senderName: m.from === "admin" ? "Asante & Grove" : convo.senderName,
          senderEmail: null,
          text: m.text,
          demo: true,
          createdAt: serverTimestamp(),
          read: m.from === "admin" ? true : false
        });
        count++;
      } catch (err) {
        firstError = err;
        break outer;
      }
    }
  }

  if (firstError) {
    statusEl.textContent = `Only ${count} demo messages were saved before this error: ${firstError.message}`;
  } else {
    statusEl.textContent = `Done — added ${count} demo messages across ${conversations.length} conversations. Check the admin panel's Messages tab.`;
  }
}

async function clearDemoMessages() {
  if (!confirm("Delete every demo/training conversation? This cannot be undone.")) return;
  const statusEl = document.getElementById("clear-status");
  statusEl.textContent = "Clearing…";
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
