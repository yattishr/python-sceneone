#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/bootstrap-gcp.sh PROJECT_ID REGION ARTIFACT_REPO BUCKET SECRET_NAME

Example:
  scripts/bootstrap-gcp.sh my-project us-central1 sceneone sceneone-media-prod sceneone-google-api-key

This script creates:
  - required service APIs
  - Artifact Registry repo
  - backend/frontend service accounts
  - optional GCS bucket
  - Secret Manager secret placeholder
  - baseline IAM bindings for Cloud Run deployment
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 5 ]]; then
  usage
  exit 1
fi

PROJECT_ID="$1"
REGION="$2"
AR_REPO="$3"
BUCKET="$4"
SECRET_NAME="$5"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
BACKEND_SA="sceneone-backend@${PROJECT_ID}.iam.gserviceaccount.com"
FRONTEND_SA="sceneone-frontend@${PROJECT_ID}.iam.gserviceaccount.com"
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

echo "Setting project to ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

echo "Enabling required APIs"
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  storage.googleapis.com

if ! gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1; then
  echo "Creating Artifact Registry repo ${AR_REPO}"
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="SceneOne container images"
else
  echo "Artifact Registry repo ${AR_REPO} already exists"
fi

for account in sceneone-backend sceneone-frontend; do
  if ! gcloud iam service-accounts describe "${account}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    echo "Creating service account ${account}"
    gcloud iam service-accounts create "${account}" \
      --display-name="${account}"
  else
    echo "Service account ${account} already exists"
  fi
done

if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  echo "Creating bucket gs://${BUCKET}"
  gcloud storage buckets create "gs://${BUCKET}" --location="${REGION}"
else
  echo "Bucket gs://${BUCKET} already exists"
fi

if ! gcloud secrets describe "${SECRET_NAME}" >/dev/null 2>&1; then
  echo "Creating secret ${SECRET_NAME}"
  gcloud secrets create "${SECRET_NAME}" --replication-policy=automatic
  echo "Populate it with:"
  echo "  printf '%s' 'YOUR_GEMINI_API_KEY' | gcloud secrets versions add ${SECRET_NAME} --data-file=-"
else
  echo "Secret ${SECRET_NAME} already exists"
fi

echo "Granting Artifact Registry access to Cloud Build"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CLOUDBUILD_SA}" \
  --role="roles/artifactregistry.writer" >/dev/null

echo "Granting Cloud Run admin to Cloud Build"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CLOUDBUILD_SA}" \
  --role="roles/run.admin" >/dev/null

echo "Granting service account impersonation to Cloud Build"
for service_account in "${BACKEND_SA}" "${FRONTEND_SA}"; do
  gcloud iam service-accounts add-iam-policy-binding "${service_account}" \
    --member="serviceAccount:${CLOUDBUILD_SA}" \
    --role="roles/iam.serviceAccountUser" >/dev/null
done

echo "Granting bucket access to backend service account"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${BACKEND_SA}" \
  --role="roles/storage.objectAdmin" >/dev/null

echo "Granting secret access to backend service account"
gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
  --member="serviceAccount:${BACKEND_SA}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

echo "Bootstrap complete"
echo "Backend service account:  ${BACKEND_SA}"
echo "Frontend service account: ${FRONTEND_SA}"
echo "Artifact Registry repo:    ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
echo "Bucket:                    gs://${BUCKET}"
echo "Secret:                    ${SECRET_NAME}"
