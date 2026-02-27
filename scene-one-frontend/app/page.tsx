"use client"
import { CopilotSidebar, CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { useEffect, useState, useRef } from "react";

export default function Page() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null); // Store the stream here
  const [ lastDownloadUrl, setLastDownLoadUrl ] = useState<string | null>(null);
  const [downloadLink, setDownloadLink] = useState<string | null>(null);
  const [ isCameraActive, setIsCameraActive ] = useState(false);

// START CAMERA
  async function startProduction() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraActive(true);
      }
    } catch (err) {
      console.error("Failed to start production", err);
    }
  }  

// STOP CAMERA (The Kill Switch)
  function stopProduction() {
    if (streamRef.current) {
      // 1. Stop all audio and video tracks
      streamRef.current.getTracks().forEach(track => track.stop());
      
      // 2. Clear the video element
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      
      streamRef.current = null;
      setIsCameraActive(false);
    }
  }  

  // PIPE to Agent
  // This makes the 'live state of SceneOne Studio readeable to the Director'
  useCopilotReadable({
    description: "The current visual state of the production studio",
    value: isCameraActive ? "Camera is LIVE. Viewing product silhouette" : "Camera is OFF"
  })

useCopilotAction({
  name: "capture_ad_script",
  description: "Alerts the UI that a script and audio recording are ready.",
  parameters: [
    { name: "product_name", type: "string" },
    { name: "final_script", type: "string" }
  ],
  handler: async ({ product_name }) => {
    // We assume the filename follows our backend pattern
    const filename = `sceneone_script_${(product_name ?? "").replace(/\s+/g, "_").toLowerCase()}.txt`;
    setDownloadLink(`http://localhost:8000/download/${filename}`);
    alert(`🎬 SceneOne: ${product_name} Ad is in the can!`);
  },
});

// Cleanup on unmount (If the user closes the tab)
  useEffect(() => {
    return () => stopProduction();
  }, []);

  return (
    <main className="flex flex-col items-center p-8">
      <div className="flex gap-4 mb-6">
        {!isCameraActive ? (
          <button onClick={startProduction} className="px-6 py-2 bg-green-600 text-white rounded-lg font-bold">
            Start Live Session
          </button>
        ) : (
          <button onClick={stopProduction} className="px-6 py-2 bg-red-600 text-white rounded-lg font-bold">
            End Live Session
          </button>
        )}
      </div>


      <h1 className="text-4xl font-bold mb-4">SceneOne Production Studio</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full max-w-6xl">

        {/* LEFT SIDE: The camera & Preview */}
        <div className="relative group">
          <div className="absolute -top-3 -left-3 bg-red-600 text-white px-3 py-1 rounded-full text-xs font-bold animate-pulse z-10s">
              LIVE FEED
          </div>
          <video 
            ref={videoRef}
            autoPlay
            muted
            className="w-full rounded-2xl shadow-2xl border-4 border-white bg-black aspect-video object-cover"
          />
          <div className="mt-4 flex gap-2">
             <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-md text-sm font-medium">1080p Stream</span>
             <span className="px-3 py-1 bg-green-100 text-green-700 rounded-md text-sm font-medium">Gemini 2.5 Vision Active</span>
          </div>
        </div>

        {/* RIGHT SIDE: The Directors Console */}
        <div className="h-150 border rounded-xl overflow-hidden shadow-lg">
          <CopilotChat 
            instructions={"You are the SceneOneDirector. Analyse the video feed to help the user create an ad."}
            labels={{
              title: "Directors Console",
              placeholder: "Show a product and say 'Action'..."
            }}
          />
        </div>
      </div>

      {/* DOWNLOAD SECTION */}
      {lastDownloadUrl && (
        <div className="mt-8 p-4 bg-green-100 border border-green-500 rounded-lg">
          <p className="text-green-800 font-bold">🎬 Ad Production Complete!</p>
          <a href={lastDownloadUrl} download className="underline">Download .WAV Export</a>
        </div>
      )}

        
    </main>
  )
}