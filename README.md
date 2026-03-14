# python-sceneone

SceneOne is a live ad-production app with:
- an ADK-backed creative director agent
- a Next.js studio UI
- a FastAPI backend that accepts mic recordings, cleans audio, and exports a final WAV

## Production Endpoints

Current Cloud Run endpoints:

- Frontend: `https://sceneone-frontend-x4wprlh2nq-uc.a.run.app`
- Backend: `https://sceneone-backend-x4wprlh2nq-uc.a.run.app`

Useful backend URLs in production:

- OpenAPI: `https://sceneone-backend-x4wprlh2nq-uc.a.run.app/openapi.json`
- Swagger UI: `https://sceneone-backend-x4wprlh2nq-uc.a.run.app/docs`

Notes:

- The frontend must be built with the same backend URL that Cloud Run is currently serving.
- The backend Cloud Run service must remain publicly invokable for browser access to `/gcs/*` and `/run_live`.
- `healthz` is defined by the app, but `/openapi.json` and `/docs` are the most reliable production verification endpoints.

## Automated Deployment

Cloud deployment is automated with Google Cloud Build and supporting setup scripts.

Primary automation files:

- [cloudbuild.yaml](/C:/Projects/python-sceneone/cloudbuild.yaml)
- [scripts/bootstrap-gcp.sh](/C:/Projects/python-sceneone/scripts/bootstrap-gcp.sh)
- [DEPLOY.md](/C:/Projects/python-sceneone/DEPLOY.md)

What the pipeline automates:

- builds backend and frontend container images
- pushes both images to Artifact Registry
- deploys both services to Cloud Run
- injects runtime environment variables and secrets
- configures the backend for browser access, GCS sync, and live audio
- reapplies public backend invoker access for `/gcs/*` and `/run_live`

Example deploy command:

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions="_REGION=us-central1,_AR_REPO=sceneone,_BACKEND_PUBLIC_URL=https://sceneone-backend-x4wprlh2nq-uc.a.run.app,_FRONTEND_PUBLIC_URL=https://sceneone-frontend-x4wprlh2nq-uc.a.run.app,_GCS_BUCKET=sceneone-media-prod,_GEMINI_SECRET_NAME=sceneone-google-api-key"
```

## Recording Loop

When the agent calls `capture_ad_script`:
1. Frontend records microphone audio for the selected duration (`10`, `20`, or `30` seconds).
2. Frontend uploads the recorded file to `POST /upload-ad`.
3. Backend trims silence, normalizes, applies fades, then enforces exact output length based on the selected duration.
4. Backend exports a WAV to `exports/audio` and returns a downloadable URL.

## Requirements

- Python 3.10+
- Node.js 18+
- FFmpeg (required by `pydub` for non-WAV browser recordings like WebM/Opus)
- Chrome/Edge recommended for browser speech recognition (`SpeechRecognition`)

## Setup

1. Create and activate virtual environment.

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install backend dependencies.

```bash
pip install -r requirements.txt
```

4. Configure Gemini auth in `.env` (project root). Use one of:

```env
# Option A: Google AI API key
GOOGLE_API_KEY=your_key_here
# (or GEMINI_API_KEY=your_key_here)
GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-12-2025

# Option B: Vertex AI
GOOGLE_CLOUD_PROJECT=your_project_id
GOOGLE_CLOUD_LOCATION=us-central1
```

Note: this project's Live lane uses `run_live` WebSocket mode. Use a Live-capable
model (default is `gemini-2.5-flash-native-audio-preview-12-2025`).

3. Install frontend dependencies.

```bash
cd scene-one-frontend
npm install
cd ..
```

## Run

Start backend:

```bash
source .venv/bin/activate
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Start frontend in another terminal:

```bash
cd scene-one-frontend
npm run dev
```

Optional frontend environment variables:

```bash
# Browser upload target for /upload-ad
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000

# Next.js server-side Copilot proxy target for ADK endpoint
COPILOTKIT_AGENT_URL=http://localhost:8000/copilotkit

# Live lane websocket query params
NEXT_PUBLIC_ADK_LIVE_APP_NAME=scene_one_agent
NEXT_PUBLIC_ADK_LIVE_USER_ID=studio_user_01
NEXT_PUBLIC_ADK_LIVE_MODALITY=AUDIO
```

If you see `HTTP 404 {"detail":"Not Found"}` in browser console for agent execution,
it means Next.js is calling the wrong backend URL/path for ADK.
Set `COPILOTKIT_AGENT_URL` explicitly and restart `npm run dev`.

Canonical CopilotKit request flow:
1. Browser calls `POST /api/copilotkit` on Next.js (`localhost:3000`).
2. Next.js route proxies to `POST /copilotkit` on FastAPI (`localhost:8000`).
3. FastAPI route is registered by `add_adk_fastapi_endpoint(..., path="/copilotkit")`.

Live lane request flow:
1. Browser opens `ws://localhost:8000/run_live?...`.
2. FastAPI `/run_live` forwards to ADK `Runner.run_live(...)`.
3. Native-audio model streams events over the same websocket.

Open `http://localhost:3000`.

## Production Deploy Notes

- `cloudbuild.yaml` currently targets:
  - backend: `https://sceneone-backend-x4wprlh2nq-uc.a.run.app`
  - frontend: `https://sceneone-frontend-x4wprlh2nq-uc.a.run.app`
- The backend deploy step sets:
  - `GOOGLE_GENAI_USE_VERTEXAI=false`
  - `GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-12-2025`
  - `ALLOWED_ORIGINS` and `FRONTEND_PUBLIC_URL` to the frontend public URL
