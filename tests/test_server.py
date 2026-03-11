import pytest
from fastapi.testclient import TestClient
from pydub import AudioSegment
from pydub.generators import Sine
import os
import shutil
from typing import Any

# Import the FastAPI app and the function to be tested
from server import (
    ALLOWED_TARGET_DURATION_SECONDS,
    DEFAULT_TARGET_DURATION_SECONDS,
    EXPORT_DIR,
    app,
    trim_and_clean_audio,
)

# Create a test client for the FastAPI app
client = TestClient(app)

SHORT_AUDIO_PATH = "tests/dummy_short_audio.wav"
LONG_AUDIO_PATH = "tests/dummy_long_audio.wav"


class FakeGCSStore:
    def __init__(self):
        self.bucket_name = "fake-bucket"
        self.audio: dict[str, bytes] = {}
        self.scripts: dict[str, str] = {}

    def upload_audio_bytes(self, data: bytes, object_name: str, content_type: str | None = None) -> str:
        self.audio[f"audio/{object_name}"] = data
        return f"audio/{object_name}"

    def upload_script_text(self, script_id: str, text: str) -> str:
        self.scripts[f"scripts/{script_id}.txt"] = text
        return f"scripts/{script_id}.txt"

    def download_script_text(self, script_id: str) -> str:
        key = f"scripts/{script_id}.txt"
        if key not in self.scripts:
            raise KeyError("NotFound")
        return self.scripts[key]

    def download_audio_bytes(self, object_name: str) -> bytes:
        key = f"audio/{object_name}"
        if key not in self.audio:
            raise KeyError("NotFound")
        return self.audio[key]

    def list_objects(self, kind: str = "all", prefix: str = "", max_results: int = 100) -> list[str]:
        items = []
        if kind in {"audio", "all"}:
            items.extend(sorted(self.audio.keys()))
        if kind in {"scripts", "all"}:
            items.extend(sorted(self.scripts.keys()))
        if prefix:
            items = [item for item in items if item.startswith(prefix)]
        return items[:max_results]


@pytest.fixture
def fake_gcs(monkeypatch: Any):
    store = FakeGCSStore()

    def _fake_builder(bucket_name: str | None = None):
        if bucket_name:
            store.bucket_name = bucket_name
        return store

    monkeypatch.setattr("server._build_gcs_store", _fake_builder)
    monkeypatch.setattr("server._is_gcs_not_found", lambda exc: isinstance(exc, KeyError))
    return store

@pytest.fixture(scope="module", autouse=True)
def setup_and_teardown_dummy_audio_files():
    """
    Create representative short and long audio samples for duration handling tests.
    """
    short_audio = (
        AudioSegment.silent(duration=400)
        + Sine(440).to_audio_segment(duration=2200).apply_gain(-8)
        + AudioSegment.silent(duration=600)
    )
    long_audio = (
        AudioSegment.silent(duration=200)
        + Sine(330).to_audio_segment(duration=13_500).apply_gain(-10)
        + AudioSegment.silent(duration=300)
    )

    short_audio.export(SHORT_AUDIO_PATH, format="wav")
    long_audio.export(LONG_AUDIO_PATH, format="wav")
    yield
    if os.path.exists(SHORT_AUDIO_PATH):
        os.remove(SHORT_AUDIO_PATH)
    if os.path.exists(LONG_AUDIO_PATH):
        os.remove(LONG_AUDIO_PATH)
    if os.path.exists(EXPORT_DIR):
        shutil.rmtree(EXPORT_DIR)
    os.makedirs(EXPORT_DIR, exist_ok=True)


def test_trim_and_clean_audio_extends_short_audio_to_ten_seconds():
    """
    Short recordings should be padded to exactly TARGET_DURATION_MS.
    """
    assert os.path.exists(SHORT_AUDIO_PATH)
    processed_audio = trim_and_clean_audio(SHORT_AUDIO_PATH)
    assert isinstance(processed_audio, AudioSegment)
    assert len(processed_audio) == DEFAULT_TARGET_DURATION_SECONDS * 1000

