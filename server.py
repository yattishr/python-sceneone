import os
import re
import shutil
import uuid
import asyncio
import logging
import json
import mimetypes
from pathlib import Path
from contextlib import aclosing
from typing import Literal
from datetime import datetime, timezone

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, WebSocket, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
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
from google.genai.errors import APIError

# Align env-loading behavior with `adk web .` so direct `server.py` runs
# can resolve Gemini credentials from the project .env file.
load_dotenv()
logger = logging.getLogger("sceneone.server")


def _normalize_origin(origin: str) -> str:
    cleaned = origin.strip().strip("'\"").rstrip("/")
    return cleaned


def _parse_allowed_origins() -> list[str]:
    raw = os.getenv("ALLOWED_ORIGINS", "").strip()
    origins: list[str] = []

    if raw:
        origins.extend(
            normalized
            for origin in raw.split(",")
            if (normalized := _normalize_origin(origin))
        )

    frontend_public_url = _normalize_origin(os.getenv("FRONTEND_PUBLIC_URL", ""))
    if frontend_public_url:
        origins.append(frontend_public_url)

    if not origins:
        origins.extend(
            [
                "http://localhost:3000",
                "http://127.0.0.1:3000",
            ]
        )

    # Preserve order for logging/debugging while removing duplicates.
    return list(dict.fromkeys(origins))


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}

def _resolve_response_modality(modality: str):
    """
    Prefer enum modality objects when available to avoid pydantic serializer warnings.
    Falls back to the raw string for older SDK variants.
    """
    modality_enum = getattr(types, "Modality", None)
    if modality_enum is None:
        return modality
    try:
        return modality_enum[modality]
    except Exception:
        return modality

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
    allow_origins=_parse_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create a directory for exported audio files
EXPORT_DIR = "exports/audio"
os.makedirs(EXPORT_DIR, exist_ok=True)
SCRIPT_DIR = "exports/scripts"
os.makedirs(SCRIPT_DIR, exist_ok=True)
DEFAULT_TARGET_DURATION_SECONDS = 10
ALLOWED_TARGET_DURATION_SECONDS = {10, 20, 30}
TARGET_DURATION_MS = DEFAULT_TARGET_DURATION_SECONDS * 1000
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

def _validate_duration_seconds(duration_seconds: int) -> int:
    if duration_seconds not in ALLOWED_TARGET_DURATION_SECONDS:
        allowed = ", ".join(str(value) for value in sorted(ALLOWED_TARGET_DURATION_SECONDS))
        raise HTTPException(
            status_code=400,
            detail=f"Invalid duration_seconds={duration_seconds}. Allowed values: {allowed}.",
        )
    return duration_seconds

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
app.mount("/scripts", StaticFiles(directory=SCRIPT_DIR), name="scripts")

def _iso_utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()

def _parse_script_file(path: Path) -> dict:
    content = path.read_text(encoding="utf-8", errors="ignore")
    lines = content.splitlines()
    product_name = "Untitled Product"
    final_script = content.strip()
    duration_seconds = DEFAULT_TARGET_DURATION_SECONDS
    if lines and lines[0].startswith("PRODUCT:"):
        product_name = lines[0].split(":", 1)[1].strip() or product_name
    for line in lines:
        if line.startswith("DURATION_SECONDS:"):
            raw_duration = line.split(":", 1)[1].strip()
            if raw_duration.isdigit():
                parsed_duration = int(raw_duration)
                if parsed_duration in ALLOWED_TARGET_DURATION_SECONDS:
                    duration_seconds = parsed_duration
            break
    marker = "--- SCRIPT ---"
    marker_index = content.find(marker)
    if marker_index >= 0:
        final_script = content[marker_index + len(marker):].strip()
    return {
        "filename": path.name,
        "url": f"/scripts/{path.name}",
        "product_name": product_name,
        "duration_seconds": duration_seconds,
        "final_script": final_script,
        "modified_at": _iso_utc(path.stat().st_mtime),
        "size_bytes": path.stat().st_size,
    }

def _parse_audio_file(path: Path) -> dict:
    return {
        "filename": path.name,
        "url": f"/download/{path.name}",
        "modified_at": _iso_utc(path.stat().st_mtime),
        "size_bytes": path.stat().st_size,
    }

def _build_gcs_store(bucket_name: str | None = None):
    try:
        from utils.gcloud_storage import GCSAssetStore
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                "Google Cloud Storage support is unavailable. "
                "Install dependencies with `pip install -r requirements.txt`."
            ),
        ) from exc
    return GCSAssetStore(bucket_name=bucket_name)

