import os
import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydub import AudioSegment
from pydub.silence import detect_leading_silence
from dotenv import load_dotenv

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from scene_one_agent.agent import root_agent

import uvicorn

# Align env-loading behavior with `adk web .` so direct `server.py` runs
# can resolve Gemini credentials from the project .env file.
load_dotenv()

def _validate_llm_auth_config() -> None:
    has_api_key = bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY"))
    has_vertex_config = bool(os.getenv("GOOGLE_CLOUD_PROJECT") and os.getenv("GOOGLE_CLOUD_LOCATION"))

    if has_api_key or has_vertex_config:
        return

    raise RuntimeError(
        "Missing Gemini auth config. Set GOOGLE_API_KEY (or GEMINI_API_KEY), "
        "or set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION for Vertex."
    )

_validate_llm_auth_config()

adk_agent = ADKAgent(
    adk_agent=root_agent,          # Use 'adk_agent' instead of 'agent'
    app_name="SceneOne_Studio",    # Must match your frontend config later
    user_id="studio_user_01",      # For session tracking
    session_timeout_seconds=3600,
    use_in_memory_services=True
)

app = FastAPI(title="SceneOne AG-UI Backend")
ADK_ENDPOINT_PATH = "/copilotkit"
add_adk_fastapi_endpoint(app, adk_agent, path=ADK_ENDPOINT_PATH)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create a directory for exported audio files
EXPORT_DIR = "exports/audio"
os.makedirs(EXPORT_DIR, exist_ok=True)
TARGET_DURATION_MS = 10_000
SILENCE_THRESHOLD_DBFS = -40
TRIM_PADDING_MS = 100
FADE_MS = 50

def _safe_stem(filename: str) -> str:
    stem = Path(filename).stem or "untitled"
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", stem).strip("_")
    return cleaned or "untitled"

def _enforce_exact_duration(audio: AudioSegment, target_duration_ms: int) -> AudioSegment:
    if len(audio) > target_duration_ms:
        return audio[:target_duration_ms]

    if len(audio) < target_duration_ms:
        missing_ms = target_duration_ms - len(audio)
        silence = (
            AudioSegment.silent(duration=missing_ms, frame_rate=audio.frame_rate)
            .set_channels(audio.channels)
            .set_sample_width(audio.sample_width)
        )
        return audio + silence

    return audio

def trim_and_clean_audio(file_path: str, target_duration_ms: int = TARGET_DURATION_MS) -> AudioSegment:
    """
    Trims silence from start/end, normalizes volume, adds fades, and
    enforces exact duration for final delivery.
    """
    audio = AudioSegment.from_file(file_path)
    if len(audio) == 0:
        raise ValueError("Uploaded audio is empty.")

    audio = audio.normalize()

    leading_trim_ms = detect_leading_silence(
        audio,
        silence_thresh=SILENCE_THRESHOLD_DBFS,
        chunk_size=10,
    )
    trailing_trim_ms = detect_leading_silence(
        audio.reverse(),
        silence_thresh=SILENCE_THRESHOLD_DBFS,
        chunk_size=10,
    )

    start_index = max(0, leading_trim_ms - TRIM_PADDING_MS)
    end_index = min(len(audio), len(audio) - trailing_trim_ms + TRIM_PADDING_MS)
    trimmed = audio[start_index:end_index] if end_index > start_index else audio

    fade_ms = min(FADE_MS, len(trimmed) // 2)
    if fade_ms > 0:
        trimmed = trimmed.fade_in(fade_ms).fade_out(fade_ms)

    return _enforce_exact_duration(trimmed, target_duration_ms)

# Mount the folder so files ace accessible via http://localhost:8000/download/ad.wav
app.mount("/download", StaticFiles(directory=EXPORT_DIR), name="download")

@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "copilotkit_path": ADK_ENDPOINT_PATH,
        "upload_path": "/upload-ad",
    }

@app.post("/upload-ad")
async def upload_ad(request: Request, file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing audio filename.")
    if file.content_type and not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be audio.")

    safe_name = _safe_stem(file.filename)
    temp_suffix = Path(file.filename).suffix or ".bin"
    temp_path = Path(f"temp_{uuid.uuid4().hex}{temp_suffix}")
    final_filename = f"sceneone_{safe_name}_{uuid.uuid4().hex[:8]}.wav"
    final_path = Path(EXPORT_DIR) / final_filename

    try:
        with temp_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        processed_audio = trim_and_clean_audio(str(temp_path))
        processed_audio.export(str(final_path), format="wav")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to process audio: {exc}") from exc
    finally:
        if temp_path.exists():
            temp_path.unlink()
        await file.close()

    return {
        "status": "success",
        "duration_ms": len(processed_audio),
        "download_url": f"{str(request.base_url).rstrip('/')}/download/{final_filename}",
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
