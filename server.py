import os
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydub import AudioSegment
from pydub.silence import detect_leading_silence
import shutil

app = FastAPI(title="SceneOne Production Hub")

# Enable CORS so React frontend can communicate
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create a directory for exported audio files
EXPORT_DIR = "exports/audio",
os.makedirs(EXPORT_DIR, exist_ok=True)

def trim_and_clean_audio(file_path):
    """
    Trims silence from start/end, normalize volume, and adds micro-fades
    """
    # Load the audio file
    audio = AudioSegment.from_file(file_path)

    # Normalize: Brings the peaks to a consistent level
    audio = audio.normalize()

    # Trim leading silence
    start_trim = detect_leading_silence(audio, silence_threshold=-40)

    # Trim trailing silence
    end_trim = detect_leading_silence(audio.reverse(), silence_threshold=-40)

    duration = len(audio)
    # Slice the audio adding 100ms padding
    trimmed_audio = audio[max(start_trim-100, 0) : (duration - end_trim + 100)]

    # 50ms fades to prevent digital 'clicks'
    final_audio = trimmed_audio.fade_in(50).fade_out(50)

    # return the final cleaned audio
    return final_audio

# Mount the folder so files ace accessible via http://localhost:8000/download/ad.wav
app.mount("/download", StaticFiles(directory=EXPORT_DIR), name="download")

app.post("/upload-ad")
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
