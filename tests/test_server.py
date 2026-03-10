import pytest
from fastapi.testclient import TestClient
from pydub import AudioSegment
from pydub.generators import Sine
import os
import shutil

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
