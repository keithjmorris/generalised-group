# CarChat (multi-group)

A member directory, events list, and WhatsApp-styled chat, built as a plain
HTML/JS site (no build step) so it deploys to Vercel straight from GitHub.
Members sign in with their phone number (international dialing supported).

This app supports **any number of separate groups** from one shared
Firebase project and one Vercel deployment. Each group gets its own URL -
`your-app.vercel.app/g/carchat`, `your-app.vercel.app/g/burnham-owners`, and
so on - and each group's members, events, and chat are completely separate
from every other group's, even though they all live in the same database.
A person can be a member of more than one group; which group they're using
is simply whichever group's link they opened.

Chat and event comments share one `messages` collection (per group) - a
message tagged with an `eventId` shows up both in the general chat (with a
small "on: Event name" tag) and in that event's own filtered discussion view.

## Files

- `index.html` - page structure and the three tabs (Members, Events, Chat)
- `style.css` - the WhatsApp-style visual treatment
- `app.js` - all the logic: group resolution, auth, Firestore listeners, Storage uploads
- `firebase-config.js` - **you edit this** with your project's config
- `firestore.rules` / `storage.rules` - security rules to paste into Firebase
- `vercel.json` - tells Vercel that any `/g/...` link should load this app

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and click **Add project**. Name it anything (e.g. "community-app"). You can leave Google Analytics off.
2. Once it's created, click the **</> (web)** icon on the project overview page to register a web app. Give it a nickname; you don't need Firebase Hosting since you're using Vercel.
3. Firebase will show you a `firebaseConfig` object with keys like `apiKey`, `authDomain`, etc. Copy those values into `firebase-config.js` in this project, replacing the `"REPLACE_ME"` placeholders.

## 2. Turn on Authentication (phone number)

1. In the left sidebar, go to **Build > Authentication > Get started**.
2. Under **Sign-in method**, enable **Phone**.
3. Phone auth requires the **Blaze (pay-as-you-go)** plan - you'll be prompted to add a billing method if you haven't already. Normal usage stays within the free monthly SMS quota; you only pay if you go beyond it.
4. Under **Settings > Authorized domains**, add your Vercel domain once you have it (e.g. `your-app.vercel.app`) - `localhost` is already allowed for testing.
5. Under **Settings > SMS region policy**, set it to **Allow** and add the regions your members are actually in (e.g. UK, EU). Real numbers outside the allowed regions will be rejected until added here.
6. Optional but recommended while building: under **Sign-in method > Phone > Phone numbers for testing**, add a fake number with a fixed code (e.g. `123456`). Avoid the `07700 900xxx` UK range specifically - it's reserved by Ofcom as fictional and can get rejected by Firebase's own validation; pick a number that merely looks plausible instead. Signing in with a registered test number won't send a real SMS or trigger reCAPTCHA, so you can test the whole flow for free.

## 3. Turn on Firestore

1. Go to **Build > Firestore Database > Create database**.
2. Choose a location close to your members, and start in **production mode** (we're supplying our own rules).
3. Once it's created, go to the **Rules** tab and replace the contents with everything in `firestore.rules` from this project. Click **Publish**.

### Creating a new group

Unlike members/events/messages (which get created automatically the first
time the app writes to them), **the group record itself must be created
manually** before anyone can sign in to it:

1. Go to **Firestore Database > Data**.
2. Click **Start collection**, name it `groups` (only needed the first time).
3. Click **Add document**. For the **Document ID**, type the URL slug you want - e.g. `carchat` or `burnham-owners` (lowercase, no spaces; this becomes part of the group's link).
4. Add one field: `name` (string) - the display name shown in the app, e.g. "CarChat" or "Burnham Owners Club".
5. Save.

That group is now live at `your-app.vercel.app/g/{the-slug-you-chose}`.
Share that link with that group's members - each group only ever sees its
own data.

### Adding an event

There's no admin-only restriction - any signed-in member can add an event
from the **+ New event** button on the Events tab, including an optional
poster attachment (image or PDF).

## 4. Turn on Storage (for photo/video uploads and event posters)

1. Go to **Build > Storage > Get started**, and again choose production mode.
2. Go to the **Rules** tab and replace the contents with everything in `storage.rules` from this project. Click **Publish**.

## 5. Push to GitHub and deploy on Vercel

1. In VS Code, initialize a git repo in this folder, commit, and push to a new GitHub repository.
2. In Vercel, **Add New > Project**, import that GitHub repo. Since this is a static site with no build step, you can leave the framework preset as "Other" - no build command or output directory is needed. Vercel will automatically pick up `vercel.json`, which is what makes `/g/...` links work.
3. Deploy. Once it's live, go back to Firebase Authentication settings (step 2.4) and add the Vercel URL to Authorized domains.

### Giving it a cleaner name than the default

Vercel assigns a random-looking default URL (e.g. `carchat-two.vercel.app`).
Two ways to tidy that up, both done in the Vercel dashboard rather than in
code:

- **Rename the project**: Project **Settings > General > Project Name**.
  Changing this changes the default `your-new-name.vercel.app` URL too.
- **Add a custom domain** (e.g. `mygroups.com`): Project **Settings >
  Domains**. Needs a domain you own and a quick DNS change at your domain
  registrar - ask if you'd like help with this step when you're ready.

Either way, once you have a general-purpose URL, every group's link is just
that URL plus `/g/{slug}` - nothing group-specific needs to live in the
domain name itself.

## Notes on scaling this up

- **Country code list**: `app.js` has a short curated list of common dialing
  codes for the picker. Anyone outside that list can still sign in by typing
  their full number starting with "+" in the phone field.
- **Member roles/approval**: right now anyone who verifies a phone number is
  automatically added as a member of whichever group's link they used. If
  you want new sign-ins to need approval first, we can add a `status` field
  (`pending`/`approved`) and gate the app UI on it.
- **Group creation UI**: groups are currently created manually in Firestore
  console by design (per your preference) - a self-service "create a group"
  screen is possible later if that ever becomes useful.
- **Email/password sign-in**: not yet added, but is a separate, independent
  piece of work from the multi-group structure - a natural next step.
- **Video length**: there's a 60MB upload cap but no duration check yet -
  easy to add client-side if long videos become an issue.
