#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lantern Journal — Cloud Run deployment script
#
# Usage:
#   export PROJECT_ID="your-gcp-project-id"
#   export REGION="us-central1"
#   export GEMINI_API_KEY="your-gemini-api-key"
#   ./deploy.sh
# ---------------------------------------------------------------------------
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID before running (export PROJECT_ID=your-project)}"
: "${REGION:=us-central1}"
: "${GEMINI_API_KEY:?Set GEMINI_API_KEY before running}"

SERVICE_NAME="lantern-journal"
SECRET_NAME="gemini-api-key"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "==> Setting active project to ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

echo "==> Enabling required APIs"
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  --project "${PROJECT_ID}"

echo "==> Ensuring Secret Manager secret exists: ${SECRET_NAME}"
if gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "    Secret exists — adding a new version."
  printf "%s" "${GEMINI_API_KEY}" | gcloud secrets versions add "${SECRET_NAME}" \
    --project "${PROJECT_ID}" --data-file=-
else
  echo "    Creating secret."
  printf "%s" "${GEMINI_API_KEY}" | gcloud secrets create "${SECRET_NAME}" \
    --project "${PROJECT_ID}" --data-file=- --replication-policy=automatic
fi

echo "==> Granting the Cloud Run runtime service account access to the secret"
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --project "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor"

echo "==> Building the container image with Cloud Build"
gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}"

echo "==> Deploying to Cloud Run"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --project "${PROJECT_ID}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-secrets="GEMINI_API_KEY=${SECRET_NAME}:latest" \
  --set-env-vars="GCLOUD_PROJECT=${PROJECT_ID}" \
  --min-instances=0 \
  --max-instances=10 \
  --memory=512Mi

echo "==> Fetching the deployed service URL"
gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format='value(status.url)'

echo "==> Done. Deploy your Firestore rules separately with:"
echo "    firebase deploy --only firestore:rules --project ${PROJECT_ID}"
