import os
import re
import shutil
import uuid
import asyncio
import traceback
import logging
from pathlib import Path
from contextlib import aclosing
from typing import Literal

from fastapi import FastAPI, UploadFile, File, HTTPException, Request, WebSocket, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.websockets import WebSocketDisconnect
from pydub import AudioSegment
from pydub.silence import detect_leading_silence
from pydub.exceptions import CouldntDecodeError
from pydub.utils import which
from dotenv import load_dotenv
from pydantic import ValidationError

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from scene_one_agent.agent import root_agent

import uvicorn
from google.adk import Runner
from google.adk.agents import RunConfig
from google.adk.agents.live_request_queue import LiveRequestQueue, LiveRequest
from google.genai import types

# Align env-loading behavior with `adk web .` so direct `server.py` runs
# can resolve Gemini credentials from the project .env file.
load_dotenv()
logger = logging.getLogger("sceneone.server")

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

LIVE_APP_NAME = os.getenv("ADK_LIVE_APP_NAME", "scene_one_agent")
live_runner = Runner(
    app_name=LIVE_APP_NAME,
    agent=root_agent,
    session_service=adk_agent._session_manager._session_service,
    artifact_service=adk_agent._artifact_service,
    memory_service=adk_agent._memory_service,
    credential_service=adk_agent._credential_service,
    auto_create_session=True,
)

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
FFMPEG_BINARY = which("ffmpeg") or which("avconv")

if not FFMPEG_BINARY:
    logger.warning(
        "[startup] ffmpeg not found. Browser uploads in webm/ogg/mp4 will fail. "
        "Install ffmpeg or upload WAV."
    )
else:
    logger.info("[startup] ffmpeg detected at: %s", FFMPEG_BINARY)

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
        silence_threshold=SILENCE_THRESHOLD_DBFS,
        chunk_size=10,
    )
    trailing_trim_ms = detect_leading_silence(
        audio.reverse(),
        silence_threshold=SILENCE_THRESHOLD_DBFS,
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
        "live_app_name": LIVE_APP_NAME,
        "copilotkit_path": ADK_ENDPOINT_PATH,
        "live_ws_path": "/run_live",
        "upload_path": "/upload-ad",
    }

@app.websocket("/run_live")
async def run_live(
    websocket: WebSocket,
    app_name: str = Query(default=LIVE_APP_NAME),
    user_id: str = Query(default="studio_user_01"),
    session_id: str = Query(...),
    modality: Literal["TEXT", "AUDIO"] = Query(default="TEXT"),
    proactive_audio: bool | None = Query(default=None),
    enable_affective_dialog: bool | None = Query(default=None),
    enable_session_resumption: bool | None = Query(default=None),
):
    await websocket.accept()
    live_request_queue = LiveRequestQueue()

    async def forward_events():
        run_config = RunConfig(
            response_modalities=[modality],
            proactivity=(
                types.ProactivityConfig(proactive_audio=proactive_audio)
                if proactive_audio is not None
                else None
            ),
            enable_affective_dialog=enable_affective_dialog,
            session_resumption=(
                types.SessionResumptionConfig(transparent=enable_session_resumption)
                if enable_session_resumption is not None
                else None
            ),
        )
        async with aclosing(
            live_runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            )
        ) as agen:
            async for event in agen:
                await websocket.send_text(
                    event.model_dump_json(exclude_none=True, by_alias=True)
                )

    async def process_messages():
        try:
            while True:
                data = await websocket.receive_text()
                live_request_queue.send(LiveRequest.model_validate_json(data))
        except ValidationError:
            # Invalid client message should not crash the whole server.
            await websocket.send_text(
                '{"error":"Invalid live request payload; expected LiveRequest JSON."}'
            )

    tasks = [
        asyncio.create_task(forward_events()),
        asyncio.create_task(process_messages()),
    ]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    try:
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        traceback.print_exc()
        await websocket.close(code=1011, reason=str(exc)[:123])
    finally:
        for task in pending:
            task.cancel()

@app.post("/upload-ad")
async def upload_ad(request: Request, file: UploadFile = File(...)):
    print(
        f"[upload-ad] received file='{file.filename}' "
        f"content_type='{file.content_type}'"
    )
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing audio filename.")
    if file.content_type and not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be audio.")

    safe_name = _safe_stem(file.filename)
    temp_suffix = Path(file.filename).suffix or ".bin"
    temp_path = Path(f"temp_{uuid.uuid4().hex}{temp_suffix}")
    final_filename = f"sceneone_{safe_name}_{uuid.uuid4().hex[:8]}.wav"
    final_path = Path(EXPORT_DIR) / final_filename
    is_probably_wav = temp_suffix.lower() == ".wav" or (file.content_type or "").lower() in {
        "audio/wav",
        "audio/x-wav",
        "audio/wave",
    }

    if not is_probably_wav and not FFMPEG_BINARY:
        raise HTTPException(
            status_code=500,
            detail=(
                "Server is missing ffmpeg. Install ffmpeg to process browser audio "
                "formats (webm/ogg/mp4), or upload WAV."
            ),
        )

    try:
        with temp_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        temp_size = temp_path.stat().st_size if temp_path.exists() else 0
        logger.info("[upload-ad] temp file written: %s bytes (%s)", temp_size, temp_path)
        if temp_size == 0:
            raise ValueError("Uploaded audio is empty (0 bytes).")

        processed_audio = trim_and_clean_audio(str(temp_path))
        processed_audio.export(str(final_path), format="wav")
    except CouldntDecodeError as exc:
        logger.exception("[upload-ad] could not decode audio file")
        raise HTTPException(
            status_code=500,
            detail=(
                "Could not decode uploaded audio. If you uploaded webm/ogg/mp4, "
                "install ffmpeg on the backend."
            ),
        ) from exc
    except Exception as exc:
        logger.exception("[upload-ad] failed while processing audio")
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
