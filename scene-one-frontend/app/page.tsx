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
const LIVE_APP_NAME = process.env.NEXT_PUBLIC_ADK_LIVE_APP_NAME ?? "scene_one_agent";
const LIVE_USER_ID = process.env.NEXT_PUBLIC_ADK_LIVE_USER_ID ?? "studio_user_01";
const LIVE_RESPONSE_MODALITY = process.env.NEXT_PUBLIC_ADK_LIVE_MODALITY ?? "AUDIO";
const RECORDING_DURATION_MS = 10_000;
const SPEECH_SEND_COOLDOWN_MS = 1200;
const LIVE_INPUT_SAMPLE_RATE = 16000;
const FRAME_STREAM_INTERVAL_MS = 1200;

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isSessionActiveRef = useRef(false);
  const lastSpeechSendAtRef = useRef(0);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextOutputPlayTimeRef = useRef(0);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const lastDirectorTextRef = useRef("");

  const [isCameraActive, setIsCameraActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [visionLogs, setVisionLogs] = useState<string[]>(["[SYSTEM]: Awaiting live camera signal"]);
  const [liveFeedLogs, setLiveFeedLogs] = useState<string[]>([]);
  const [assetCards, setAssetCards] = useState<AssetCard[]>([]);
  const [speechStatus, setSpeechStatus] = useState<"idle" | "active" | "unsupported">("idle");
  const [liveStatus, setLiveStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");

  const pushStatusLog = (message: string) => {
    setVisionLogs((prev) => [message, ...prev].slice(0, 6));
  };

  const pushLiveFeedLog = (message: string) => {
    setLiveFeedLogs((prev) => [message, ...prev].slice(0, 40));
  };

  const getSpeechRecognitionFactory = (): SpeechRecognitionFactory | null => {
    if (typeof window === "undefined") return null;
    const candidate = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    return candidate ?? null;
  };

  const decodeBase64ToUint8Array = (base64: string): Uint8Array => {
    const normalized = base64.replace(/_/g, "/").replace(/-/g, "+");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  };

  const getOutputAudioContext = async (): Promise<AudioContext> => {
    if (!outputAudioContextRef.current) {
      outputAudioContextRef.current = new AudioContext();
      nextOutputPlayTimeRef.current = outputAudioContextRef.current.currentTime;
    }
    if (outputAudioContextRef.current.state === "suspended") {
      await outputAudioContextRef.current.resume();
    }
    return outputAudioContextRef.current;
  };

  const downsampleFloat32 = (
    input: Float32Array,
    inputSampleRate: number,
    outputSampleRate: number
  ): Float32Array => {
    if (outputSampleRate >= inputSampleRate) {
      return input;
    }
    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(input.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
        accum += input[i];
        count += 1;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  };

  const float32ToPcm16 = (samples: Float32Array): Uint8Array => {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buffer);
  };

  const uint8ToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const enqueuePcm16Audio = async (base64Data: string, sampleRate = 24000) => {
    const context = await getOutputAudioContext();
    const bytes = decodeBase64ToUint8Array(base64Data);
    if (bytes.length < 2) {
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const channelData = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      channelData[i] = view.getInt16(i * 2, true) / 32768;
    }

    const audioBuffer = context.createBuffer(1, channelData.length, sampleRate);
    audioBuffer.copyToChannel(channelData, 0);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, nextOutputPlayTimeRef.current);
    source.start(startAt);
    nextOutputPlayTimeRef.current = startAt + audioBuffer.duration;
  };

  const stopMicStreaming = () => {
    if (micProcessorRef.current) {
      micProcessorRef.current.disconnect();
      micProcessorRef.current.onaudioprocess = null;
      micProcessorRef.current = null;
    }
    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }
    if (micAudioContextRef.current) {
      void micAudioContextRef.current.close();
      micAudioContextRef.current = null;
    }
  };

  const startMicStreaming = async (stream: MediaStream) => {
    const context = new AudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }

    const micTrack = stream.getAudioTracks()[0];
    if (!micTrack) {
      return;
    }
    const audioStream = new MediaStream([micTrack]);
    const source = context.createMediaStreamSource(audioStream);
    const processor = context.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (!liveSocketRef.current || liveSocketRef.current.readyState !== WebSocket.OPEN) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleFloat32(input, context.sampleRate, LIVE_INPUT_SAMPLE_RATE);
      const pcmBytes = float32ToPcm16(downsampled);
      if (pcmBytes.length === 0) {
        return;
      }
      sendLivePayload({
        blob: {
          mime_type: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`,
          data: uint8ToBase64(pcmBytes),
        },
      });
    };

    source.connect(processor);
    processor.connect(context.destination);
    micAudioContextRef.current = context;
    micSourceRef.current = source;
    micProcessorRef.current = processor;
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
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    return dataUrl.split(",")[1] ?? null;
  };

  const sendLivePayload = (payload: unknown) => {
    if (!liveSocketRef.current || liveSocketRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    liveSocketRef.current.send(JSON.stringify(payload));
  };

  const startFrameStreaming = () => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
    }
    frameIntervalRef.current = setInterval(() => {
      void sendFrameToDirector();
    }, FRAME_STREAM_INTERVAL_MS);
  };

  const stopFrameStreaming = () => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
  };

  const sendFrameToDirector = async () => {
    const imageBytes = captureCurrentVideoFrame();
    if (!imageBytes) {
      return;
    }
    sendLivePayload({
      blob: {
        mime_type: "image/jpeg",
        data: imageBytes,
      },
    });
  };

  const sendDirectorMessage = async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    sendLivePayload({
      content: {
        role: "user",
        parts: [{ text: trimmed }],
      },
    });
  };

  const getLiveSocketUrl = (sessionId: string) => {
    const wsBase = BACKEND_BASE_URL
      .replace(/^http:\/\//i, "ws://")
      .replace(/^https:\/\//i, "wss://")
      .replace(/\/+$/, "");
    const params = new URLSearchParams({
      app_name: LIVE_APP_NAME,
      user_id: LIVE_USER_ID,
      session_id: sessionId,
      modality: LIVE_RESPONSE_MODALITY,
    });
    return `${wsBase}/run_live?${params.toString()}`;
  };

  const closeLiveSocket = () => {
    if (liveSocketRef.current) {
      liveSocketRef.current.close();
      liveSocketRef.current = null;
    }
    setLiveStatus("disconnected");
  };

  const connectLiveSocket = async () => {
    const sessionId = crypto.randomUUID();
    const wsUrl = getLiveSocketUrl(sessionId);
    setLiveStatus("connecting");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      liveSocketRef.current = socket;

      socket.onopen = () => {
        setLiveStatus("connected");
        pushStatusLog("[SYSTEM]: Live agent channel connected");
        resolve();
      };

      socket.onerror = (event) => {
        console.error("Live socket error", event);
        pushStatusLog("[ERROR]: Live agent connection failed");
        reject(new Error("Live WebSocket connection failed."));
      };

      socket.onclose = () => {
        setLiveStatus("disconnected");
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          const parts = payload?.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              const inlineData = part?.inlineData;
              const mimeType = inlineData?.mimeType || "";
              const audioData = inlineData?.data;
              if (typeof audioData === "string" && mimeType.includes("audio/pcm")) {
                void enqueuePcm16Audio(audioData);
              }
            }
            const textParts = parts
              .map((part: any) => part?.text)
              .filter((value: unknown) => typeof value === "string" && value.trim().length > 0);
            if (textParts.length > 0) {
              const directorText = textParts.join(" ").trim();
              if (directorText && directorText !== lastDirectorTextRef.current) {
                lastDirectorTextRef.current = directorText;
                pushLiveFeedLog(`[DIRECTOR]: ${directorText}`);
              }
            }
          }
        } catch {
          // Ignore non-JSON or non-text live payloads.
        }
      };
    });
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
      pushStatusLog("[WARN]: Browser speech recognition unavailable");
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
      pushLiveFeedLog(`[VOICE]: ${finalTranscript}`);

      try {
        await sendFrameToDirector();
        await sendDirectorMessage(
          `Live session note: camera is active. User said: "${finalTranscript}"`,
        );
      } catch (error) {
        console.error("Failed to send transcript to director", error);
        pushStatusLog("[ERROR]: Could not send speech to director");
      }
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error", event);
      pushStatusLog("[ERROR]: Speech recognition failed");
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
        await videoRef.current.play();
        setIsCameraActive(true);
        pushStatusLog("[SYSTEM]: Camera channel linked");
        pushStatusLog("[SYSTEM]: Voice command channel ready");
        pushStatusLog("[SYSTEM]: Vision agent warmup complete");
      }

      await connectLiveSocket();
      await startMicStreaming(stream);
      startFrameStreaming();
      startSpeechRecognition();
      await sendFrameToDirector();
      await sendDirectorMessage(
        "Live session started. I am showing a product on camera. React as director in real time and ask clarifying questions if needed.",
      );
    } catch (err) {
      console.error("Failed to start production", err);
      pushStatusLog("[ERROR]: Camera permission denied or unavailable");
    }
  }

  function stopProduction() {
    isSessionActiveRef.current = false;
    stopSpeechRecognition();
    stopMicStreaming();
    stopFrameStreaming();
    closeLiveSocket();

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());

      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }

      streamRef.current = null;
      setIsCameraActive(false);
      setElapsedSeconds(0);
      pushStatusLog("[SYSTEM]: Camera feed closed");
    }
  }

  useCopilotReadable({
    description: "The current visual state of the production studio",
    value: isCameraActive
      ? `Camera is LIVE. Speech channel is ${speechStatus}. Live socket is ${liveStatus}.`
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
      pushStatusLog("🎬 [ACTION]: Recording 10s audio clip...");

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
            pushStatusLog(`[SUCCESS]: ${product_name} ad finalized`);
          } catch (error) {
            console.error("Upload failed", error);
            pushStatusLog("[ERROR]: Production Hub upload failed");
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
        pushStatusLog("[ERROR]: Microphone permission denied or unavailable");
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
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="aspect-video w-full rounded-3xl bg-black object-cover"
            />
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
                {visionLogs.map((log, index) => (
                  <p key={`${index}-${log}`} className="log-line">
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
            <h2 className="dock-title text-lg md:text-xl">Live Feed</h2>
            <p className="dock-subtitle">Voice + director transcript stream</p>
          </div>
          <div className="live-feed-scroll">
            {liveFeedLogs.length === 0 ? (
              <div className="asset-card asset-card-empty">
                <p>Live transcript events will appear here once the session starts.</p>
              </div>
            ) : (
              liveFeedLogs.map((log, index) => (
                <p key={`${index}-${log}`} className="live-feed-line">
                  {log}
                </p>
              ))
            )}
          </div>
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
