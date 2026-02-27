import pytest
from fastapi.testclient import TestClient
from pydub import AudioSegment
import os
import shutil

# Import the FastAPI app and the function to be tested
from server import app, trim_and_clean_audio, EXPORT_DIR

# Create a test client for the FastAPI app
client = TestClient(app)

# Define a path for a dummy audio file
DUMMY_AUDIO_PATH = "tests/dummy_audio.wav"

@pytest.fixture(scope="module", autouse=True)
def setup_and_teardown_dummy_audio():
    """
    Fixture to create a dummy audio file before tests and clean up afterwards.
    """
    # Create a 1-second silent WAV file for testing
    silent_audio = AudioSegment.silent(duration=1000)
    silent_audio.export(DUMMY_AUDIO_PATH, format="wav")
    yield
    # Clean up the dummy audio file
    if os.path.exists(DUMMY_AUDIO_PATH):
        os.remove(DUMMY_AUDIO_PATH)
    # Clean up any exported files
    if os.path.exists(EXPORT_DIR):
        shutil.rmtree(EXPORT_DIR)
    os.makedirs(EXPORT_DIR, exist_ok=True)


def test_trim_and_clean_audio():
    """
    Test the trim_and_clean_audio function.
    """
    # Ensure the dummy audio file exists
    assert os.path.exists(DUMMY_AUDIO_PATH)

    # Process the dummy audio file
    processed_audio = trim_and_clean_audio(DUMMY_AUDIO_PATH)

    # Assert that the output is an AudioSegment
    assert isinstance(processed_audio, AudioSegment)

    # Assert that the processed audio has a reasonable length (e.g., not empty)
    # A 1-second silent audio should still have some length after processing
    assert len(processed_audio) > 0

def test_upload_ad_endpoint():
    """
    Test the /upload-ad endpoint.
    """
    # Ensure the dummy audio file exists
    assert os.path.exists(DUMMY_AUDIO_PATH)

    with open(DUMMY_AUDIO_PATH, "rb") as f:
        response = client.post(
            "/upload-ad",
            files={"file": ("dummy_audio.wav", f, "audio/wav")}
        )

    assert response.status_code == 200
    response_json = response.json()
    assert response_json["status"] == "success"
    assert "download_url" in response_json

    # Verify that the exported file exists
    filename = "sceneone_dummy_audio.wav"
    exported_file_path = os.path.join(EXPORT_DIR, filename)
    assert os.path.exists(exported_file_path)

    # Clean up the exported file
    if os.path.exists(exported_file_path):
        os.remove(exported_file_path)
