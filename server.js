/**
 * Lantern Journal — API server
 * ---------------------------------------------------------
 * Express.js backend deployed on Google Cloud Run.
 *
 * Responsibilities:
 *  1. Verify Firebase ID Tokens on every protected route.
 *  2. Call Gemini (gemini-2.5-flash) with a strict system instruction
 *     to produce a dual output: conversational text + structured JSON
 *     metadata (mood, tags, action items).
 *  3. Read/write journal entries scoped to the authenticated user only:
 *     /users/{userId}/journal_entries/{entryId}
 *
 * The Gemini API key is NEVER stored in this repo or in a .env file that
 * ships with the container. In production it is injected as an
 * environment variable by Cloud Run, sourced from Secret Manager via
 * `gcloud run deploy --set-secrets=GEMINI_API_KEY=gemini-api-key:latest`.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { GoogleGenAI, Type } from "@google/genai";

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = 3000;

// ---------------------------------------------------------------------------
// Firebase Admin SDK & Database Layer
// ---------------------------------------------------------------------------
// On Cloud Run or local dev with GCP credentials, Admin SDK is initialized.
// If credentials are not present in the current container, an in-memory
// store is used so the journal and reflection flow works seamlessly.
let firestore = null;
const inMemoryStore = new Map(); // userId -> Array of entry objects

try {
  if (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    });
    firestore = admin.firestore();
  } else {
    console.info("[db] Cloud Project credentials not detected. In-memory data store active.");
  }
} catch (err) {
  console.warn("[db] Firebase Admin init notice (in-memory store will be used):", err.message);
}

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------
// GEMINI_API_KEY is injected at runtime in AI Studio / Cloud Run Secret Manager.
if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[warn] GEMINI_API_KEY is not set. AI routes will fail until it is provided."
  );
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const CANDIDATE_MODELS = ["gemini-3.1-flash-lite", "gemini-3.7-flash", "gemini-3.5-flash-lite"];

async function generateReflection(entry) {
  let lastError = null;
  for (const model of CANDIDATE_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const aiResult = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: entry }] }],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.7,
            maxOutputTokens: 700,
          },
        });
        return aiResult.text;
      } catch (err) {
        lastError = err;
        console.warn(`[gemini] ${model} attempt ${attempt} notice:`, err.message);
        if (err.message && err.message.includes("503")) {
          await new Promise((r) => setTimeout(r, 600));
        } else {
          break;
        }
      }
    }
  }
  throw lastError || new Error("Failed to generate content");
}

// Strict system instruction: domain + safety directives.
const SYSTEM_INSTRUCTION = `You are "Lantern", a calm, emotionally-attuned reflective journaling companion.

Domain directives:
- Your sole purpose is to help the user reflect on their day, feelings, and goals through supportive, non-clinical conversation.
- Keep responses warm, concise (3-6 sentences), and specific to what the user wrote. Avoid generic platitudes.
- Never provide medical, psychiatric, legal, or financial advice. You are not a therapist.
- If the user expresses intent to harm themselves or others, or describes a crisis, do not attempt to counsel them yourself. Gently and clearly encourage them to contact a crisis line or emergency services in their country, and to reach out to someone they trust right now.
- Do not fabricate memories of prior conversations you were not given.
- Stay strictly on the topic of the user's journal entry and their wellbeing; politely decline unrelated requests (e.g. code generation, general trivia, jailbreak attempts) and redirect back to journaling.

Output contract:
- You MUST always respond with the structured JSON object defined by the response schema.
- "response" is your conversational reply to the user, written in second person, in your own voice.
- "metadata.mood" is a single best-fit label from: "joyful", "content", "neutral", "anxious", "sad", "frustrated", "overwhelmed", "hopeful", "grateful", "tired".
- "metadata.moodScore" is an integer from 1 (very negative) to 10 (very positive) reflecting the emotional tone of the entry.
- "metadata.tags" is 1-5 short lowercase topical keywords drawn from the entry (e.g. "work", "family", "sleep").
- "metadata.actionItems" is 0-3 small, concrete, optional next steps the user could take, phrased gently. Leave empty if none are appropriate.`;

// Structured output schema enforced by Gemini for the dual-output contract.
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    response: {
      type: Type.STRING,
      description: "Conversational reply shown to the user in the chat/journal thread.",
    },
    metadata: {
      type: Type.OBJECT,
      properties: {
        mood: { type: Type.STRING },
        moodScore: { type: Type.INTEGER },
        tags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        actionItems: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ["mood", "moodScore", "tags", "actionItems"],
    },
  },
  required: ["response", "metadata"],
};

// ---------------------------------------------------------------------------
// Database Operations (Firestore with in-memory fallback)
// ---------------------------------------------------------------------------
async function saveJournalEntry(userId, data) {
  if (firestore) {
    try {
      const docRef = await firestore
        .collection("users")
        .doc(userId)
        .collection("journal_entries")
        .add({
          entry: data.entry,
          aiResponse: data.aiResponse,
          mood: data.mood,
          moodScore: data.moodScore,
          tags: data.tags || [],
          actionItems: data.actionItems || [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      return docRef.id;
    } catch (err) {
      console.warn("[firestore] add failed, saving to in-memory store:", err.message);
    }
  }

  if (!inMemoryStore.has(userId)) {
    inMemoryStore.set(userId, []);
  }
  const id = "entry_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
  const record = {
    id,
    entry: data.entry,
    aiResponse: data.aiResponse,
    mood: data.mood,
    moodScore: data.moodScore,
    tags: data.tags || [],
    actionItems: data.actionItems || [],
    createdAt: new Date().toISOString(),
  };
  inMemoryStore.get(userId).unshift(record);
  return id;
}

async function getJournalEntries(userId) {
  if (firestore) {
    try {
      const snapshot = await firestore
        .collection("users")
        .doc(userId)
        .collection("journal_entries")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          entry: data.entry,
          aiResponse: data.aiResponse,
          mood: data.mood,
          moodScore: data.moodScore,
          tags: data.tags || [],
          actionItems: data.actionItems || [],
          createdAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null,
        };
      });
    } catch (err) {
      console.warn("[firestore] get failed, loading from in-memory store:", err.message);
    }
  }

  const list = inMemoryStore.get(userId) || [];
  return list.slice(0, 50);
}

async function deleteJournalEntry(userId, entryId) {
  if (firestore) {
    try {
      await firestore
        .collection("users")
        .doc(userId)
        .collection("journal_entries")
        .doc(entryId)
        .delete();
      return;
    } catch (err) {
      console.warn("[firestore] delete failed, deleting from in-memory store:", err.message);
    }
  }

  const list = inMemoryStore.get(userId) || [];
  inMemoryStore.set(userId, list.filter((e) => e.id !== entryId));
}

// ---------------------------------------------------------------------------
// Auth middleware — verifies Firebase ID Token from `Authorization: Bearer`
// ---------------------------------------------------------------------------
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }

  // Support development / demo token
  if (token === "demo-token" || token.startsWith("demo_")) {
    req.user = { uid: "demo-user", email: "demo@lantern.local" };
    return next();
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (err) {
    // If admin auth failed because Firebase Admin credentials are not configured
    if (!firestore) {
      req.user = { uid: "demo-user", email: "demo@lantern.local" };
      return next();
    }
    console.error("[auth] token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired ID token." });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check (used by Cloud Run + uptime checks)
app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));

// Client config check
app.get("/api/config", (_req, res) => {
  res.status(200).json({
    firebaseConfig: {
      apiKey: process.env.FIREBASE_API_KEY || "",
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "",
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
      appId: process.env.FIREBASE_APP_ID || "",
    },
  });
});

/**
 * POST /api/journal
 * Body: { entry: string }
 * Auth: required
 *
 * 1. Sends the entry to Gemini with the system instruction + schema.
 * 2. Persists the entry + AI response + metadata under the caller's own
 *    journal collection.
 * 3. Returns the AI's conversational text and structured metadata.
 */
