# SceneOne GCP Environment Matrix

This project deploys as two Cloud Run services:

- `sceneone-backend`: FastAPI + ADK + audio processing + GCS API
- `sceneone-frontend`: Next.js studio UI + CopilotKit proxy

## Backend

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `GOOGLE_API_KEY` | Yes, unless you switch code to Vertex-only auth | `projects/.../secrets/sceneone-google-api-key` | Gemini auth. In Cloud Run this should come from Secret Manager. |
| `GOOGLE_CLOUD_PROJECT` | Yes | `my-gcp-project` | Used by current backend auth validation and GCP SDK clients. |
| `GOOGLE_CLOUD_LOCATION` | Yes | `us-central1` | Gemini/Vertex region and general runtime region. |
| `GCS_BUCKET` | Yes | `sceneone-media-prod` | Bucket used by `/gcs/*` routes and helper CLI. |
| `ADK_LIVE_APP_NAME` | Recommended | `scene_one_agent` | Live session app name passed into ADK runner. |
| `ALLOWED_ORIGINS` | Yes in production | `https://studio.example.com` | Comma-separated browser origins allowed by CORS. |
| `SYNC_UPLOADS_TO_GCS` | Recommended in production | `true` | Makes `/upload-ad` publish finalized WAVs directly to GCS and return GCS-backed URLs. |
| `PERSIST_LOCAL_EXPORTS` | Recommended in production | `false` | Keeps Cloud Run instances from accumulating ephemeral local export files after GCS sync. |
| `PORT` | Cloud Run injects it | `8080` | Container listen port. |

## Frontend

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | Yes | `https://sceneone-backend-xyz.a.run.app` | Browser target for `/upload-ad`, `/gcs/*`, `/run_live`. Build-time critical because the main UI is a client component. |
| `COPILOTKIT_AGENT_URL` | Yes | `https://sceneone-backend-xyz.a.run.app/copilotkit` | Next.js server-side proxy target for CopilotKit. |
| `NEXT_PUBLIC_ADK_LIVE_APP_NAME` | Recommended | `scene_one_agent` | Browser WebSocket query param. |
| `NEXT_PUBLIC_ADK_LIVE_USER_ID` | Recommended | `studio_user_01` | Browser WebSocket query param. |
| `NEXT_PUBLIC_ADK_LIVE_MODALITY` | Recommended | `AUDIO` | Browser WebSocket response modality. |
| `PORT` | Cloud Run injects it | `8080` | Container listen port. |

## Build-Time vs Runtime

`NEXT_PUBLIC_*` values are compiled into the frontend bundle. For that reason, `cloudbuild.yaml` passes them as Docker build args during the frontend image build.

`COPILOTKIT_AGENT_URL` is also set at deploy time for the Next.js server runtime, but the critical browser-facing URL is `NEXT_PUBLIC_BACKEND_URL`.

## IAM

Recommended service accounts:

- `sceneone-backend@PROJECT_ID.iam.gserviceaccount.com`
- `sceneone-frontend@PROJECT_ID.iam.gserviceaccount.com`

Backend service account should have:

- `Storage Object Admin` or narrower bucket-scoped object permissions on the target bucket
- `Secret Manager Secret Accessor` on the Gemini API key secret
- any additional Vertex AI permissions if you later switch from API key auth to Vertex auth

Frontend service account can usually be minimal unless you add server-side integrations later.

## Current Constraints

- Backend local files under `exports/` are still ephemeral on Cloud Run instances when you keep `PERSIST_LOCAL_EXPORTS=true`.
- With `SYNC_UPLOADS_TO_GCS=true`, production asset URLs come back as `/gcs/*` routes instead of local `/download/*` paths.
- `cloudbuild.yaml` assumes you already know the public backend and frontend URLs or custom domains and set them in substitutions before the build runs.
