"use client"
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { useEffect, useState, useRef } from "react";

type AssetCard = {
  productName: string;
  finalScript: string;
  timestamp: string;
  wavUrl: string;
};

export default function Page() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [visionLogs, setVisionLogs] = useState<string[]>(["[SYSTEM]: Awaiting live camera signal"]);
  const [assetCards, setAssetCards] = useState<AssetCard[]>([]);

  async function startProduction() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraActive(true);
        setVisionLogs((prev) => [
          "[SYSTEM]: Camera channel linked",
          "[SYSTEM]: Vision agent warmup complete",
          ...prev
        ].slice(0, 6));
      }
    } catch (err) {
      console.error("Failed to start production", err);
      setVisionLogs((prev) => ["[ERROR]: Camera permission denied or unavailable", ...prev].slice(0, 6));
    }
  }

  function stopProduction() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());

      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }

      streamRef.current = null;
      setIsCameraActive(false);
      setElapsedSeconds(0);
      setVisionLogs((prev) => ["[SYSTEM]: Camera feed closed", ...prev].slice(0, 6));
    }
  }

  useCopilotReadable({
    description: "The current visual state of the production studio",
    value: isCameraActive ? "Camera is LIVE. Viewing product silhouette" : "Camera is OFF"
  });

  //useCoPilotAction: Alerts the UI that a script and audio recording are ready.
  useCopilotAction({
    name: "capture_ad_script",
    description: "Alerts the UI that a script is ready and triggers a 10-second audio capture.",
    parameters: [
      { name: "product_name", type: "string" },
      { name: "final_script", type: "string" }
    ],
    handler: async ({ product_name, final_script }) => {
      setVisionLogs((prev) => ["🎬 [ACTION]: Recording 10s audio clip...", ...prev].slice(0, 6));

      // 1. SETUP RECORDING
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      const audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => audioChunks.push(event.data);

      // 2. DEFINE WHAT HAPPENS WHEN RECORDING STOPS
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
        const safeName = (product_name ?? "untitled").replace(/\s+/g, "_").toLowerCase();
        
        // Prepare the payload for server.py
        const formData = new FormData();
        formData.append("file", audioBlob, `${safeName}.wav`);

        try {
          // 3. SHIP TO FASTAPI to upload the audio file
          const response = await fetch("http://localhost:8000/upload-ad", {
            method: "POST",
            body: formData,
          });
          const data = await response.json();

          // 4. UPDATE UI WITH REAL DOWNLOAD URL
          const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          setAssetCards((prev) => [
            {
              productName: product_name ?? "Untitled Product",
              finalScript: final_script ?? "No script text.",
              timestamp: time,
              wavUrl: data.download_url // This comes back from your server's 'exports/audio'
            },
            ...prev
          ]);
          setVisionLogs((prev) => [`[SUCCESS]: ${product_name} ad finalized`, ...prev].slice(0, 6));
        } catch (error) {
          console.error("Upload failed", error);
          setVisionLogs((prev) => ["[ERROR]: Production Hub upload failed", ...prev].slice(0, 6));
        }
      };

      // 4. START THE 10-SECOND SESSION
      mediaRecorder.start();
      setTimeout(() => {
        mediaRecorder.stop();
        stream.getTracks().forEach(t => t.stop()); // Turn off mic
      }, 10000);
    }
  });

  useEffect(() => {
    if (!isCameraActive) {
      return;
    }

    const timer = setInterval(() => setElapsedSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [isCameraActive]);

  useEffect(() => {
    return () => stopProduction();
  }, []);

  const timerText = new Date(elapsedSeconds * 1000).toISOString().substring(11, 19);
  const personaMode = "HYPE-LINK";

  return (
    <main className="studio-shell min-h-screen px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto flex w-full max-w-350 flex-col gap-6">
        <header className="studio-sticky-header flex flex-col items-start gap-3">
          {!isCameraActive ? (
            <button onClick={startProduction} className="studio-btn studio-btn-start">
              Start Live Session
            </button>
          ) : (
            <button onClick={stopProduction} className="studio-btn studio-btn-stop">
              End Live Session
            </button>
          )}
          <h1 className="studio-title text-3xl md:text-4xl">SceneOne Studio</h1>
        </header>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <article className="obsidian-panel relative overflow-hidden rounded-3xl lg:col-span-7">
            <video ref={videoRef} autoPlay muted className="aspect-video w-full rounded-3xl bg-black object-cover" />
            <div className="hud-overlay">
              <div className="hud-top-row">
                <div className="hud-chip hud-rec">
                  <span className={`hud-dot ${isCameraActive ? "animate-pulse" : ""}`} />
                  REC {timerText}
                </div>
                <div className="hud-chip hud-persona">MODE: {personaMode}</div>
              </div>
              <div className={`scan-line ${isCameraActive ? "scan-line-active" : ""}`} />
              <div className="hud-logs">
                {visionLogs.map((log) => (
                  <p key={log} className="log-line">
                    {log}
                  </p>
                ))}
              </div>
            </div>
          </article>

          <aside className="obsidian-panel director-panel rounded-3xl lg:col-span-5">
            <CopilotChat
              instructions={"You are the SceneOneDirector. Analyse the video feed to help the user create an ad."}
              labels={{
                title: "Director's Monitor",
                placeholder: "Wait, do you like the lighting?"
              }}
            />
          </aside>
        </section>

        <section className="obsidian-panel rounded-3xl p-4 md:p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="dock-title text-lg md:text-xl">Asset Dock</h2>
            <p className="dock-subtitle">Recent outputs from this session</p>
          </div>
          <div className="asset-scroll">
            {assetCards.length === 0 ? (
              <div className="asset-card asset-card-empty">
                <p>Assets appear here after the director captures a script.</p>
              </div>
            ) : (
              assetCards.map((asset) => (
                <div key={`${asset.productName}-${asset.timestamp}`} className="asset-card">
                  <p className="asset-name">{asset.productName}</p>
                  <p className="asset-time">{asset.timestamp}</p>
                  <div className="mt-4 flex gap-2">
                    <a className="studio-btn studio-btn-primary" href={asset.wavUrl} download>
                      Download .WAV
                    </a>
                    <button
                      className="studio-btn studio-btn-secondary"
                      onClick={async () => navigator.clipboard.writeText(asset.finalScript)}
                    >
                      Copy Script
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
