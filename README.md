# 🏮 Lantern Journal

**A user-authenticated, AI-guided reflective journal — built for the Google Cloud Run & AI Challenge.**

Write a journal entry, sign in with Google, and get a short, thoughtful reflection back from Gemini — plus a private, structured record of your mood, topics, and gentle next steps, stored in a per-user isolated Firestore collection.

`#AccelerateAIwithCloudRun`

![Node](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-4.x-000000?logo=express&logoColor=white)
![Cloud Run](https://img.shields.io/badge/Google%20Cloud%20Run-Serverless-4285F4?logo=googlecloud&logoColor=white)
![Firebase Auth](https://img.shields.io/badge/Firebase-Auth%20%2B%20Firestore-FFCA28?logo=firebase&logoColor=black)
![Gemini](https://img.shields.io/badge/Gemini-2.5%20Flash-8E75FF?logo=googlegemini&logoColor=white)
![Secret Manager](https://img.shields.io/badge/Secret%20Manager-Runtime%20Secrets-4285F4?logo=googlecloud&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-lightgrey)

---

## Live demo

- **App:** `<PLACEHOLDER: your Cloud Run URL>`
- **Demo video:** `<PLACEHOLDER: YouTube/Loom link>`

---

## Architecture

```
                         ┌─────────────────────────┐
                         │   Browser (public/)     │
                         │  index.html + vanilla JS │
                         └────────────┬─────────────┘
                                      │ 1. Google Sign-In (Firebase Auth SDK)
                                      ▼
                         ┌─────────────────────────┐
                         │      Firebase Auth       │
                         │   issues Firebase ID     │
                         │        Token (JWT)       │
                         └────────────┬─────────────┘
                                      │ 2. Authorization: Bearer <ID token>
                                      ▼
        ┌─────────────────────────────────────────────────────┐
        │                Google Cloud Run (server.js)          │
        │  Express.js API                                      │
        │  ┌─────────────────────────────────────────────────┐ │
        │  │ requireAuth middleware                           │ │
        │  │  → firebase-admin verifies ID token              │ │
        │  └─────────────────────────────────────────────────┘ │
        │                     │                                 │
        │        3. entry text  │  4. GEMINI_API_KEY (env,      │
        │                     │     injected from Secret        │
        │                     ▼     Manager at deploy time)      │
        │  ┌─────────────────────────────────────────────────┐ │
        │  │ Gemini 2.5 Flash (@google/genai)                 │ │
        │  │  • strict system instruction                     │ │
        │  │  • responseSchema → dual output:                 │ │
        │  │    { response, metadata{mood, tags, actions} }   │ │
        │  └─────────────────────────────────────────────────┘ │
        │                     │                                 │
        │        5. write entry + AI response + metadata        │
        │                     ▼                                 │
        └─────────────────────────────────────────────────────┘
                                      │
                                      ▼
                     ┌───────────────────────────────┐
                     │           Firestore             │
                     │ /users/{uid}/journal_entries/*  │
                     │  isolated per user by            │
                     │  firestore.rules + backend scope │
                     └───────────────────────────────┘
```

**Why this shape?**

| Layer | Service | Role |
|---|---|---|
| Identity | Firebase Auth (Google Sign-In) | Issues short-lived ID tokens; frontend never talks to Gemini or Firestore directly |
| Compute | Google Cloud Run | Stateless, autoscaling container for the Express API — scales to zero when idle |
| Secrets | Google Cloud Secret Manager | `GEMINI_API_KEY` is bound as a runtime env var, never baked into the image or repo |
| AI | Gemini 2.5 Flash (`@google/genai`) | Dual-output generation: conversational text + structured JSON metadata in one call |
| Data | Firestore | Per-user subcollections (`/users/{uid}/journal_entries`), enforced by security rules |

---

## Tech stack

- **Frontend:** static `public/index.html`, vanilla CSS/JS, Firebase Auth Web SDK (modular v10, Google provider)
- **Backend:** Node.js 20, Express.js
- **AI:** `@google/genai`, model `gemini-2.5-flash`, structured `responseSchema` output
- **Auth:** `firebase-admin` — verifies Firebase ID Tokens server-side on every request
- **Database:** Firestore, isolated per-user via `firestore.rules`
- **Secrets:** Google Cloud Secret Manager, bound to Cloud Run via `--set-secrets`
- **Hosting:** Google Cloud Run (containerized via Docker, Node 20 slim)

---

## Repository layout

```
lantern-journal/
├── server.js            # Express API: auth middleware, Gemini call, Firestore I/O
├── package.json
├── Dockerfile           # Node 20 container, listens on 8080
├── firestore.rules      # Per-user isolation security rules
├── .gitignore
├── .env.example         # Local-dev only; never used in production
└── public/
    └── index.html       # Single-page frontend (Firebase Auth + journal UI)
```

---

## Local development

### Prerequisites
- Node.js 20+
- A Firebase project with **Authentication → Google** sign-in enabled
- A Firestore database created in the same GCP project (Native mode)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- `gcloud auth application-default login` run once, so `firebase-admin`'s
  `applicationDefault()` credentials resolve locally

### Setup

```bash
git clone https://github.com/<your-username>/lantern-journal.git
cd lantern-journal
npm install

cp .env.example .env
# edit .env and set GEMINI_API_KEY + GCLOUD_PROJECT

npm start
# → Lantern Journal API listening on port 8080
```

Then open `public/index.html`'s Firebase config block and paste in your
web app's Firebase config (Firebase Console → Project settings → General →
Your apps → SDK setup and configuration). Visit `http://localhost:8080`.

### Deploy your Firestore rules

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules --project <your-project-id>
```

---

## Deploying to Google Cloud Run

See [`deploy.sh`](./deploy.sh) for the full scripted version. Summary:

```bash
# 1. Enable required APIs
gcloud services enable run.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com firestore.googleapis.com

# 2. Store the Gemini key in Secret Manager
printf "%s" "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-

# 3. Build the container
gcloud builds submit --tag gcr.io/$PROJECT_ID/lantern-journal

# 4. Deploy to Cloud Run with the secret bound as an env var
gcloud run deploy lantern-journal \
  --image gcr.io/$PROJECT_ID/lantern-journal \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars=GCLOUD_PROJECT=$PROJECT_ID
```

Full step-by-step commands, including IAM setup for the Cloud Run service
account to access Secret Manager and Firestore, are in the blog post and
`deploy.sh`.

---

## Security notes

- The Gemini API key is **never** committed to source control and is
  injected at runtime from Secret Manager — see `.gitignore` and `Dockerfile`.
- Every API route (except `/healthz`) requires a valid Firebase ID Token,
  verified server-side with `firebase-admin`.
- Firestore security rules (`firestore.rules`) enforce per-user isolation
  as defense in depth, independent of the backend.
- Gemini calls set explicit `safetySettings` and a system instruction that
  restricts the model to journaling support and redirects crisis language
  toward real human/professional resources.

---

## License

MIT — see the badge above. Built for **#AccelerateAIwithCloudRun**.