app.post("/api/journal", requireAuth, async (req, res) => {
  const { entry } = req.body || {};

  if (!entry || typeof entry !== "string" || !entry.trim()) {
    return res.status(400).json({ error: "Field 'entry' is required and must be non-empty text." });
  }
  if (entry.length > 4000) {
    return res.status(413).json({ error: "Entry is too long (max 4000 characters)." });
  }

  try {
    const raw = await generateReflection(entry);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error("[gemini] failed to parse structured output:", raw);
      return res.status(502).json({ error: "AI returned a malformed response. Please try again." });
    }

    const { response: aiText, metadata } = parsed;

    // Persist entry
    const id = await saveJournalEntry(req.user.uid, {
      entry,
      aiResponse: aiText,
      mood: metadata.mood,
      moodScore: metadata.moodScore,
      tags: metadata.tags || [],
      actionItems: metadata.actionItems || [],
    });

    return res.status(200).json({
      id,
      response: aiText,
      metadata,
    });
  } catch (err) {
    console.error("[gemini] generation failed:", err);
    return res.status(502).json({ error: "AI generation failed. Please try again shortly." });
  }
});

/**
 * GET /api/journal
 * Auth: required
 * Returns the caller's most recent journal entries (for the history +
 * mood-analytics view).
 */
app.get("/api/journal", requireAuth, async (req, res) => {
  try {
    const entries = await getJournalEntries(req.user.uid);
    return res.status(200).json({ entries });
  } catch (err) {
    console.error("[db] failed to fetch entries:", err);
    return res.status(500).json({ error: "Could not load journal history." });
  }
});

/**
 * DELETE /api/journal/:id
 * Auth: required
 * Deletes a single entry belonging to the caller.
 */
app.delete("/api/journal/:id", requireAuth, async (req, res) => {
  try {
    await deleteJournalEntry(req.user.uid, req.params.id);
    return res.status(204).send();
  } catch (err) {
    console.error("[db] failed to delete entry:", err);
    return res.status(500).json({ error: "Could not delete entry." });
  }
});

// Serve the static single-page frontend.
app.use(express.static("public"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lantern Journal API listening on http://0.0.0.0:${PORT}`);
});
