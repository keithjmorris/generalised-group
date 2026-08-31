import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, orderBy, query
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
const newGroupNotificationsEl = document.getElementById("new-group-notifications");
const newGroupIconBtn = document.getElementById("new-group-icon-btn");
const newGroupIconInput = document.getElementById("new-group-icon-input");
const newGroupIconFilenameEl = document.getElementById("new-group-icon-filename");
const changeGroupIconInput = document.getElementById("change-group-icon-input");
let pendingGroupIcon = null;

newGroupIconBtn.addEventListener("click", () => newGroupIconInput.click());
newGroupIconInput.addEventListener("change", () => {
  const file = newGroupIconInput.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    adminFormErrorEl.textContent = "Please choose an image file.";
    newGroupIconInput.value = "";
    return;
  }
  pendingGroupIcon = file;
  newGroupIconFilenameEl.textContent = file.name;
});
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
      ${g.iconUrl ? `<img src="${g.iconUrl}" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover;flex-shrink:0;" />` : ""}
      <div style="flex:1;">
        <div class="member-name">${escapeHtml(g.name || g.id)}</div>
        <div class="member-role">groupinfo.app/${escapeHtml(g.id)} - signs in with ${g.authMethod === "email" ? "email & password" : "phone number"}</div>
      </div>
      <button class="btn-secondary notif-toggle-btn" data-group-id="${escapeHtml(g.id)}" data-current="${g.notificationsEnabled ? "on" : "off"}" style="flex-shrink:0;">
        Notifications: ${g.notificationsEnabled ? "On" : "Off"}
      </button>
      <button class="btn-secondary change-icon-btn" data-group-id="${escapeHtml(g.id)}" style="flex-shrink:0;">
        ${g.iconUrl ? "Change icon" : "Add icon"}
      </button>
    `;
    groupsListEl.appendChild(row);
  });

  groupsListEl.querySelectorAll(".notif-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const groupId = btn.dataset.groupId;
      const newValue = btn.dataset.current !== "on";
      btn.disabled = true;
      try {
        await setDoc(doc(db, "groups", groupId), { notificationsEnabled: newValue }, { merge: true });
        loadGroups();
      } catch (err) {
        console.error(err);
        alert("Couldn't update that group. Please try again.");
        btn.disabled = false;
      }
    });
  });

  groupsListEl.querySelectorAll(".change-icon-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      changeGroupIconInput.dataset.groupId = btn.dataset.groupId;
      changeGroupIconInput.click();
    });
  });
}

changeGroupIconInput.addEventListener("change", async () => {
  const file = changeGroupIconInput.files[0];
  const groupId = changeGroupIconInput.dataset.groupId;
  changeGroupIconInput.value = "";
  if (!file || !groupId) return;
  if (!file.type.startsWith("image/")) {
    alert("Please choose an image file.");
    return;
  }
  try {
    const path = `groups/${groupId}/group-icon/${Date.now()}_${file.name}`;
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file);
    const iconUrl = await getDownloadURL(storageRef);
    await setDoc(doc(db, "groups", groupId), { iconUrl }, { merge: true });
    loadGroups();
  } catch (err) {
    console.error(err);
    alert("Couldn't upload that icon. Please try again.");
  }
});

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

    let iconUrl = null;
    if (pendingGroupIcon) {
      const path = `groups/${slug}/group-icon/${Date.now()}_${pendingGroupIcon.name}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, pendingGroupIcon);
      iconUrl = await getDownloadURL(storageRef);
    }

    await setDoc(doc(db, "groups", slug), {
      name,
      authMethod: newGroupAuthMethodEl.value,
      notificationsEnabled: newGroupNotificationsEl.checked,
      iconUrl,
    });
    newGroupSlugEl.value = "";
    newGroupNameEl.value = "";
    newGroupAuthMethodEl.value = "phone";
    newGroupNotificationsEl.checked = false;
    pendingGroupIcon = null;
    newGroupIconFilenameEl.textContent = "";
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