def test_trim_and_clean_audio_cuts_long_audio_to_ten_seconds():
    """
    Long recordings should be cut to exactly TARGET_DURATION_MS.
    """
    assert os.path.exists(LONG_AUDIO_PATH)
    processed_audio = trim_and_clean_audio(LONG_AUDIO_PATH)
    assert isinstance(processed_audio, AudioSegment)
    assert len(processed_audio) == DEFAULT_TARGET_DURATION_SECONDS * 1000

def test_upload_ad_endpoint_returns_exact_requested_wav_duration():
    """
    Upload endpoint should return a downloadable WAV file at exact requested duration.
    """
    assert os.path.exists(SHORT_AUDIO_PATH)
    duration_seconds = 20

    with open(SHORT_AUDIO_PATH, "rb") as f:
        response = client.post(
            "/upload-ad",
            files={"file": ("dummy_short_audio.wav", f, "audio/wav")},
            data={"duration_seconds": str(duration_seconds)},
        )

    assert response.status_code == 200
    response_json = response.json()
    assert response_json["status"] == "success"
    assert response_json["duration_seconds"] == duration_seconds
    assert response_json["duration_ms"] == duration_seconds * 1000
    assert "download_url" in response_json

    filename = response_json["download_url"].rsplit("/", 1)[-1]
    exported_file_path = os.path.join(EXPORT_DIR, filename)
    assert os.path.exists(exported_file_path)
    exported_audio = AudioSegment.from_wav(exported_file_path)
    assert len(exported_audio) == duration_seconds * 1000

    if os.path.exists(exported_file_path):
        os.remove(exported_file_path)

def test_upload_ad_endpoint_rejects_invalid_duration():
    """
    Upload endpoint should reject durations outside the allowed set.
    """
    assert os.path.exists(SHORT_AUDIO_PATH)
    invalid_duration = max(ALLOWED_TARGET_DURATION_SECONDS) + 5

    with open(SHORT_AUDIO_PATH, "rb") as f:
        response = client.post(
            "/upload-ad",
            files={"file": ("dummy_short_audio.wav", f, "audio/wav")},
            data={"duration_seconds": str(invalid_duration)},
        )

    assert response.status_code == 400
    response_json = response.json()
    assert "Invalid duration_seconds" in response_json["detail"]


def test_gcs_upload_and_get_script_text(fake_gcs: FakeGCSStore):
    response = client.post(
        "/gcs/upload-script",
        data={"script_id": "intro", "script_text": "Hello SceneOne"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["object_name"] == "scripts/intro.txt"

    get_response = client.get("/gcs/scripts/intro")
    assert get_response.status_code == 200
    assert get_response.text == "Hello SceneOne"


def test_gcs_upload_audio_and_get_audio(fake_gcs: FakeGCSStore):
    data = b"FAKEAUDIOBYTES"
    response = client.post(
        "/gcs/upload-audio",
        files={"file": ("clip.wav", data, "audio/wav")},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["object_name"].startswith("audio/")

    object_name = payload["object_name"].split("/", 1)[1]
    get_response = client.get(f"/gcs/audio/{object_name}")
    assert get_response.status_code == 200
    assert get_response.content == data
    assert get_response.headers["content-type"].startswith("audio/")


def test_gcs_get_audio_accepts_prefixed_object_name(fake_gcs: FakeGCSStore):
    fake_gcs.upload_audio_bytes(b"data", "nested/clip.wav")

    response = client.get("/gcs/audio/audio/nested/clip.wav")
    assert response.status_code == 200
    assert response.content == b"data"


def test_gcs_list_assets_filters_by_kind(fake_gcs: FakeGCSStore):
    fake_gcs.upload_audio_bytes(b"a", "one.wav")
    fake_gcs.upload_script_text("script1", "text")

    response = client.get("/gcs/list", params={"kind": "audio"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["kind"] == "audio"
    assert payload["count"] == 1
    assert payload["items"] == ["audio/one.wav"]
