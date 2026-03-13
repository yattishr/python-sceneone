# SceneOne GCP Deployment

This repo deploys as two Cloud Run services:

- `sceneone-backend`: FastAPI, ADK, ffmpeg, GCS integration
- `sceneone-frontend`: Next.js UI and CopilotKit proxy

## 1. Bootstrap GCP resources

Run:

```bash
chmod +x scripts/bootstrap-gcp.sh
scripts/bootstrap-gcp.sh YOUR_PROJECT_ID us-central1 sceneone sceneone-media-prod sceneone-google-api-key
```

After the script creates the secret placeholder, add your Gemini API key:

```bash
printf '%s' 'YOUR_GEMINI_API_KEY' | gcloud secrets versions add sceneone-google-api-key --data-file=-
```

## 2. Create or discover public service URLs

`cloudbuild.yaml` needs stable public URLs for both services because:

- the browser needs `NEXT_PUBLIC_BACKEND_URL`
- the backend CORS config needs the frontend origin
- the frontend bundle compiles `NEXT_PUBLIC_*` values at build time

Recommended approach:

1. Deploy backend once with a temporary value for `_FRONTEND_PUBLIC_URL`
2. Note the generated backend Cloud Run URL
3. Deploy frontend with that backend URL
4. Note the generated frontend Cloud Run URL
5. Re-run the build with both substitutions set correctly

If you already have custom domains, use those instead.

## 3. Deploy with Cloud Build

Example:

```bash
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_AR_REPO=sceneone,_BACKEND_PUBLIC_URL=https://sceneone-backend-REPLACE_ME.a.run.app,_FRONTEND_PUBLIC_URL=https://sceneone-frontend-REPLACE_ME.a.run.app,_GCS_BUCKET=sceneone-media-prod,_GEMINI_SECRET_NAME=sceneone-google-api-key
```

## 4. Runtime behavior in production

The backend deployment in [cloudbuild.yaml](/mnt/c/Projects/python-sceneone/cloudbuild.yaml) sets:

- `SYNC_UPLOADS_TO_GCS=true`
- `PERSIST_LOCAL_EXPORTS=false`

That means:

- `/upload-ad` finalizes WAVs and uploads them straight to GCS
- returned `download_url` values point at `/gcs/audio/...`
- Cloud Run instances do not keep local exported audio as the source of truth

Local development still works without this path because the backend defaults to local exports unless you enable direct GCS sync.

## 5. Files involved

- Build pipeline: [cloudbuild.yaml](/mnt/c/Projects/python-sceneone/cloudbuild.yaml)
- Backend container: [Dockerfile](/mnt/c/Projects/python-sceneone/Dockerfile)
- Frontend container: [Dockerfile](/mnt/c/Projects/python-sceneone/scene-one-frontend/Dockerfile)
- Environment matrix: [gcp-env-matrix.md](/mnt/c/Projects/python-sceneone/docs/gcp-env-matrix.md)
- Bootstrap script: [bootstrap-gcp.sh](/mnt/c/Projects/python-sceneone/scripts/bootstrap-gcp.sh)

## 6. Recommended follow-up

After first deploy, verify:

1. frontend can call backend over HTTPS without CORS errors
2. WebSocket `/run_live` connects through Cloud Run
3. a generated asset lands in `gs://sceneone-media-prod/audio/` and `gs://sceneone-media-prod/scripts/`
4. asset playback in the dock uses the `/gcs/audio/...` URL returned by the backend