def _is_gcs_not_found(exc: Exception) -> bool:
    return exc.__class__.__name__ == "NotFound"

def _normalize_asset_id(asset_id: str) -> str:
    normalized = asset_id.strip().strip("/")
    if normalized.startswith("scripts/"):
        normalized = normalized[len("scripts/"):]
    elif normalized.startswith("audio/"):
        normalized = normalized[len("audio/"):]
    if normalized.endswith(".txt"):
        normalized = normalized[:-4]
    elif normalized.endswith(".wav"):
        normalized = normalized[:-4]
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "_", normalized).strip("_")
    return normalized

@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "live_app_name": LIVE_APP_NAME,
        "gemini_model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"),
        "google_genai_use_vertexai": os.getenv("GOOGLE_GENAI_USE_VERTEXAI"),
        "copilotkit_path": ADK_ENDPOINT_PATH,
        "live_ws_path": "/run_live",
        "upload_path": "/upload-ad",
        "assets_path": "/assets",
    }

@app.get("/assets")
async def list_assets():
    base_audio = Path(EXPORT_DIR)
    base_scripts = Path(SCRIPT_DIR)

    audio_files = sorted(
        [p for p in base_audio.glob("*.wav") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    script_files = sorted(
        [p for p in base_scripts.glob("*.txt") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )

    return {
        "audio": [_parse_audio_file(path) for path in audio_files],
        "scripts": [_parse_script_file(path) for path in script_files],
    }

@app.post("/gcs/upload-script")
async def gcs_upload_script(
    script_id: str = Form(...),
    script_text: str | None = Form(default=None),
    script_file: UploadFile | None = File(default=None),
    bucket: str | None = Form(default=None),
):
    if bool(script_text) == bool(script_file):
        raise HTTPException(
            status_code=400,
            detail="Provide exactly one of script_text or script_file.",
        )

    store = _build_gcs_store(bucket_name=bucket)
    try:
        if script_text is not None:
            object_name = store.upload_script_text(script_id=script_id, text=script_text)
        else:
            raw = await script_file.read()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise HTTPException(
                    status_code=400,
                    detail="script_file must be UTF-8 text.",
                ) from exc
            object_name = store.upload_script_text(script_id=script_id, text=text)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[gcs-upload-script] failed")
        raise HTTPException(status_code=500, detail=f"Failed to upload script: {exc}") from exc
    finally:
        if script_file:
            await script_file.close()

    return {
        "status": "success",
        "bucket": store.bucket_name,
        "script_id": script_id,
        "object_name": object_name,
    }

@app.post("/gcs/upload-audio")
async def gcs_upload_audio(
    file: UploadFile = File(...),
    object_name: str | None = Form(default=None),
    bucket: str | None = Form(default=None),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing audio filename.")
    if file.content_type and not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be audio.")

    safe_name = _safe_stem(file.filename)
    suffix = Path(file.filename).suffix or ".wav"
    resolved_object_name = object_name or f"{safe_name}_{uuid.uuid4().hex[:8]}{suffix}"

    store = _build_gcs_store(bucket_name=bucket)
    try:
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Uploaded audio is empty.")
        object_path = store.upload_audio_bytes(
            data=data,
            object_name=resolved_object_name,
            content_type=file.content_type or "application/octet-stream",
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[gcs-upload-audio] failed")
        raise HTTPException(status_code=500, detail=f"Failed to upload audio: {exc}") from exc
    finally:
        await file.close()

    return {
        "status": "success",
        "bucket": store.bucket_name,
        "object_name": object_path,
    }

@app.post("/gcs/upload-asset")
async def gcs_upload_asset(
    asset_id: str = Form(...),
    script_text: str = Form(...),
    file: UploadFile = File(...),
    bucket: str | None = Form(default=None),
):
    normalized_asset_id = _normalize_asset_id(asset_id)
    if not normalized_asset_id:
        raise HTTPException(status_code=400, detail="Invalid asset_id.")
    if not script_text.strip():
        raise HTTPException(status_code=400, detail="script_text cannot be empty.")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing audio filename.")
    if file.content_type and not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be audio.")

    store = _build_gcs_store(bucket_name=bucket)
    try:
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Uploaded audio is empty.")
        audio_object_name = store.upload_audio_bytes(
            data=data,
            object_name=f"{normalized_asset_id}.wav",
            content_type=file.content_type or "audio/wav",
        )
        script_object_name = store.upload_script_text(
            script_id=normalized_asset_id,
            text=script_text,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[gcs-upload-asset] failed")
        raise HTTPException(status_code=500, detail=f"Failed to upload asset: {exc}") from exc
    finally:
        await file.close()

    return {
        "status": "success",
        "bucket": store.bucket_name,
        "asset_id": normalized_asset_id,
        "audio_object_name": audio_object_name,
        "script_object_name": script_object_name,
    }

@app.delete("/gcs/assets/{asset_id}")
async def gcs_delete_asset(asset_id: str, bucket: str | None = Query(default=None)):
    normalized_asset_id = _normalize_asset_id(asset_id)
    if not normalized_asset_id:
        raise HTTPException(status_code=400, detail="Invalid asset_id.")

    store = _build_gcs_store(bucket_name=bucket)
    deleted_audio = False
    deleted_script = False
    try:
        try:
            store.delete_audio(f"{normalized_asset_id}.wav")
            deleted_audio = True
        except Exception as exc:
            if not _is_gcs_not_found(exc):
                raise
        try:
            store.delete_script(normalized_asset_id)
            deleted_script = True
        except Exception as exc:
            if not _is_gcs_not_found(exc):
                raise
    except Exception as exc:
        logger.exception("[gcs-delete-asset] failed")
        raise HTTPException(status_code=500, detail=f"Failed to delete asset: {exc}") from exc

    return {
        "status": "success",
        "bucket": store.bucket_name,
        "asset_id": normalized_asset_id,
        "deleted_audio": deleted_audio,
        "deleted_script": deleted_script,
    }

@app.get("/gcs/scripts/{script_id}", response_class=PlainTextResponse)
async def gcs_get_script(script_id: str, bucket: str | None = Query(default=None)):
    store = _build_gcs_store(bucket_name=bucket)
    try:
        return PlainTextResponse(store.download_script_text(script_id=script_id))
    except Exception as exc:
        if _is_gcs_not_found(exc):
            raise HTTPException(status_code=404, detail=f"Script '{script_id}' not found.") from exc
        logger.exception("[gcs-get-script] failed")
        raise HTTPException(status_code=500, detail=f"Failed to fetch script: {exc}") from exc

@app.get("/gcs/audio/{object_name:path}")
async def gcs_get_audio(object_name: str, bucket: str | None = Query(default=None)):
    store = _build_gcs_store(bucket_name=bucket)
    resolved_object_name = object_name.removeprefix("audio/")
    try:
        data = store.download_audio_bytes(object_name=resolved_object_name)
    except Exception as exc:
        if _is_gcs_not_found(exc):
            raise HTTPException(status_code=404, detail=f"Audio '{object_name}' not found.") from exc
        logger.exception("[gcs-get-audio] failed")
        raise HTTPException(status_code=500, detail=f"Failed to fetch audio: {exc}") from exc

    media_type = mimetypes.guess_type(resolved_object_name)[0] or "application/octet-stream"
    return StreamingResponse(
        iter([data]),
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{Path(resolved_object_name).name}"'},
    )

@app.get("/gcs/list")
async def gcs_list_assets(
    kind: Literal["audio", "scripts", "all"] = Query(default="all"),
    prefix: str = Query(default=""),
    max_results: int = Query(default=100, ge=1, le=1000),
    bucket: str | None = Query(default=None),
):
    store = _build_gcs_store(bucket_name=bucket)
    try:
        items = store.list_objects(kind=kind, prefix=prefix, max_results=max_results)
    except Exception as exc:
        logger.exception("[gcs-list] failed")
        raise HTTPException(status_code=500, detail=f"Failed to list assets: {exc}") from exc

    return {
        "bucket": store.bucket_name,
        "kind": kind,
        "prefix": prefix,
        "count": len(items),
        "items": items,
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

    async def _send_error_payload(error_code: str, detail: str):
        try:
            await websocket.send_text(
                json.dumps({"error": error_code, "detail": detail})
            )
        except Exception:
            # Best effort: the socket may already be closed.
            pass

    async def forward_events():
        run_config = RunConfig(
            response_modalities=[_resolve_response_modality(modality)],
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
        try:
            async with aclosing(
                live_runner.run_live(
                    user_id=user_id,
                    session_id=session_id,
                    live_request_queue=live_request_queue,
                    run_config=run_config,
                )
            ) as agen:
                async for event in agen:
                    try:
                        await websocket.send_text(
                            event.model_dump_json(exclude_none=True, by_alias=True)
                        )
                    except WebSocketDisconnect:
                        break
                    except RuntimeError as exc:
                        # Socket closed while model stream still yielded an event.
                        if "websocket.send" in str(exc):
                            logger.info("[run_live] websocket closed before event send")
                            break
                        raise
        except APIError as exc:
            logger.warning(
                "[run_live] upstream APIError status=%s detail=%s",
                getattr(exc, "status_code", "unknown"),
                str(exc),
            )
            await _send_error_payload(
                "UPSTREAM_LIVE_ERROR",
                "Live model connection interrupted. Reconnecting...",
            )
            raise
        except WebSocketDisconnect:
            pass

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
        except WebSocketDisconnect:
            pass

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
    except APIError as exc:
        logger.warning("[run_live] closing websocket after upstream APIError: %s", exc)
        try:
            await websocket.close(code=1011, reason="Upstream live error")
        except Exception:
            pass
    except Exception as exc:
        logger.exception("[run_live] unexpected websocket error")
        try:
            await websocket.close(code=1011, reason=str(exc)[:123])
        except Exception:
            pass
    finally:
        for task in pending:
            task.cancel()

@app.post("/upload-ad")
async def upload_ad(
    request: Request,
    file: UploadFile = File(...),
    duration_seconds: int = Form(default=DEFAULT_TARGET_DURATION_SECONDS),
    asset_id: str | None = Form(default=None),
    script_text: str | None = Form(default=None),
    sync_to_gcs: bool | None = Form(default=None),
    bucket: str | None = Form(default=None),
):
    print(
        f"[upload-ad] received file='{file.filename}' "
        f"content_type='{file.content_type}'"
    )
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing audio filename.")
    if file.content_type and not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be audio.")

    duration_seconds = _validate_duration_seconds(duration_seconds)
    target_duration_ms = duration_seconds * 1000
    safe_name = _safe_stem(file.filename)
    normalized_asset_id = _normalize_asset_id(asset_id or safe_name)
    should_sync_to_gcs = _env_flag("SYNC_UPLOADS_TO_GCS", default=False) if sync_to_gcs is None else sync_to_gcs
    keep_local_exports = _env_flag("PERSIST_LOCAL_EXPORTS", default=True)
    if should_sync_to_gcs and not normalized_asset_id:
        raise HTTPException(status_code=400, detail="asset_id is required when sync_to_gcs is enabled.")
    if script_text is not None and not normalized_asset_id:
        raise HTTPException(status_code=400, detail="asset_id is required when script_text is provided.")

    temp_suffix = Path(file.filename).suffix or ".bin"
    temp_path = Path(f"temp_{uuid.uuid4().hex}{temp_suffix}")
    final_filename = f"sceneone_{safe_name}_{uuid.uuid4().hex[:8]}.wav"
    final_path = Path(EXPORT_DIR) / final_filename
    gcs_audio_object_name: str | None = None
    gcs_script_object_name: str | None = None
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

        processed_audio = trim_and_clean_audio(str(temp_path), target_duration_ms=target_duration_ms)
        processed_audio.export(str(final_path), format="wav")
        if should_sync_to_gcs:
            store = _build_gcs_store(bucket_name=bucket)
            gcs_audio_object_name = store.upload_audio_bytes(
                data=final_path.read_bytes(),
                object_name=f"{normalized_asset_id}.wav",
                content_type="audio/wav",
            )
            if script_text is not None:
                gcs_script_object_name = store.upload_script_text(
                    script_id=normalized_asset_id,
                    text=script_text,
                )
            if not keep_local_exports and final_path.exists():
                final_path.unlink()
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
        "duration_seconds": duration_seconds,
        "storage": "gcs" if gcs_audio_object_name else "local",
        "asset_id": normalized_asset_id,
        "audio_object_name": gcs_audio_object_name,
        "script_object_name": gcs_script_object_name,
        "download_url": (
            f"{str(request.base_url).rstrip('/')}/gcs/audio/{gcs_audio_object_name.removeprefix('audio/')}"
            if gcs_audio_object_name
            else f"{str(request.base_url).rstrip('/')}/download/{final_filename}"
        ),
        "script_url": (
            f"{str(request.base_url).rstrip('/')}/gcs/scripts/{normalized_asset_id}"
            if gcs_script_object_name
            else None
        ),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
