# CarChat

A member directory, events list, and WhatsApp-styled chat, built as a plain
HTML/JS site (no build step) so it deploys to Vercel straight from GitHub.
Members sign in with their phone number (international dialing supported).

Chat and event comments share one `messages` collection - a message tagged
with an `eventId` shows up both in the general chat (with a small "on: Event
name" tag) and in that event's own filtered discussion view.

## Files

- `index.html` - page structure and the three tabs (Members, Events, Chat)
- `style.css` - the WhatsApp-style visual treatment
- `app.js` - all the logic: auth, Firestore listeners, Storage uploads
- `firebase-config.js` - **you edit this** with your project's config
- `firestore.rules` / `storage.rules` - security rules to paste into Firebase

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and click **Add project**. Name it anything (e.g. "community-app"). You can leave Google Analytics off.
2. Once it's created, click the **</> (web)** icon on the project overview page to register a web app. Give it a nickname; you don't need Firebase Hosting since you're using Vercel.
3. Firebase will show you a `firebaseConfig` object with keys like `apiKey`, `authDomain`, etc. Copy those values into `firebase-config.js` in this project, replacing the `"REPLACE_ME"` placeholders.

## 2. Turn on Authentication (phone number)

1. In the left sidebar, go to **Build > Authentication > Get started**.
2. Under **Sign-in method**, enable **Phone**.
3. Phone auth requires the **Blaze (pay-as-you-go)** plan - you'll be prompted to add a billing method if you haven't already. Normal usage stays within the free monthly SMS quota; you only pay if you go beyond it.
4. Under **Settings > Authorized domains**, add your Vercel domain once you have it (e.g. `your-app.vercel.app`) - `localhost` is already allowed for testing. This matters for phone auth because the reCAPTCHA check is tied to authorized domains.
5. Optional but recommended while building: under **Sign-in method > Phone > Phone numbers for testing**, add a fake number (e.g. `+44 7700 900000`) with a fixed code (e.g. `123456`). Signing in with it won't send a real SMS, so you can test the whole flow for free.

## 3. Turn on Firestore

1. Go to **Build > Firestore Database > Create database**.
2. Choose a location close to your members, and start in **production mode** (we're supplying our own rules).
3. Once it's created, go to the **Rules** tab and replace the contents with everything in `firestore.rules` from this project. Click **Publish**.

You don't need to manually create the `members`, `events`, or `messages`
collections - Firestore creates them automatically the first time the app
writes to them (e.g. the first person who signs in creates the `members`
collection; the first event you add creates `events`).

### Adding your first event

There's no "add event" screen in this first version - the simplest way to
add one is directly in the console:

1. Go to **Firestore Database > Data > Start collection**, name it `events`.
2. Add a document (auto-ID is fine) with these fields:
   - `title` (string) - e.g. "Summer social"
   - `date` (timestamp) - pick the date/time
   - `location` (string) - e.g. "Garden"
3. Repeat for more events.

(Once you're happy with the app, this is a natural next thing to have me
build as an in-app "add event" form restricted to a few admin members.)

## 4. Turn on Storage (for photo/video uploads in chat)

1. Go to **Build > Storage > Get started**, and again choose production mode.
2. Go to the **Rules** tab and replace the contents with everything in `storage.rules` from this project. Click **Publish**.

## 5. Push to GitHub and deploy on Vercel

1. In VS Code, initialize a git repo in this folder, commit, and push to a new GitHub repository.
2. In Vercel, **Add New > Project**, import that GitHub repo. Since this is a static site with no build step, you can leave the framework preset as "Other" - no build command or output directory is needed.
3. Deploy. Once it's live, go back to Firebase Authentication settings (step 2.3) and add the Vercel URL to Authorized domains.

## Notes on scaling this up

- **Country code list**: `app.js` has a short curated list of common dialing
  codes for the picker. Anyone outside that list can still sign in by typing
  their full number starting with "+" in the phone field. Easy to extend the
  list, or swap in a full country picker library later if you want flags/search.
- **Member roles/approval**: right now anyone who verifies a phone number is
  automatically added as a member. If you want new sign-ins to need approval
  first, we can add a `status` field (`pending`/`approved`) and gate the app
  UI on it.
- **Admin-only events**: the current rules let any signed-in member create
  events. If you want that limited to a few people, we can add an `isAdmin`
  flag on member docs and check it in `firestore.rules`.
- **Video length**: there's a 60MB upload cap but no duration check yet -
  easy to add client-side if long videos become an issue.
