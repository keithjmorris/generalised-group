// ---------------------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------------------
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, collection, addDoc, query, orderBy, where,
  onSnapshot, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const signedOutEl = document.getElementById("signed-out");
const appEl = document.getElementById("app");
const headerTitleEl = document.getElementById("header-title");
const signinError = document.getElementById("signin-error");
const signOutBtn = document.getElementById("sign-out-btn");

// Phone sign-in step elements
const phoneStepEl = document.getElementById("phone-step");
const codeStepEl = document.getElementById("code-step");
const nameStepEl = document.getElementById("name-step");
const countryCodeEl = document.getElementById("country-code");
const phoneNumberEl = document.getElementById("phone-number");
const sendCodeBtn = document.getElementById("send-code-btn");
const smsCodeEl = document.getElementById("sms-code");
const verifyCodeBtn = document.getElementById("verify-code-btn");
const changeNumberBtn = document.getElementById("change-number-btn");
const codeSentToEl = document.getElementById("code-sent-to");
const displayNameEl = document.getElementById("display-name");
const saveNameBtn = document.getElementById("save-name-btn");

const views = {
  members: document.getElementById("view-members"),
  events: document.getElementById("view-events"),
  eventDetail: document.getElementById("view-event-detail"),
  chat: document.getElementById("view-chat"),
};
const tabButtons = document.querySelectorAll(".tab-btn");

let currentUser = null;
let currentMemberProfile = null; // { name, photoURL }
let unsubEventDetail = null; // holds the active event-discussion listener so we can detach it

// ---------------------------------------------------------------------------
// Auth - phone number sign-in
// ---------------------------------------------------------------------------

// A curated list of common dialing codes. If a member's country isn't here,
// they can leave the picker on the default and just type their full number
// starting with "+" in the phone field - E.164 format works either way.
const COUNTRY_CODES = [
  { code: "+44", label: "UK +44" },
  { code: "+1", label: "US/Canada +1" },
  { code: "+353", label: "Ireland +353" },
  { code: "+33", label: "France +33" },
  { code: "+49", label: "Germany +49" },
  { code: "+34", label: "Spain +34" },
  { code: "+39", label: "Italy +39" },
  { code: "+31", label: "Netherlands +31" },
  { code: "+41", label: "Switzerland +41" },
  { code: "+61", label: "Australia +61" },
  { code: "+64", label: "New Zealand +64" },
  { code: "+91", label: "India +91" },
  { code: "+971", label: "UAE +971" },
  { code: "+27", label: "South Africa +27" },
  { code: "+65", label: "Singapore +65" },
  { code: "+852", label: "Hong Kong +852" },
];
COUNTRY_CODES.forEach(({ code, label }) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = label;
  countryCodeEl.appendChild(opt);
});

let confirmationResult = null;
let recaptchaVerifier = null;
let pendingUser = null; // holds the signed-in user while we wait for their name (first-time sign-in)
let memberProfileConfirmed = false; // true once we've saved/found this session's member doc - stops a late duplicate auth event from bouncing us back to the name step

function getRecaptcha() {
  if (!recaptchaVerifier) {
    recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" });
  }
  return recaptchaVerifier;
}

sendCodeBtn.addEventListener("click", async () => {
  signinError.textContent = "";
  const raw = phoneNumberEl.value.trim();
  if (!raw) {
    signinError.textContent = "Enter a phone number.";
    return;
  }
  // Accept either "just the number" (combined with the country picker) or
  // a full number the member has typed themselves starting with "+".
  const fullNumber = raw.startsWith("+") ? raw.replace(/\s+/g, "") : `${countryCodeEl.value}${raw.replace(/\D/g, "")}`;

  sendCodeBtn.disabled = true;
  try {
    confirmationResult = await signInWithPhoneNumber(auth, fullNumber, getRecaptcha());
    codeSentToEl.textContent = fullNumber;
    phoneStepEl.hidden = true;
    codeStepEl.hidden = false;
    smsCodeEl.focus();
  } catch (err) {
    console.error(err);
    signinError.textContent = "Couldn't send a code to that number. Check the format and try again.";
    if (recaptchaVerifier) {
      recaptchaVerifier.clear(); // removes the rendered widget, not just our reference to it
      recaptchaVerifier = null;
    }
  } finally {
    sendCodeBtn.disabled = false;
  }
});

