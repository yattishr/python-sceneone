import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydub import AudioSegment
from pydub.silence import detect_leading_silence

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from scene_one_agent.agent import root_agent

import shutil
import uvicorn

adk_agent = ADKAgent(
    adk_agent=root_agent,          # Use 'adk_agent' instead of 'agent'
    app_name="SceneOne_Studio",    # Must match your frontend config later
    user_id="studio_user_01",      # For session tracking
    session_timeout_seconds=3600,
    use_in_memory_services=True
)

app = FastAPI(title="SceneOne AG-UI Backend")
add_adk_fastapi_endpoint(app, adk_agent, path="/copilotkit")

# Create a directory for exported audio files
EXPORT_DIR = "exports/audio"
os.makedirs(EXPORT_DIR, exist_ok=True)

def trim_and_clean_audio(file_path):
    """
    Trims silence from start/end, normalize volume, and adds micro-fades
    """
    # Load the audio file
    audio = AudioSegment.from_file(file_path)

    # Normalize: Brings the peaks to a consistent level
    audio = audio.normalize()

    # Detect leading silence
    # detect_leading_silence returns a list of (start_ms, end_ms) tuples
    # We want the end_ms of the first silence segment to know where the actual audio starts
    leading_silence_segments = detect_leading_silence(audio, silence_thresh=-40, min_silence_len=500)
    start_trim_ms = leading_silence_segments[0][1] if leading_silence_segments else 0

    # Detect trailing silence by reversing the audio and detecting leading silence
    trailing_silence_segments = detect_leading_silence(audio.reverse())
    end_trim_ms = trailing_silence_segments[0][1] if trailing_silence_segments else 0

    duration = len(audio)

    # Apply padding: subtract 100ms from start_trim_ms (but not less than 0)
    # and add 100ms to the end of the audio (effectively reducing the amount trimmed from the end)
    start_index = max(0, start_trim_ms - 100)
    end_index = min(duration, duration - end_trim_ms + 100)

    trimmed_audio = audio[start_index : end_index]

    # 50ms fades to prevent digital 'clicks'
    final_audio = trimmed_audio.fade_in(50).fade_out(50)

    # return the final cleaned audio
    return final_audio

# Mount the folder so files ace accessible via http://localhost:8000/download/ad.wav
app.mount("/download", StaticFiles(directory=EXPORT_DIR), name="download")

@app.post("/upload-ad")
async def upload_ad(file: UploadFile = File(...)):
    temp_path = f"temp_{file.filename}"
    
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # use the refinement tool
    processed_audio = trim_and_clean_audio(temp_path)        

    final_filename = f"sceneone_{file.filename}"
    final_path = os.path.join(EXPORT_DIR, final_filename)
    processed_audio.export(final_path, format="wav")
    os.remove(temp_path)

    return {
        "status": "success",
        "download_url": f"http://localhost:8000/download/{final_filename}"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
