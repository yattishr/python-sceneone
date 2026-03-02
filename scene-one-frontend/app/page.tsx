"use client"
import { CopilotChat } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotChat, useCopilotReadable } from "@copilotkit/react-core";
import { useEffect, useState, useRef } from "react";
import { ImageMessage, MessageRole, TextMessage } from "@copilotkit/runtime-client-gql";

type AssetCard = {
  productName: string;
  finalScript: string;
  timestamp: string;
  wavUrl: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionFactory = new () => BrowserSpeechRecognition;

const BACKEND_BASE_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const RECORDING_DURATION_MS = 10_000;
const SPEECH_SEND_COOLDOWN_MS = 1200;

function pickRecorderMimeType(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

export default function Page() {
  const { appendMessage, isLoading } = useCopilotChat();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isSessionActiveRef = useRef(false);
  const lastSpeechSendAtRef = useRef(0);

  const [isCameraActive, setIsCameraActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [visionLogs, setVisionLogs] = useState<string[]>(["[SYSTEM]: Awaiting live camera signal"]);
  const [assetCards, setAssetCards] = useState<AssetCard[]>([]);
  const [speechStatus, setSpeechStatus] = useState<"idle" | "active" | "unsupported">("idle");

  const getSpeechRecognitionFactory = (): SpeechRecognitionFactory | null => {
    if (typeof window === "undefined") return null;
    const candidate = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    return candidate ?? null;
  };

  const captureCurrentVideoFrame = (): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    const canvas = document.createElement("canvas");
    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.split(",")[1] ?? null;
  };

  const sendFrameToDirector = async () => {
    const imageBytes = captureCurrentVideoFrame();
    if (!imageBytes) {
      return;
    }

    await appendMessage(
      new ImageMessage({
        role: MessageRole.User,
        format: "png",
        bytes: imageBytes,
      }),
    );
  };

  const sendDirectorMessage = async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    await appendMessage(
      new TextMessage({
        role: MessageRole.User,
        content: trimmed,
      }),
    );
  };

  const stopSpeechRecognition = () => {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.onend = null;
      speechRecognitionRef.current.stop();
      speechRecognitionRef.current = null;
    }
    setSpeechStatus("idle");
  };

  const startSpeechRecognition = () => {
    const SpeechRecognitionCtor = getSpeechRecognitionFactory();
    if (!SpeechRecognitionCtor) {
      setSpeechStatus("unsupported");
      setVisionLogs((prev) => ["[WARN]: Browser speech recognition unavailable", ...prev].slice(0, 6));
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = async (event) => {
      const now = Date.now();
      if (now - lastSpeechSendAtRef.current < SPEECH_SEND_COOLDOWN_MS) {
        return;
      }

      const finalTranscript = Array.from(event.results ?? [])
        .slice(event.resultIndex ?? 0)
        .filter((result: any) => Boolean(result?.isFinal))
        .map((result: any) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();

      if (!finalTranscript) {
        return;
      }

      lastSpeechSendAtRef.current = now;
      setVisionLogs((prev) => [`[VOICE]: ${finalTranscript}`, ...prev].slice(0, 6));

      try {
        await sendFrameToDirector();
        await sendDirectorMessage(
          `Live session note: camera is active. User said: "${finalTranscript}"`,
        );
      } catch (error) {
        console.error("Failed to send transcript to director", error);
        setVisionLogs((prev) => ["[ERROR]: Could not send speech to director", ...prev].slice(0, 6));
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error", event);
      setVisionLogs((prev) => ["[ERROR]: Speech recognition failed", ...prev].slice(0, 6));
    };

    recognition.onend = () => {
      if (isSessionActiveRef.current) {
        recognition.start();
      }
    };

    recognition.start();
    speechRecognitionRef.current = recognition;
    setSpeechStatus("active");
  };

  async function startProduction() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      isSessionActiveRef.current = true;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraActive(true);
        setVisionLogs((prev) => [
          "[SYSTEM]: Camera channel linked",
          "[SYSTEM]: Voice command channel ready",
          "[SYSTEM]: Vision agent warmup complete",
          ...prev
        ].slice(0, 6));
      }

      startSpeechRecognition();
      await sendFrameToDirector();
      await sendDirectorMessage(
        "Live session started. I am showing a product on camera. React as director in real time and ask clarifying questions if needed.",
      );
    } catch (err) {
      console.error("Failed to start production", err);
      setVisionLogs((prev) => ["[ERROR]: Camera permission denied or unavailable", ...prev].slice(0, 6));
    }
  }

  function stopProduction() {
    isSessionActiveRef.current = false;
    stopSpeechRecognition();

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
    value: isCameraActive
      ? `Camera is LIVE. Speech channel is ${speechStatus}. ${isLoading ? "Director is responding." : "Director is idle."}`
      : "Camera is OFF"
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

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = pickRecorderMimeType();
        const mediaRecorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        const audioChunks: Blob[] = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunks.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          const recorderMimeType = mediaRecorder.mimeType || mimeType || "audio/webm";
          const extension = extensionFromMimeType(recorderMimeType);
          const audioBlob = new Blob(audioChunks, { type: recorderMimeType });
          const safeName = (product_name ?? "untitled").replace(/\s+/g, "_").toLowerCase();

          const formData = new FormData();
          formData.append("file", audioBlob, `${safeName}.${extension}`);

          try {
            const response = await fetch(`${BACKEND_BASE_URL}/upload-ad`, {
              method: "POST",
              body: formData,
            });
            if (!response.ok) {
              throw new Error(`Upload failed with status ${response.status}`);
            }

            const data = await response.json();
            if (!data.download_url) {
              throw new Error("Upload succeeded but no download URL returned.");
            }

            const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            setAssetCards((prev) => [
              {
                productName: product_name ?? "Untitled Product",
                finalScript: final_script ?? "No script text.",
                timestamp: time,
                wavUrl: data.download_url
              },
              ...prev
            ]);
            setVisionLogs((prev) => [`[SUCCESS]: ${product_name} ad finalized`, ...prev].slice(0, 6));
          } catch (error) {
            console.error("Upload failed", error);
            setVisionLogs((prev) => ["[ERROR]: Production Hub upload failed", ...prev].slice(0, 6));
          } finally {
            stream.getTracks().forEach((t) => t.stop());
          }
        };

        mediaRecorder.start();
        setTimeout(() => {
          if (mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
          }
        }, RECORDING_DURATION_MS);
      } catch (error) {
        console.error("Recording setup failed", error);
        setVisionLogs((prev) => ["[ERROR]: Microphone permission denied or unavailable", ...prev].slice(0, 6));
      }
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