verifyCodeBtn.addEventListener("click", async () => {
  signinError.textContent = "";
  const code = smsCodeEl.value.trim();
  if (!code) {
    signinError.textContent = "Enter the code you received.";
    return;
  }
  verifyCodeBtn.disabled = true;
  try {
    await confirmationResult.confirm(code);
    // onAuthStateChanged below takes it from here
  } catch (err) {
    console.error(err);
    signinError.textContent = "That code didn't match. Please try again.";
  } finally {
    verifyCodeBtn.disabled = false;
  }
});

changeNumberBtn.addEventListener("click", () => {
  codeStepEl.hidden = true;
  phoneStepEl.hidden = false;
  smsCodeEl.value = "";
  signinError.textContent = "";
});

saveNameBtn.addEventListener("click", async () => {
  if (!pendingUser) return; // already submitted - ignore a second click
  const name = displayNameEl.value.trim();
  if (!name) {
    signinError.textContent = "Enter a name so other members recognize you.";
    return;
  }
  saveNameBtn.disabled = true;
  const uid = pendingUser.uid;
  const phoneNumber = pendingUser.phoneNumber || "";
  pendingUser = null; // claim it immediately so a second click is a no-op
  try {
    await setDoc(doc(db, "members", uid), {
      name,
      phoneNumber,
      role: "",
      memberSince: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    currentMemberProfile = { name, photoURL: "" };
    memberProfileConfirmed = true;
    enterApp();
  } catch (err) {
    console.error(err);
    signinError.textContent = "Something went wrong saving your name. Please try again.";
    pendingUser = currentUser; // let them retry
    saveNameBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    memberProfileConfirmed = false;
    signedOutEl.hidden = false;
    appEl.hidden = true;
    phoneStepEl.hidden = false;
    codeStepEl.hidden = true;
    nameStepEl.hidden = true;
    phoneNumberEl.value = "";
    smsCodeEl.value = "";
    return;
  }

  if (memberProfileConfirmed) {
    // We've already saved/found this session's member doc - a late duplicate
    // auth event shouldn't re-derive (and potentially undo) that.
    enterApp();
    return;
  }

  const memberRef = doc(db, "members", user.uid);
  const existing = await getDoc(memberRef);

  if (existing.exists() && existing.data().name) {
    // Returning member - just refresh their last-seen time and go straight in.
    currentMemberProfile = { name: existing.data().name, photoURL: existing.data().photoURL || "" };
    memberProfileConfirmed = true;
    await setDoc(memberRef, { updatedAt: serverTimestamp() }, { merge: true });
    enterApp();
  } else {
    // First time we've seen this phone number - ask for a name before
    // creating their member card.
    pendingUser = user;
    phoneStepEl.hidden = true;
    codeStepEl.hidden = true;
    nameStepEl.hidden = false;
  }
});

function enterApp() {
  signedOutEl.hidden = true;
  appEl.hidden = false;
  startListeners();
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

function showTab(tab) {
  Object.values(views).forEach((v) => (v.hidden = true));
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));

  if (tab === "members") {
    views.members.hidden = false;
    headerTitleEl.textContent = "Members";
  } else if (tab === "events") {
    views.events.hidden = false;
    headerTitleEl.textContent = "Events";
  } else if (tab === "chat") {
    views.chat.hidden = false;
    headerTitleEl.textContent = "Community chat";
  }
}

// ---------------------------------------------------------------------------
// Members list
// ---------------------------------------------------------------------------
const membersListEl = document.getElementById("members-list");
const memberSearchEl = document.getElementById("member-search");
let allMembers = [];

function renderMembers() {
  const term = memberSearchEl.value.trim().toLowerCase();
  const filtered = allMembers.filter((m) => m.name.toLowerCase().includes(term));

  membersListEl.innerHTML = "";
  if (filtered.length === 0) {
    membersListEl.innerHTML = `<div class="empty-state">No members found.</div>`;
    return;
  }
  filtered.forEach((m) => {
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <div class="avatar" style="${m.photoURL ? `background-image:url('${m.photoURL}')` : `background:${colorFromString(m.name)}`}">
        ${m.photoURL ? "" : initials(m.name)}
      </div>
      <div>
        <div class="member-name">${escapeHtml(m.name)}</div>
        <div class="member-role">${escapeHtml(m.role || "Member")}</div>
      </div>
    `;
    membersListEl.appendChild(row);
  });
}
memberSearchEl.addEventListener("input", renderMembers);

// ---------------------------------------------------------------------------
// Events list + detail
// ---------------------------------------------------------------------------
const eventsListEl = document.getElementById("events-list");
const eventBackBtn = document.getElementById("event-back-btn");
const eventDetailTitleEl = document.getElementById("event-detail-title");
const eventDetailMetaEl = document.getElementById("event-detail-meta");
const rsvpRowEl = document.getElementById("event-rsvp-row");
const eventMessagesEl = document.getElementById("event-messages");
let allEvents = [];
let activeEvent = null;

function renderEvents() {
  eventsListEl.innerHTML = "";
  if (allEvents.length === 0) {
    eventsListEl.innerHTML = `<div class="empty-state">No upcoming events yet.</div>`;
    return;
  }
  allEvents.forEach((e) => {
    const d = e.date && typeof e.date.toDate === "function" ? e.date.toDate() : null;
    const card = document.createElement("div");
    card.className = "event-card";
    card.innerHTML = `
      <div class="event-date">
        <div class="month">${d ? d.toLocaleString(undefined, { month: "short" }) : ""}</div>
        <div class="day">${d ? d.getDate() : "-"}</div>
      </div>
      <div>
        <div class="event-title">${escapeHtml(e.title)}</div>
        <div class="event-meta">${d ? d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}${e.location ? ", " + escapeHtml(e.location) : ""}</div>
      </div>
    `;
    card.addEventListener("click", () => openEventDetail(e));
    eventsListEl.appendChild(card);
  });
}

function openEventDetail(e) {
  activeEvent = e;
  const d = e.date && typeof e.date.toDate === "function" ? e.date.toDate() : null;
  eventDetailTitleEl.textContent = e.title;
  eventDetailMetaEl.textContent = `${d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""}${e.location ? ", " + e.location : ""}`;

  rsvpRowEl.innerHTML = "";
  ["going", "maybe", "no"].forEach((status) => {
    const b = document.createElement("button");
    b.className = "rsvp-btn";
    b.textContent = status === "going" ? "Going" : status === "maybe" ? "Maybe" : "Can't go";
    b.addEventListener("click", () => setRsvp(e.id, status, b));
    rsvpRowEl.appendChild(b);
  });

  Object.values(views).forEach((v) => (v.hidden = true));
  views.eventDetail.hidden = false;

  if (unsubEventDetail) unsubEventDetail();
  const q = query(collection(db, "messages"), where("eventId", "==", e.id), orderBy("createdAt", "asc"), limit(200));
  unsubEventDetail = onSnapshot(q, (snap) => {
    eventMessagesEl.innerHTML = "";
    snap.forEach((docSnap) => renderMessage(eventMessagesEl, docSnap.data(), false));
    eventMessagesEl.scrollTop = eventMessagesEl.scrollHeight;
  });

  buildComposer(document.getElementById("event-composer"), { eventId: e.id, eventTitle: e.title, placeholder: "Comment on this event" });
}

async function setRsvp(eventId, status, btn) {
  [...rsvpRowEl.children].forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  await setDoc(
    doc(db, "events", eventId, "rsvps", currentUser.uid),
    { status, name: currentMemberProfile.name, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

eventBackBtn.addEventListener("click", () => {
  if (unsubEventDetail) unsubEventDetail();
  showTab("events");
});

// ---------------------------------------------------------------------------
// General chat
// ---------------------------------------------------------------------------
const chatMessagesEl = document.getElementById("chat-messages");

function renderMessage(container, m, showTagChip) {
  const el = document.createElement("div");
  el.className = "msg" + (m.senderId === currentUser.uid ? " mine" : "");

  if (m.senderId !== currentUser.uid) {
    const sender = document.createElement("div");
    sender.className = "msg-sender";
    sender.style.color = colorFromString(m.senderName || "");
    sender.textContent = m.senderName || "Member";
    el.appendChild(sender);
  }

  if (m.type === "image" || m.type === "video") {
    const media = document.createElement("div");
    media.className = "msg-media has-media";
    if (m.type === "image") {
      media.innerHTML = `<img src="${m.mediaUrl}" alt="Shared photo" loading="lazy" />`;
    } else {
      media.innerHTML = `<video src="${m.mediaUrl}" controls preload="metadata"></video>`;
    }
    el.appendChild(media);
  }

  if (m.text) {
    const text = document.createElement("div");
    text.className = "msg-text";
    text.textContent = m.text;
    el.appendChild(text);
  }

  if (showTagChip && m.eventId) {
    const tag = document.createElement("div");
    tag.className = "msg-tag visible";
    tag.textContent = `on: ${m.eventTitle || "event"}`;
    tag.addEventListener("click", () => {
      const match = allEvents.find((ev) => ev.id === m.eventId);
      if (match) openEventDetail(match);
    });
    el.appendChild(tag);
  }

  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = m.createdAt ? m.createdAt.toDate().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "sending...";
  el.appendChild(time);

  container.appendChild(el);
}

function startChatListener() {
  const q = query(collection(db, "messages"), orderBy("createdAt", "asc"), limit(200));
  onSnapshot(q, (snap) => {
    chatMessagesEl.innerHTML = "";
    snap.forEach((docSnap) => renderMessage(chatMessagesEl, docSnap.data(), true));
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Shared composer (used by both general chat and event discussion)
// ---------------------------------------------------------------------------
function buildComposer(container, { eventId = null, eventTitle = null, placeholder = "Type a message" } = {}) {
  container.innerHTML = "";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*,video/*";
  fileInput.hidden = true;

  const attachBtn = document.createElement("button");
  attachBtn.className = "attach-btn";
  attachBtn.setAttribute("aria-label", "Attach photo or video");
  attachBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  attachBtn.addEventListener("click", () => fileInput.click());

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.placeholder = placeholder;

  const sendBtn = document.createElement("button");
  sendBtn.className = "send-btn";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const progress = document.createElement("div");
  progress.className = "upload-progress";
  progress.hidden = true;

  container.appendChild(attachBtn);
  container.appendChild(textInput);
  container.appendChild(sendBtn);
  container.appendChild(fileInput);
  container.after(progress);

  const send = async () => {
    const text = textInput.value.trim();
    if (!text) return;
    textInput.value = "";
    await addDoc(collection(db, "messages"), {
      text,
      type: "text",
      senderId: currentUser.uid,
      senderName: currentMemberProfile.name,
      eventId: eventId || null,
      eventTitle: eventTitle || null,
      createdAt: serverTimestamp(),
    });
  };

  sendBtn.addEventListener("click", send);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;

    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) {
      alert("Please choose an image or video file.");
      return;
    }
    const maxBytes = isVideo ? 60 * 1024 * 1024 : 15 * 1024 * 1024; // 60MB video, 15MB image
    if (file.size > maxBytes) {
      alert(`That file is too large. Please choose a ${isVideo ? "shorter video (under 60MB)" : "smaller image (under 15MB)"}.`);
      return;
    }

    progress.hidden = false;
    progress.textContent = "Uploading...";
    try {
      const path = `chat-media/${currentUser.uid}/${Date.now()}_${file.name}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);

      await addDoc(collection(db, "messages"), {
        type: isVideo ? "video" : "image",
        mediaUrl: url,
        mediaPath: path,
        text: "",
        senderId: currentUser.uid,
        senderName: currentMemberProfile.name,
        eventId: eventId || null,
        eventTitle: eventTitle || null,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error(err);
      alert("Upload failed. Please try again.");
    } finally {
      progress.hidden = true;
    }
  });
}

// ---------------------------------------------------------------------------
// Kick off Firestore listeners once signed in
// ---------------------------------------------------------------------------
function startListeners() {
  onSnapshot(query(collection(db, "members"), orderBy("name")), (snap) => {
    allMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMembers();
  });

  onSnapshot(query(collection(db, "events"), orderBy("date", "asc")), (snap) => {
    allEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderEvents();
  });

  startChatListener();
  buildComposer(document.getElementById("chat-composer"), { placeholder: "Type a message" });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function initials(name) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
function colorFromString(str) {
  const palette = ["#0F6E56", "#993C1D", "#72243E", "#3C3489", "#185FA5", "#3B6D11"];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}