- The deploy pipeline also reapplies `roles/run.invoker` for `allUsers` on the backend service so browser fetches and WebSocket connections continue to work after redeploys.

## FFmpeg Install

Linux (Debian/Ubuntu):

```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
```

macOS (Homebrew):

```bash
brew install ffmpeg
```

Windows (Chocolatey):

```bash
choco install ffmpeg
```

## Tests

Run backend tests:

```bash
source .venv/bin/activate
python3 -m pytest -q
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pytest -q
```

## Reproducible Testing (Hackathon Demo)

Use this checklist to validate the core submission flow end-to-end.

### 1. Start from a clean run

Stop all running backend/frontend processes, then restart both:

```bash
# Terminal 1 (backend)
source .venv/bin/activate
uvicorn server:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 (frontend)
cd scene-one-frontend
npm run dev
```

Windows PowerShell:

```powershell
# Terminal 1 (backend)
.\.venv\Scripts\Activate.ps1
uvicorn server:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 (frontend)
cd scene-one-frontend
npm run dev
```

Expected:
- Backend starts with no route errors.
- Frontend loads at `http://localhost:3000`.

### 2. Verify WAV finalization on session end

1. Start a live session in UI.
2. Trigger a script capture (`capture_ad_script` path).
3. Click **End Live Session** while capture is active.

Expected:
- Button shows `Finishing Clip...`.
- Asset card transitions through status text:
  - `Generating WAV...`
  - `Uploading asset...`
  - `Download .WAV` (ready state)
- A finalization summary toast/log appears:
  - `Finalization summary: ready=<n>, failed=<n>, in-progress=<n>`

Backend log should include:
- `POST /upload-ad`
- `POST /gcs/upload-asset`

### 3. Verify Asset Dock cleanup (delete)

1. In Asset Dock, click **Delete** on any asset and confirm.

Expected:
- Asset disappears from dock.
- Backend log includes:
  - `DELETE /gcs/assets/{asset_id} 200 OK`

### 4. Verify persistence after refresh

1. Refresh browser.
2. Click **Sync Assets**.

Expected:
- Deleted asset does not reappear.
- Remaining assets still show correct states and download links.

### 5. API spot checks (optional but recommended)

```bash
# List current objects
curl 'http://localhost:8000/gcs/list?kind=all&max_results=100'

# Delete by asset id
curl -X DELETE 'http://localhost:8000/gcs/assets/<asset_id>'

# Delete also accepts prefixed/extended forms
curl -X DELETE 'http://localhost:8000/gcs/assets/scripts/<asset_id>.txt'
```

Expected:
- Delete returns JSON with `status: "success"` and `deleted_audio` / `deleted_script` flags.

## Google Cloud Storage CLI (Audio + Scripts)

Use the helper CLI to upload and retrieve `audio/` and `scripts/` objects in a GCS bucket.

1. Authenticate locally:

```bash
gcloud auth application-default login
```

2. Set bucket (optional if using default `sceneone-media-prod`):

```bash
export GCS_BUCKET=sceneone-media-prod
```

3. Run commands:

```bash
# Upload audio
python utils/gcloud_storage.py upload \
  --audio-file exports/audio/sceneone_urban_explorer_25943017.wav \
  --object-name sceneone_urban_explorer_25943017.wav

# Upload script from text
python utils/gcloud_storage.py upload \
  --script-id urban_explorer \
  --script-text "Your script text"

# Upload script from file
python utils/gcloud_storage.py upload \
  --script-id urban_explorer \
  --script-file exports/scripts/script_urban_explorer_20260306_145008.txt

# Fetch script (prints to terminal)
python utils/gcloud_storage.py get-script --script-id urban_explorer

# Fetch script (save to file)
python utils/gcloud_storage.py get-script --script-id urban_explorer --out /tmp/urban_explorer.txt

# Fetch audio
python utils/gcloud_storage.py get-audio \
  --object-name sceneone_urban_explorer_25943017.wav \
  --out /tmp/sceneone_urban_explorer_25943017.wav

# List objects
python utils/gcloud_storage.py list --kind all --max-results 100
```

Notes:
- Audio is stored under `audio/<object-name>`.
- Scripts are stored under `scripts/<script-id>.txt`.
- Legacy entrypoint `python utils/gcloud-storage.py ...` still works.

## FastAPI GCS Endpoints

You can now use backend routes to store/retrieve GCS assets directly:

```bash
# Upload script text
curl -X POST http://localhost:8000/gcs/upload-script \
  -F script_id=urban_explorer \
  -F script_text='Your script text'

# Upload script file
curl -X POST http://localhost:8000/gcs/upload-script \
  -F script_id=urban_explorer \
  -F script_file=@exports/scripts/script_urban_explorer_20260306_145008.txt

# Upload audio
curl -X POST http://localhost:8000/gcs/upload-audio \
  -F file=@exports/audio/sceneone_urban_explorer_25943017.wav

# Fetch script text
curl http://localhost:8000/gcs/scripts/urban_explorer

# Fetch audio
curl -L http://localhost:8000/gcs/audio/sceneone_urban_explorer_25943017.wav \
  -o /tmp/sceneone_urban_explorer_25943017.wav

# List objects
curl 'http://localhost:8000/gcs/list?kind=all&max_results=100'
```

Notes:
- Pass an explicit bucket with `bucket` form/query field if needed; otherwise default is `GCS_BUCKET` env var or `sceneone-media-prod`.
- `GET /gcs/audio/{object_name}` supports nested object names via path segments.
