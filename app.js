// ---------------------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------------------
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword
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
// Group resolution - every URL is /g/{groupId}, and all data for that group
// lives under groups/{groupId}/... in Firestore and Storage. A person can
// belong to any number of groups; which one they're using is simply whichever
// group's URL they're currently on.
// ---------------------------------------------------------------------------
const GROUP_ID = (() => {
  const match = window.location.pathname.match(/^\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
})();

function groupCollection(name) {
  return collection(db, "groups", GROUP_ID, name);
}
function groupDoc(name, id) {
  return doc(db, "groups", GROUP_ID, name, id);
}
function groupStoragePath(subpath) {
  return `groups/${GROUP_ID}/${subpath}`;
}

if (!GROUP_ID) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;font-family:-apple-system,sans-serif;text-align:center;color:#5b6b73;">
      <div>
        <h1 style="color:#111;">No group specified</h1>
        <p>This link is missing a group - it should look like <code>.../g/your-group-name</code>.<br/>Check the link you were given and try again.</p>
      </div>
    </div>`;
  throw new Error("No group in URL - halting app init");
}

// Load the group's display name and auth method (set once when the group
// was created) and configure the sign-in screen accordingly - falls back to
// phone auth if a group has no authMethod set (covers groups created before
// this feature existed).
let GROUP_AUTH_METHOD = "phone";
const groupReady = getDoc(doc(db, "groups", GROUP_ID)).then((groupSnap) => {
  const groupName = (groupSnap.exists() && groupSnap.data().name) || GROUP_ID;
  GROUP_AUTH_METHOD = (groupSnap.exists() && groupSnap.data().authMethod) || "phone";
  document.title = groupName;
  const appNameEl = document.getElementById("app-name");
  if (appNameEl) appNameEl.textContent = groupName;

  if (GROUP_AUTH_METHOD === "email") {
    document.getElementById("email-step").hidden = false;
  } else {
    document.getElementById("phone-step").hidden = false;
  }
}).catch((err) => {
  // Never leave the sign-in screen blank - fall back to the phone form
  // (the more common case) rather than getting stuck with nothing shown.
  console.error("Couldn't load group info:", err);
  document.getElementById("phone-step").hidden = false;
});

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

// Email sign-in step elements
const emailStepEl = document.getElementById("email-step");
const emailAddressEl = document.getElementById("email-address");
const emailPasswordEl = document.getElementById("email-password");
const emailSigninBtn = document.getElementById("email-signin-btn");
const emailSignupBtn = document.getElementById("email-signup-btn");

const views = {
  members: document.getElementById("view-members"),
  events: document.getElementById("view-events"),
  eventDetail: document.getElementById("view-event-detail"),
  topics: document.getElementById("view-topics"),
  topicDetail: document.getElementById("view-topic-detail"),
  chat: document.getElementById("view-chat"),
};
const tabButtons = document.querySelectorAll(".tab-btn");

let currentUser = null;
let currentMemberProfile = null; // { name, photoURL }
let unsubEventDetail = null; // holds the active event-discussion listener so we can detach it
let unsubTopicDetail = null; // holds the active topic-thread listener so we can detach it

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
    // Build a brand-new container each time rather than reusing the same
    // div - reusing one can leave Google's widget library thinking it's
    // "already rendered" even after calling .clear(), which silently
    // blocks everything downstream (the SMS never even gets requested).
    const parent = document.getElementById("recaptcha-container");
    parent.innerHTML = "";
    const freshDiv = document.createElement("div");
    freshDiv.id = `recaptcha-widget-${Date.now()}`;
    parent.appendChild(freshDiv);
    recaptchaVerifier = new RecaptchaVerifier(auth, freshDiv.id, { size: "invisible" });
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
    // The widget isn't needed again until a resend - clear it now so it
    // can't linger on the page (a visible challenge, in particular, can
    // otherwise sit on top of the Verify button and swallow clicks).
    if (recaptchaVerifier) {
      recaptchaVerifier.clear();
      recaptchaVerifier = null;
    }
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
    signinError.textContent = `That code didn't match. Please try again. (${err.code || "unknown error"})`;
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
  const email = pendingUser.email || "";
  pendingUser = null; // claim it immediately so a second click is a no-op
  try {
    await setDoc(groupDoc("members", uid), {
      name,
      phoneNumber,
      email,
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

emailSigninBtn.addEventListener("click", async () => {
  signinError.textContent = "";
  const email = emailAddressEl.value.trim();
  const password = emailPasswordEl.value;
  if (!email || !password) {
    signinError.textContent = "Enter your email and password.";
    return;
  }
  emailSigninBtn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error(err);
    signinError.textContent = "Couldn't sign in - check your email and password, or create an account if you're new here.";
  } finally {
    emailSigninBtn.disabled = false;
  }
});

emailSignupBtn.addEventListener("click", async () => {
  signinError.textContent = "";
  const email = emailAddressEl.value.trim();
  const password = emailPasswordEl.value;
  if (!email || !password) {
    signinError.textContent = "Enter an email and choose a password.";
    return;
  }
  if (password.length < 6) {
    signinError.textContent = "Password must be at least 6 characters.";
    return;
  }
  emailSignupBtn.disabled = true;
  try {
    await createUserWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error(err);
    if (err.code === "auth/email-already-in-use") {
      signinError.textContent = "That email already has an account - try Sign in instead.";
    } else {
      signinError.textContent = `Couldn't create an account. (${err.code || "unknown error"})`;
    }
  } finally {
    emailSignupBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    memberProfileConfirmed = false;
    signedOutEl.hidden = false;
    appEl.hidden = true;
    await groupReady; // make sure we know which auth method to show before revealing it
    phoneStepEl.hidden = GROUP_AUTH_METHOD !== "phone";
    emailStepEl.hidden = GROUP_AUTH_METHOD !== "email";
    codeStepEl.hidden = true;
    nameStepEl.hidden = true;
    phoneNumberEl.value = "";
    smsCodeEl.value = "";
    emailPasswordEl.value = "";
    return;
  }

  if (memberProfileConfirmed) {
    // We've already saved/found this session's member doc - a late duplicate
    // auth event shouldn't re-derive (and potentially undo) that.
    enterApp();
    return;
  }

  const memberRef = groupDoc("members", user.uid);
  const existing = await getDoc(memberRef);

  if (existing.exists() && existing.data().name) {
    // Returning member - just refresh their last-seen time and go straight in.
    currentMemberProfile = { name: existing.data().name, photoURL: existing.data().photoURL || "" };
    memberProfileConfirmed = true;
    await setDoc(memberRef, { updatedAt: serverTimestamp() }, { merge: true });
    enterApp();
  } else {
    // First time we've seen this person - ask for a name before creating
    // their member card.
    pendingUser = user;
    phoneStepEl.hidden = true;
    emailStepEl.hidden = true;
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
  } else if (tab === "topics") {
    views.topics.hidden = false;
    headerTitleEl.textContent = "Topics";
  } else if (tab === "chat") {
    views.chat.hidden = false;
    headerTitleEl.textContent = "General chat";
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
const eventAttachmentEl = document.getElementById("event-detail-attachment");
const newEventBtn = document.getElementById("new-event-btn");
const newEventFormEl = document.getElementById("new-event-form");
const eventTitleInput = document.getElementById("event-title-input");
const eventDateInput = document.getElementById("event-date-input");
const eventLocationInput = document.getElementById("event-location-input");
const eventDescriptionInput = document.getElementById("event-description-input");
const eventAttachBtn = document.getElementById("event-attach-btn");
const eventAttachInput = document.getElementById("event-attach-input");
const eventAttachFilenameEl = document.getElementById("event-attach-filename");
const eventCancelBtn = document.getElementById("event-cancel-btn");
const eventSaveBtn = document.getElementById("event-save-btn");
const eventFormErrorEl = document.getElementById("event-form-error");
let pendingEventAttachment = null; // the File object chosen, if any
let allEvents = [];
let activeEvent = null;

function resetNewEventForm() {
  eventTitleInput.value = "";
  eventDateInput.value = "";
  eventLocationInput.value = "";
  eventDescriptionInput.value = "";
  eventAttachFilenameEl.textContent = "";
  eventFormErrorEl.textContent = "";
  pendingEventAttachment = null;
  eventSaveBtn.disabled = false;
  eventSaveBtn.textContent = "Save event";
}

newEventBtn.addEventListener("click", () => {
  const opening = newEventFormEl.hidden;
  newEventFormEl.hidden = !opening;
  if (opening) resetNewEventForm();
});

eventCancelBtn.addEventListener("click", () => {
  newEventFormEl.hidden = true;
  resetNewEventForm();
});

eventAttachBtn.addEventListener("click", () => eventAttachInput.click());

eventAttachInput.addEventListener("change", () => {
  const file = eventAttachInput.files[0];
  if (!file) return;
  const isImage = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf";
  if (!isImage && !isPdf) {
    eventFormErrorEl.textContent = "Please choose an image or PDF file.";
    eventAttachInput.value = "";
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    eventFormErrorEl.textContent = "That file is too large (15MB max).";
    eventAttachInput.value = "";
    return;
  }
  eventFormErrorEl.textContent = "";
  pendingEventAttachment = file;
  eventAttachFilenameEl.textContent = file.name;
});

eventSaveBtn.addEventListener("click", async () => {
  eventFormErrorEl.textContent = "";
  const title = eventTitleInput.value.trim();
  const location = eventLocationInput.value.trim();
  const description = eventDescriptionInput.value.trim();
  if (!title) {
    eventFormErrorEl.textContent = "Give the event a title.";
    return;
  }
  if (!eventDateInput.value) {
    eventFormErrorEl.textContent = "Pick a date and time.";
    return;
  }
  const eventDate = new Date(eventDateInput.value);

  eventSaveBtn.disabled = true;
  eventSaveBtn.textContent = "Saving...";
  try {
    let attachmentUrl = null;
    let attachmentType = null;
    let attachmentName = null;
    if (pendingEventAttachment) {
      const path = groupStoragePath(`event-media/${currentUser.uid}/${Date.now()}_${pendingEventAttachment.name}`);
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, pendingEventAttachment);
      attachmentUrl = await getDownloadURL(storageRef);
      attachmentType = pendingEventAttachment.type.startsWith("image/") ? "image" : "pdf";
      attachmentName = pendingEventAttachment.name;
    }

    await addDoc(groupCollection("events"), {
      title,
      date: eventDate,
      location,
      description,
      attachmentUrl,
      attachmentType,
      attachmentName,
      createdBy: currentUser.uid,
      createdByName: currentMemberProfile.name,
      createdAt: serverTimestamp(),
    });

    newEventFormEl.hidden = true;
    resetNewEventForm();
  } catch (err) {
    console.error(err);
    eventFormErrorEl.textContent = "Something went wrong saving the event. Please try again.";
    eventSaveBtn.disabled = false;
    eventSaveBtn.textContent = "Save event";
  }
});

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

  eventAttachmentEl.innerHTML = "";
  if (e.attachmentUrl) {
    if (e.attachmentType === "image") {
      eventAttachmentEl.innerHTML = `<img src="${e.attachmentUrl}" alt="${escapeHtml(e.attachmentName || "Event attachment")}" />`;
    } else {
      eventAttachmentEl.innerHTML = `<a class="attachment-link" href="${e.attachmentUrl}" target="_blank" rel="noopener">View attachment: ${escapeHtml(e.attachmentName || "PDF")}</a>`;
    }
  }

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
  const q = query(groupCollection("messages"), where("eventId", "==", e.id), orderBy("createdAt", "asc"), limit(200));
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
    doc(db, "groups", GROUP_ID, "events", eventId, "rsvps", currentUser.uid),
    { status, name: currentMemberProfile.name, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

eventBackBtn.addEventListener("click", () => {
  if (unsubEventDetail) unsubEventDetail();
  showTab("events");
});

// ---------------------------------------------------------------------------
// Topics: a lighter-weight alternative to Events - no date/location/RSVP,
// just a title and its own chat thread. A new topic is notification-worthy
// (later); messages inside one are not, and (unlike Events) a topic's
// messages never also appear in general chat - Topics is meant to be
// independently discoverable via its own tab and read-status, not folded
// into the general feed.
// ---------------------------------------------------------------------------
const topicsListEl = document.getElementById("topics-list");
const topicBackBtn = document.getElementById("topic-back-btn");
const topicDetailTitleEl = document.getElementById("topic-detail-title");
const topicDetailMetaEl = document.getElementById("topic-detail-meta");
const topicMessagesEl = document.getElementById("topic-messages");
const topicAttachmentEl = document.getElementById("topic-detail-attachment");
const newTopicBtn = document.getElementById("new-topic-btn");
const newTopicFormEl = document.getElementById("new-topic-form");
const topicTitleInput = document.getElementById("topic-title-input");
const topicDescriptionInput = document.getElementById("topic-description-input");
const topicAttachBtn = document.getElementById("topic-attach-btn");
const topicAttachInput = document.getElementById("topic-attach-input");
const topicAttachFilenameEl = document.getElementById("topic-attach-filename");
const topicCancelBtn = document.getElementById("topic-cancel-btn");
const topicSaveBtn = document.getElementById("topic-save-btn");
const topicFormErrorEl = document.getElementById("topic-form-error");
let pendingTopicAttachment = null;
let allTopics = [];

function topicReadDoc(topicId) {
  return doc(db, "groups", GROUP_ID, "topics", topicId, "reads", currentUser.uid);
}

function resetNewTopicForm() {
  topicTitleInput.value = "";
  topicDescriptionInput.value = "";
  topicAttachFilenameEl.textContent = "";
  topicFormErrorEl.textContent = "";
  pendingTopicAttachment = null;
  topicSaveBtn.disabled = false;
  topicSaveBtn.textContent = "Start topic";
}

newTopicBtn.addEventListener("click", () => {
  const opening = newTopicFormEl.hidden;
  newTopicFormEl.hidden = !opening;
  if (opening) resetNewTopicForm();
});

topicCancelBtn.addEventListener("click", () => {
  newTopicFormEl.hidden = true;
  resetNewTopicForm();
});

topicAttachBtn.addEventListener("click", () => topicAttachInput.click());

topicAttachInput.addEventListener("change", () => {
  const file = topicAttachInput.files[0];
  if (!file) return;
  const isImage = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf";
  if (!isImage && !isPdf) {
    topicFormErrorEl.textContent = "Please choose an image or PDF file.";
    topicAttachInput.value = "";
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    topicFormErrorEl.textContent = "That file is too large (15MB max).";
    topicAttachInput.value = "";
    return;
  }
  topicFormErrorEl.textContent = "";
  pendingTopicAttachment = file;
  topicAttachFilenameEl.textContent = file.name;
});

topicSaveBtn.addEventListener("click", async () => {
  topicFormErrorEl.textContent = "";
  const title = topicTitleInput.value.trim();
  const description = topicDescriptionInput.value.trim();
  if (!title) {
    topicFormErrorEl.textContent = "Give the topic a title.";
    return;
  }

  topicSaveBtn.disabled = true;
  topicSaveBtn.textContent = "Saving...";
  try {
    let attachmentUrl = null;
    let attachmentType = null;
    let attachmentName = null;
    if (pendingTopicAttachment) {
      const path = groupStoragePath(`topic-media/${currentUser.uid}/${Date.now()}_${pendingTopicAttachment.name}`);
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, pendingTopicAttachment);
      attachmentUrl = await getDownloadURL(storageRef);
      attachmentType = pendingTopicAttachment.type.startsWith("image/") ? "image" : "pdf";
      attachmentName = pendingTopicAttachment.name;
    }

    const newTopicRef = await addDoc(groupCollection("topics"), {
      title,
      description,
      attachmentUrl,
      attachmentType,
      attachmentName,
      createdBy: currentUser.uid,
      createdByName: currentMemberProfile.name,
      createdAt: serverTimestamp(),
      lastMessageAt: serverTimestamp(),
    });
    // The creator has implicitly "read" their own new topic.
    await setDoc(topicReadDoc(newTopicRef.id), { lastReadAt: serverTimestamp() });

    newTopicFormEl.hidden = true;
    resetNewTopicForm();
  } catch (err) {
    console.error(err);
    topicFormErrorEl.textContent = "Something went wrong saving the topic. Please try again.";
    topicSaveBtn.disabled = false;
    topicSaveBtn.textContent = "Start topic";
  }
});

async function renderTopics() {
  if (allTopics.length === 0) {
    topicsListEl.innerHTML = `<div class="empty-state">No topics yet - start one!</div>`;
    return;
  }

  // Figure out unread status for each topic (does it have activity since
  // this member last opened it) in parallel, rather than one at a time.
  const withUnread = await Promise.all(
    allTopics.map(async (t) => {
      let unread = false;
      try {
        const readSnap = await getDoc(topicReadDoc(t.id));
        const lastReadAt = readSnap.exists() ? readSnap.data().lastReadAt : null;
        const lastMessageAt = t.lastMessageAt || t.createdAt;
        unread = !lastReadAt || (lastMessageAt && lastMessageAt.toMillis() > lastReadAt.toMillis());
      } catch (err) {
        // If we can't tell, default to not-unread rather than erroring the whole list.
      }
      return { ...t, unread };
    })
  );

  topicsListEl.innerHTML = "";
  withUnread.forEach((t) => {
    const card = document.createElement("div");
    card.className = "topic-card";
    card.innerHTML = `
      <div class="topic-icon">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 4h16v12H8l-4 4V4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div style="flex:1;">
        <div class="topic-title">${escapeHtml(t.title)}</div>
        <div class="topic-meta">Started by ${escapeHtml(t.createdByName || "a member")}</div>
      </div>
      ${t.unread ? '<div class="topic-unread-dot" title="Unread"></div>' : ""}
    `;
    card.addEventListener("click", () => openTopicDetail(t));
    topicsListEl.appendChild(card);
  });
}

async function openTopicDetail(t) {
  topicDetailTitleEl.textContent = t.title;
  topicDetailMetaEl.textContent = `Started by ${t.createdByName || "a member"}${t.description ? " - " + t.description : ""}`;

  topicAttachmentEl.innerHTML = "";
  if (t.attachmentUrl) {
    if (t.attachmentType === "image") {
      topicAttachmentEl.innerHTML = `<img src="${t.attachmentUrl}" alt="${escapeHtml(t.attachmentName || "Topic attachment")}" />`;
    } else {
      topicAttachmentEl.innerHTML = `<a class="attachment-link" href="${t.attachmentUrl}" target="_blank" rel="noopener">View attachment: ${escapeHtml(t.attachmentName || "PDF")}</a>`;
    }
  }

  Object.values(views).forEach((v) => (v.hidden = true));
  views.topicDetail.hidden = false;

  // Mark read as soon as they open it, so the unread dot clears promptly.
  setDoc(topicReadDoc(t.id), { lastReadAt: serverTimestamp() }).catch((err) => console.error(err));

  if (unsubTopicDetail) unsubTopicDetail();
  const q = query(collection(db, "groups", GROUP_ID, "topics", t.id, "messages"), orderBy("createdAt", "asc"), limit(200));
  unsubTopicDetail = onSnapshot(q, (snap) => {
    topicMessagesEl.innerHTML = "";
    snap.forEach((docSnap) => renderMessage(topicMessagesEl, docSnap.data(), false));
    topicMessagesEl.scrollTop = topicMessagesEl.scrollHeight;
  });

  buildComposer(document.getElementById("topic-composer"), {
    placeholder: "Message this topic",
    messagesCollectionRef: collection(db, "groups", GROUP_ID, "topics", t.id, "messages"),
    onAfterSend: () => setDoc(groupDoc("topics", t.id), { lastMessageAt: serverTimestamp() }, { merge: true }),
  });
}

topicBackBtn.addEventListener("click", () => {
  if (unsubTopicDetail) unsubTopicDetail();
  showTab("topics");
  renderTopics(); // refresh unread dots now that one may have just been read
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
  const q = query(groupCollection("messages"), orderBy("createdAt", "asc"), limit(200));
  onSnapshot(q, (snap) => {
    chatMessagesEl.innerHTML = "";
    snap.forEach((docSnap) => renderMessage(chatMessagesEl, docSnap.data(), true));
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Shared composer (used by both general chat and event discussion)
// ---------------------------------------------------------------------------
function buildComposer(container, { eventId = null, eventTitle = null, placeholder = "Type a message", messagesCollectionRef = null, onAfterSend = null } = {}) {
  const targetCollection = messagesCollectionRef || groupCollection("messages");
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

  const textInput = document.createElement("textarea");
  textInput.rows = 1;
  textInput.placeholder = placeholder;
  const autoGrow = () => {
    textInput.style.height = "auto";
    textInput.style.height = `${textInput.scrollHeight}px`;
  };
  textInput.addEventListener("input", autoGrow);

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
    autoGrow();
    await addDoc(targetCollection, {
      text,
      type: "text",
      senderId: currentUser.uid,
      senderName: currentMemberProfile.name,
      eventId: eventId || null,
      eventTitle: eventTitle || null,
      createdAt: serverTimestamp(),
    });
    if (onAfterSend) onAfterSend();
  };

  sendBtn.addEventListener("click", send);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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
      const path = groupStoragePath(`chat-media/${currentUser.uid}/${Date.now()}_${file.name}`);
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);

      await addDoc(targetCollection, {
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
      if (onAfterSend) onAfterSend();
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
  onSnapshot(query(groupCollection("members"), orderBy("name")), (snap) => {
    allMembers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMembers();
  });

  onSnapshot(query(groupCollection("events"), orderBy("date", "asc")), (snap) => {
    allEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderEvents();
  });

  onSnapshot(query(groupCollection("topics"), orderBy("lastMessageAt", "desc")), (snap) => {
    allTopics = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTopics();
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
