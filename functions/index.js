const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

/**
 * Shared logic for both triggers below. Looks up who in this group wants
 * notifications, excludes the person who just posted, sends a data-only
 * push to everyone else, and always writes a plain log entry so results
 * can be checked directly in Firestore console rather than digging through
 * Cloud Functions' own logs.
 */
async function notifyGroup({ groupId, itemType, itemId, itemTitle, creatorUid, creatorName, extraBody }) {
  const logRef = db.collection("_debug_notifications").doc();

  try {
    const groupSnap = await db.doc(`groups/${groupId}`).get();
    if (!groupSnap.exists || !groupSnap.data().notificationsEnabled) {
      await logRef.set({
        groupId, itemType, itemId,
        skipped: true,
        reason: "notifications not enabled for this group",
        at: new Date(),
      });
      return;
    }
    const groupName = groupSnap.data().name || groupId;

    // Single-field filter only, deliberately - combining this with an
    // orderBy on a different field would need a composite index, which is
    // an easy trap to fall into and doesn't add anything useful here.
    const membersSnap = await db.collection(`groups/${groupId}/members`).where("notificationsOn", "==", true).get();

    const recipients = [];
    membersSnap.forEach((doc) => {
      if (doc.id === creatorUid) return; // don't notify people about their own post
      const token = doc.data().fcmToken;
      if (token) recipients.push({ uid: doc.id, token });
    });

    if (recipients.length === 0) {
      await logRef.set({ groupId, itemType, itemId, recipientCount: 0, note: "no eligible recipients", at: new Date() });
      return;
    }

    const title = itemType === "topic" ? `New topic in ${groupName}` : `New event in ${groupName}`;
    const body = itemType === "topic"
      ? `${itemTitle} - started by ${creatorName || "a member"}`
      : `${itemTitle}${extraBody ? " - " + extraBody : ""}`;

    // Data-only payload - see firebase-messaging-sw.js for why this
    // matters: a "notification" field here would cause it to be
    // auto-displayed AND built again by our own handler, showing twice.
    const response = await messaging.sendEachForMulticast({
      tokens: recipients.map((r) => r.token),
      data: { title, body, url: `/${groupId}` },
    });

    // Clean up any tokens Firebase says are no longer valid (uninstalled,
    // permission revoked, etc.) so we stop wasting sends on them.
    const staleUids = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          staleUids.push(recipients[i].uid);
        }
      }
    });
    await Promise.all(
      staleUids.map((uid) => db.doc(`groups/${groupId}/members/${uid}`).set({ notificationsOn: false, fcmToken: null }, { merge: true }))
    );

    await logRef.set({
      groupId, itemType, itemId,
      recipientCount: recipients.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      staleTokensCleared: staleUids.length,
      at: new Date(),
    });
  } catch (err) {
    await logRef.set({ groupId, itemType, itemId, error: String(err), at: new Date() });
  }
}

exports.onNewTopic = onDocumentCreated("groups/{groupId}/topics/{topicId}", async (event) => {
  const data = event.data.data();
  await notifyGroup({
    groupId: event.params.groupId,
    itemType: "topic",
    itemId: event.params.topicId,
    itemTitle: data.title,
    creatorUid: data.createdBy,
    creatorName: data.createdByName,
  });
});

exports.onNewEvent = onDocumentCreated("groups/{groupId}/events/{eventId}", async (event) => {
  const data = event.data.data();
  const dateStr = data.date && typeof data.date.toDate === "function"
    ? data.date.toDate().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
    : "";
  await notifyGroup({
    groupId: event.params.groupId,
    itemType: "event",
    itemId: event.params.eventId,
    itemTitle: data.title,
    creatorUid: data.createdBy,
    creatorName: data.createdByName,
    extraBody: dateStr,
  });
});
