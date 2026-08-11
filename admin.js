import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, orderBy, query
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const signedOutEl = document.getElementById("signed-out");
const notAdminEl = document.getElementById("not-admin");
const adminPanelEl = document.getElementById("admin-panel");
const signinError = document.getElementById("signin-error");

const phoneStepEl = document.getElementById("phone-step");
const codeStepEl = document.getElementById("code-step");
const countryCodeEl = document.getElementById("country-code");
const phoneNumberEl = document.getElementById("phone-number");
const sendCodeBtn = document.getElementById("send-code-btn");
const smsCodeEl = document.getElementById("sms-code");
const verifyCodeBtn = document.getElementById("verify-code-btn");
const changeNumberBtn = document.getElementById("change-number-btn");
const codeSentToEl = document.getElementById("code-sent-to");

const notAdminSignoutBtn = document.getElementById("not-admin-signout-btn");
const adminSignoutBtn = document.getElementById("admin-signout-btn");
const groupsListEl = document.getElementById("groups-list");
const newGroupSlugEl = document.getElementById("new-group-slug");
const newGroupNameEl = document.getElementById("new-group-name");
const newGroupAuthMethodEl = document.getElementById("new-group-auth-method");
const createGroupBtn = document.getElementById("create-group-btn");
const adminFormErrorEl = document.getElementById("admin-form-error");

// ---------------------------------------------------------------------------
// Phone sign-in (same pattern as the main app)
// ---------------------------------------------------------------------------
const COUNTRY_CODES = [
  { code: "+44", label: "UK +44" },
  { code: "+1", label: "US/Canada +1" },
  { code: "+353", label: "Ireland +353" },
  { code: "+33", label: "France +33" },
  { code: "+49", label: "Germany +49" },
  { code: "+34", label: "Spain +34" },
  { code: "+39", label: "Italy +39" },
];
COUNTRY_CODES.forEach(({ code, label }) => {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = label;
  countryCodeEl.appendChild(opt);
});

let confirmationResult = null;
let recaptchaVerifier = null;

function getRecaptcha() {
  if (!recaptchaVerifier) {
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
  const fullNumber = raw.startsWith("+") ? raw.replace(/\s+/g, "") : `${countryCodeEl.value}${raw.replace(/\D/g, "")}`;

  sendCodeBtn.disabled = true;
  try {
    confirmationResult = await signInWithPhoneNumber(auth, fullNumber, getRecaptcha());
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
    signinError.textContent = `Couldn't send a code. (${err.code || "unknown error"})`;
    if (recaptchaVerifier) {
      recaptchaVerifier.clear();
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
  } catch (err) {
    console.error(err);
    signinError.textContent = `That code didn't match. (${err.code || "unknown error"})`;
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

notAdminSignoutBtn.addEventListener("click", () => signOut(auth));
adminSignoutBtn.addEventListener("click", () => signOut(auth));

// ---------------------------------------------------------------------------
// Admin gate + panel
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  [signedOutEl, notAdminEl, adminPanelEl].forEach((el) => (el.hidden = true));

  if (!user) {
    signedOutEl.hidden = false;
    phoneStepEl.hidden = false;
    codeStepEl.hidden = true;
    phoneNumberEl.value = "";
    smsCodeEl.value = "";
    return;
  }

  const adminSnap = await getDoc(doc(db, "admins", user.uid));
  if (!adminSnap.exists()) {
    notAdminEl.hidden = false;
    return;
  }

  adminPanelEl.hidden = false;
  loadGroups();
});

async function loadGroups() {
  groupsListEl.innerHTML = `<div class="empty-state">Loading...</div>`;
  const snap = await getDocs(query(collection(db, "groups")));
  const groups = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));

  groupsListEl.innerHTML = "";
  if (groups.length === 0) {
    groupsListEl.innerHTML = `<div class="empty-state">No groups yet.</div>`;
    return;
  }
  groups.forEach((g) => {
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `
      <div>
        <div class="member-name">${escapeHtml(g.name || g.id)}</div>
        <div class="member-role">groupinfo.app/${escapeHtml(g.id)} - signs in with ${g.authMethod === "email" ? "email & password" : "phone number"}</div>
      </div>
    `;
    groupsListEl.appendChild(row);
  });
}

createGroupBtn.addEventListener("click", async () => {
  adminFormErrorEl.textContent = "";
  const slug = newGroupSlugEl.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  const name = newGroupNameEl.value.trim();

  if (!slug) {
    adminFormErrorEl.textContent = "Enter a URL slug (letters, numbers, hyphens only).";
    return;
  }
  if (!name) {
    adminFormErrorEl.textContent = "Enter a display name.";
    return;
  }

  createGroupBtn.disabled = true;
  try {
    const existing = await getDoc(doc(db, "groups", slug));
    if (existing.exists()) {
      adminFormErrorEl.textContent = "That slug is already taken - choose another.";
      return;
    }
    await setDoc(doc(db, "groups", slug), { name, authMethod: newGroupAuthMethodEl.value });
    newGroupSlugEl.value = "";
    newGroupNameEl.value = "";
    newGroupAuthMethodEl.value = "phone";
    loadGroups();
  } catch (err) {
    console.error(err);
    adminFormErrorEl.textContent = "Something went wrong creating the group.";
  } finally {
    createGroupBtn.disabled = false;
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
