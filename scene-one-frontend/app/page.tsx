"use client"
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { useEffect, useState, useRef } from "react";

type AssetCard = {
  productName: string;
  finalScript: string;
  timestamp: string;
  durationSeconds: number;
  wavUrl: string;
  scriptUrl?: string;
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
type CaptureRequest = {
  product_name?: string;
  final_script?: string;
  duration_seconds?: number;
};
type BackendAudioAsset = {
  filename: string;
  url: string;
  modified_at: string;
  size_bytes: number;
};
type BackendScriptAsset = {
  filename: string;
  url: string;
  product_name: string;
  duration_seconds?: number;
  final_script: string;
  modified_at: string;
  size_bytes: number;
};


const BACKEND_BASE_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const LIVE_APP_NAME = process.env.NEXT_PUBLIC_ADK_LIVE_APP_NAME ?? "scene_one_agent";
const LIVE_USER_ID = process.env.NEXT_PUBLIC_ADK_LIVE_USER_ID ?? "studio_user_01";
const LIVE_RESPONSE_MODALITY = process.env.NEXT_PUBLIC_ADK_LIVE_MODALITY ?? "AUDIO";
const ALLOWED_DURATIONS_SECONDS = [10, 20, 30] as const;
type AllowedDurationSeconds = (typeof ALLOWED_DURATIONS_SECONDS)[number];
const DEFAULT_DURATION_SECONDS: AllowedDurationSeconds = 10;
const SPEECH_SEND_COOLDOWN_MS = 1200;
const LIVE_INPUT_SAMPLE_RATE = 16000;
const FRAME_STREAM_INTERVAL_MS = 1200;
const ASSET_DOCK_STORAGE_KEY = "sceneone.assetDock.v1";
const DIRECTOR_DEFAULT_SAMPLE_RATE = 24000;
const DIRECTOR_AUDIO_CHANNELS = 1;
const PCM16_BYTES_PER_SAMPLE = 2;
const MAX_DIRECTOR_BUFFER_MS = 30_000;
const TTS_WARMUP_MS = 800;
const LIVE_RECONNECT_BASE_DELAY_MS = 1200;
const LIVE_RECONNECT_MAX_ATTEMPTS = 6;
const AUTO_END_AFTER_CAPTURE_MS = 1600;
const durationToMs = (seconds: number): number => seconds * 1000;
const isAllowedDurationSeconds = (value: number): value is AllowedDurationSeconds => (
  ALLOWED_DURATIONS_SECONDS.includes(value as AllowedDurationSeconds)
);

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
  const isCaptureInProgressRef = useRef(false);
  const lastCaptureKeyRef = useRef("");
  const directorPcmChunksRef = useRef<Uint8Array[]>([]);
  const directorPcmBytesRef = useRef(0);
  const directorSampleRateRef = useRef(DIRECTOR_DEFAULT_SAMPLE_RATE);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAfterCaptureRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectInFlightRef = useRef(false);
  const intentionalSocketCloseRef = useRef(false);

  const [isCameraActive, setIsCameraActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [visionLogs, setVisionLogs] = useState<string[]>(["[SYSTEM]: Awaiting live camera signal"]);
  const [liveFeedLogs, setLiveFeedLogs] = useState<string[]>([]);
  const [assetCards, setAssetCards] = useState<AssetCard[]>([]);
  const [toastMessage, setToastMessage] = useState("");
  const [captureProgressLabel, setCaptureProgressLabel] = useState("");
  const [captureProgressPercent, setCaptureProgressPercent] = useState(0);
  const [isStopQueued, setIsStopQueued] = useState(false);
  const [selectedDurationSeconds, setSelectedDurationSeconds] = useState<AllowedDurationSeconds>(DEFAULT_DURATION_SECONDS);
  const [speechStatus, setSpeechStatus] = useState<"idle" | "active" | "unsupported">("idle");
  const [liveStatus, setLiveStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");

  const pushStatusLog = (message: string) => {
    setVisionLogs((prev) => [message, ...prev].slice(0, 6));
  };

  const pushLiveFeedLog = (message: string) => {
    setLiveFeedLogs((prev) => [message, ...prev].slice(0, 40));
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToastMessage("");
      toastTimerRef.current = null;
    }, 3500);
  };

  const updateCaptureProgress = (label: string, percent: number) => {
    setCaptureProgressLabel(label);
    setCaptureProgressPercent(Math.max(0, Math.min(100, percent)));
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
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

  const parsePcmSampleRate = (mimeType: string): number => {
    const match = /rate=(\d+)/i.exec(mimeType);
    if (!match) {
      return DIRECTOR_DEFAULT_SAMPLE_RATE;
    }
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DIRECTOR_DEFAULT_SAMPLE_RATE;
  };

  const appendDirectorPcm = (bytes: Uint8Array, sampleRate: number) => {
    if (bytes.length < 2) {
      return;
    }

    if (directorSampleRateRef.current !== sampleRate) {
      directorPcmChunksRef.current = [];
      directorPcmBytesRef.current = 0;
      directorSampleRateRef.current = sampleRate;
    }

    directorPcmChunksRef.current.push(bytes);
    directorPcmBytesRef.current += bytes.length;

    const maxBytes = Math.floor(
      (sampleRate * PCM16_BYTES_PER_SAMPLE * DIRECTOR_AUDIO_CHANNELS * MAX_DIRECTOR_BUFFER_MS) / 1000
    );
    while (directorPcmBytesRef.current > maxBytes && directorPcmChunksRef.current.length > 1) {
      const dropped = directorPcmChunksRef.current.shift();
      if (dropped) {
        directorPcmBytesRef.current -= dropped.length;
      }
    }
  };

  const getRecentDirectorPcm = (maxBytes: number): Uint8Array => {
    if (maxBytes <= 0 || directorPcmBytesRef.current === 0) {
      return new Uint8Array(0);
    }
    const takeBytes = Math.min(maxBytes, directorPcmBytesRef.current);
    const merged = new Uint8Array(directorPcmBytesRef.current);
    let offset = 0;
    for (const chunk of directorPcmChunksRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged.slice(merged.length - takeBytes);
  };

  const pcm16ToWavBlob = (pcmBytes: Uint8Array, sampleRate: number): Blob => {
    const headerSize = 44;
    const wav = new ArrayBuffer(headerSize + pcmBytes.length);
    const view = new DataView(wav);

    const writeAscii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + pcmBytes.length, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true); // PCM fmt chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, DIRECTOR_AUDIO_CHANNELS, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(
      28,
      sampleRate * DIRECTOR_AUDIO_CHANNELS * PCM16_BYTES_PER_SAMPLE,
      true
    );
    view.setUint16(32, DIRECTOR_AUDIO_CHANNELS * PCM16_BYTES_PER_SAMPLE, true);
    view.setUint16(34, 16, true); // bits per sample
    writeAscii(36, "data");
    view.setUint32(40, pcmBytes.length, true);

    new Uint8Array(wav, headerSize).set(pcmBytes);
    return new Blob([wav], { type: "audio/wav" });
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

  const enqueuePcm16Audio = async (base64Data: string, sampleRate = DIRECTOR_DEFAULT_SAMPLE_RATE) => {
    const context = await getOutputAudioContext();
    const bytes = decodeBase64ToUint8Array(base64Data);
    if (bytes.length < 2) {
      return;
    }
    appendDirectorPcm(bytes, sampleRate);
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

  const toCaptureRequest = (value: unknown): CaptureRequest | null => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const candidate = value as Record<string, unknown>;
    const productName = candidate.product_name;
    const finalScript = candidate.final_script;
    const durationRaw = candidate.duration_seconds;
    const durationValue = typeof durationRaw === "number"
      ? durationRaw
      : typeof durationRaw === "string"
        ? Number(durationRaw)
        : undefined;
    return {
      product_name: typeof productName === "string" ? productName : undefined,
      final_script: typeof finalScript === "string" ? finalScript : undefined,
      duration_seconds: typeof durationValue === "number" && Number.isFinite(durationValue)
        ? durationValue
        : undefined,
    };
  };

  const safeProductKey = (value: string): string => {
    return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "untitled";
  };

  const absoluteBackendUrl = (path: string): string => {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    return `${BACKEND_BASE_URL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  };

  const restoreAssetCardsFromLocalStorage = (): AssetCard[] => {
    if (typeof window === "undefined") {
      return [];
    }
    const raw = window.localStorage.getItem(ASSET_DOCK_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is AssetCard => {
        return Boolean(
          item &&
          typeof item.productName === "string" &&
          typeof item.finalScript === "string" &&
          typeof item.timestamp === "string" &&
          typeof item.durationSeconds === "number" &&
          isAllowedDurationSeconds(item.durationSeconds) &&
          typeof item.wavUrl === "string" &&
          (typeof item.scriptUrl === "undefined" || typeof item.scriptUrl === "string")
        );
      })
      .slice(0, 40);
  };

  const loadAssetsFromBackend = async (): Promise<AssetCard[]> => {
    const response = await fetch(`${BACKEND_BASE_URL}/assets`);
    if (!response.ok) {
      throw new Error(`Failed to fetch assets: ${response.status}`);
    }
    const payload = await response.json() as {
      audio?: BackendAudioAsset[];
      scripts?: BackendScriptAsset[];
    };

    const audioItems = Array.isArray(payload.audio) ? payload.audio : [];
    const scriptItems = Array.isArray(payload.scripts) ? payload.scripts : [];
    const audioMap = new Map<string, BackendAudioAsset[]>();
    for (const audio of audioItems) {
      if (typeof audio.filename !== "string" || typeof audio.url !== "string") {
        continue;
      }
      const match = /^sceneone_(.+)_[a-f0-9]{8}\.wav$/i.exec(audio.filename);
      if (!match) {
        continue;
      }
      const key = match[1];
      const existing = audioMap.get(key) ?? [];
      existing.push(audio);
      audioMap.set(key, existing);
    }

    return scriptItems
      .filter((script) => typeof script.product_name === "string" && typeof script.final_script === "string")
      .map((script) => {
        const key = safeProductKey(script.product_name);
        const audio = (audioMap.get(key) ?? [])[0];
        const durationSeconds = isAllowedDurationSeconds(Number(script.duration_seconds))
          ? Number(script.duration_seconds)
          : DEFAULT_DURATION_SECONDS;
        return {
          productName: script.product_name,
          finalScript: script.final_script,
          timestamp: new Date(script.modified_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          durationSeconds,
          wavUrl: audio ? absoluteBackendUrl(audio.url) : "",
          scriptUrl: typeof script.url === "string" ? absoluteBackendUrl(script.url) : undefined,
        };
      })
      .slice(0, 40);
  };

  const extractCaptureRequestFromPayload = (payload: any): CaptureRequest | null => {
    const parts = payload?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const functionCall = part?.functionCall ?? part?.function_call;
        const fnName = functionCall?.name ?? functionCall?.functionName;
        if (fnName !== "capture_ad_script") {
          continue;
        }
        const argsRaw = functionCall?.args ?? functionCall?.arguments;
        if (typeof argsRaw === "string") {
          try {
            return toCaptureRequest(JSON.parse(argsRaw));
          } catch {
            return null;
          }
        }
        return toCaptureRequest(argsRaw);
      }
    }
    return null;
  };

  const captureAndUploadAudio = async (request: CaptureRequest, source: "copilot" | "live") => {
    if (isCaptureInProgressRef.current) {
      pushStatusLog("[SYSTEM]: Capture already in progress");
      return;
    }

    const productName = (request.product_name || "untitled").trim() || "untitled";
    const finalScript = (request.final_script || lastDirectorTextRef.current || "No script text.").trim();
    const durationSeconds = isAllowedDurationSeconds(Number(request.duration_seconds))
      ? Number(request.duration_seconds)
      : selectedDurationSeconds;
    const recordingDurationMs = durationToMs(durationSeconds);
    const captureKey = `${productName}::${durationSeconds}::${finalScript}`;
    if (captureKey === lastCaptureKeyRef.current) {
      return;
    }

    isCaptureInProgressRef.current = true;
    lastCaptureKeyRef.current = captureKey;
    updateCaptureProgress(`Preparing ${durationSeconds}s clip...`, 10);
    pushStatusLog(`🎬 [ACTION]: Rendering ${durationSeconds}s script voiceover (${source})...`);

    try {
      if (!liveSocketRef.current || liveSocketRef.current.readyState !== WebSocket.OPEN) {
        throw new Error("Live director socket is not connected.");
      }

      directorPcmChunksRef.current = [];
      directorPcmBytesRef.current = 0;
      updateCaptureProgress("Rendering script voiceover...", 30);
      await sendDirectorMessage(
        `Read this ad script verbatim with no intro or outro. Keep pacing aligned to exactly ${durationSeconds} seconds. Output only the script as spoken audio:\n${finalScript}`
      );
      await new Promise((resolve) => setTimeout(resolve, recordingDurationMs + TTS_WARMUP_MS));

      const sampleRate = directorSampleRateRef.current || DIRECTOR_DEFAULT_SAMPLE_RATE;
      updateCaptureProgress("Assembling captured audio...", 60);
      const wantedBytes = Math.floor(
        (sampleRate * PCM16_BYTES_PER_SAMPLE * DIRECTOR_AUDIO_CHANNELS * recordingDurationMs) / 1000
      );
      const recentPcm = getRecentDirectorPcm(wantedBytes);
      if (recentPcm.length < sampleRate * PCM16_BYTES_PER_SAMPLE) {
        throw new Error("No director audio captured yet. Let the director speak, then try again.");
      }

      const wavBlob = pcm16ToWavBlob(recentPcm, sampleRate);
      const safeName = productName.replace(/\s+/g, "_").toLowerCase();
      const formData = new FormData();
      formData.append("file", wavBlob, `${safeName}.wav`);
      formData.append("duration_seconds", String(durationSeconds));
      updateCaptureProgress("Uploading clip for WAV finalization...", 80);

      const response = await fetch(`${BACKEND_BASE_URL}/upload-ad`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        let detail = `Upload failed with status ${response.status}`;
        try {
          const payload = await response.json();
          if (payload?.detail) {
            detail = `${detail}: ${payload.detail}`;
          }
        } catch {
          // non-JSON error response
        }
        throw new Error(detail);
      }

      const data = await response.json();
      if (!data.download_url) {
        throw new Error("Upload succeeded but no download URL returned.");
      }
      updateCaptureProgress("Finalizing clip...", 100);

      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setAssetCards((prev) => [
        {
          productName,
          finalScript,
          timestamp: time,
          durationSeconds,
          wavUrl: data.download_url
        },
        ...prev
      ]);
      pushStatusLog(`[SUCCESS]: ${productName} director audio finalized`);
      showToast(`Sound clip ready: ${productName} (${durationSeconds}s)`);
      if (source === "live" && isSessionActiveRef.current && !stopAfterCaptureRef.current) {
        setIsStopQueued(true);
        pushStatusLog("[SYSTEM]: Clip ready. Ending live session...");
        setTimeout(() => {
          if (isSessionActiveRef.current) {
            stopProduction();
          }
        }, AUTO_END_AFTER_CAPTURE_MS);
      }
    } catch (error) {
      isCaptureInProgressRef.current = false;
      setCaptureProgressLabel("");
      setCaptureProgressPercent(0);
      console.error("Director capture failed", error);
      const message = error instanceof Error ? error.message : "Director audio export failed";
      pushStatusLog(`[ERROR]: ${message}`);
      if (stopAfterCaptureRef.current) {
        stopAfterCaptureRef.current = false;
        setIsStopQueued(false);
        stopProduction();
      }
      return;
    }

    isCaptureInProgressRef.current = false;
    setTimeout(() => {
      setCaptureProgressLabel("");
      setCaptureProgressPercent(0);
    }, 900);
    if (stopAfterCaptureRef.current) {
      stopAfterCaptureRef.current = false;
      setIsStopQueued(false);
      stopProduction();
    }
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

  const closeLiveSocket = (intentional = true) => {
    if (intentional) {
      intentionalSocketCloseRef.current = true;
    }
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    reconnectInFlightRef.current = false;
    if (liveSocketRef.current) {
      liveSocketRef.current.close();
      liveSocketRef.current = null;
    }
    setLiveStatus("disconnected");
  };

  const connectLiveSocket = async (isReconnect = false) => {
    intentionalSocketCloseRef.current = false;
    const sessionId = crypto.randomUUID();
    const wsUrl = getLiveSocketUrl(sessionId);
    setLiveStatus("connecting");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      liveSocketRef.current = socket;

      socket.onopen = () => {
        setLiveStatus("connected");
        if (!isReconnect) {
          pushStatusLog("[SYSTEM]: Live agent channel connected");
        }
        resolve();
      };

      socket.onerror = (event) => {
        console.error("Live socket error", event);
        pushStatusLog("[ERROR]: Live agent connection failed");
        reject(new Error("Live WebSocket connection failed."));
      };

      socket.onclose = (event) => {
        liveSocketRef.current = null;
        setLiveStatus("disconnected");
        if (intentionalSocketCloseRef.current || !isSessionActiveRef.current) {
          return;
        }
        scheduleLiveReconnect(event.reason || `code ${event.code}`);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload?.error) {
            const detail = typeof payload.detail === "string" ? payload.detail : "Live upstream error";
            pushStatusLog(`[WARN]: ${detail}`);
            return;
          }
          const parts = payload?.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              const inlineData = part?.inlineData;
              const mimeType = inlineData?.mimeType || "";
              const audioData = inlineData?.data;
              if (typeof audioData === "string" && mimeType.includes("audio/pcm")) {
                void enqueuePcm16Audio(audioData, parsePcmSampleRate(mimeType));
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
          const captureRequest = extractCaptureRequestFromPayload(payload);
          if (captureRequest) {
            void captureAndUploadAudio(captureRequest, "live");
          }
        } catch {
          // Ignore non-JSON or non-text live payloads.
        }
      };
    });
  };

  const scheduleLiveReconnect = (reason: string) => {
    if (!isSessionActiveRef.current) {
      return;
    }
    if (reconnectInFlightRef.current || reconnectTimerRef.current) {
      return;
    }
    if (reconnectAttemptsRef.current >= LIVE_RECONNECT_MAX_ATTEMPTS) {
      pushStatusLog("[ERROR]: Live agent disconnected. Restart session to continue.");
      showToast("Live connection dropped. Please restart the session.");
      return;
    }

    reconnectAttemptsRef.current += 1;
    const attempt = reconnectAttemptsRef.current;
    const delayMs = Math.min(LIVE_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), 10_000);
    pushStatusLog(
      `[WARN]: Live connection lost (${reason}). Reconnecting in ${Math.ceil(delayMs / 1000)}s (${attempt}/${LIVE_RECONNECT_MAX_ATTEMPTS})...`
    );

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!isSessionActiveRef.current) {
        return;
      }
      reconnectInFlightRef.current = true;
      void (async () => {
        try {
          await connectLiveSocket(true);
          reconnectAttemptsRef.current = 0;
          pushStatusLog("[SYSTEM]: Live agent channel reconnected");
          await sendDirectorMessage(
            `Live session resumed after reconnect. Continue directing from the current camera feed. Target ad length is ${selectedDurationSeconds} seconds.`,
          );
        } catch (error) {
          console.error("Live reconnect failed", error);
          scheduleLiveReconnect("retry failure");
        } finally {
          reconnectInFlightRef.current = false;
        }
      })();
    }, delayMs);
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
      directorPcmChunksRef.current = [];
      directorPcmBytesRef.current = 0;
      directorSampleRateRef.current = DIRECTOR_DEFAULT_SAMPLE_RATE;
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
      reconnectAttemptsRef.current = 0;
      await startMicStreaming(stream);
      startFrameStreaming();
      startSpeechRecognition();
      await sendFrameToDirector();
      await sendDirectorMessage(
        `Live session started. I am showing a product on camera. React as director in real time and ask clarifying questions if needed. Current target ad length is ${selectedDurationSeconds} seconds.`,
      );
    } catch (err) {
      console.error("Failed to start production", err);
      pushStatusLog("[ERROR]: Could not start live session");
    }
  }

  function stopProduction(syncAssets = true) {
    isSessionActiveRef.current = false;
    stopSpeechRecognition();
    stopMicStreaming();
    stopFrameStreaming();
    closeLiveSocket(true);
    directorPcmChunksRef.current = [];
    directorPcmBytesRef.current = 0;
    directorSampleRateRef.current = DIRECTOR_DEFAULT_SAMPLE_RATE;
    setIsStopQueued(false);

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
    if (!syncAssets) {
      return;
    }

    void (async () => {
      try {
        const cards = await loadAssetsFromBackend();
        if (cards.length > 0) {
          setAssetCards(cards);
          return;
        }
      } catch (error) {
        console.error("Failed to sync assets after session end", error);
      }
      try {
        const fallback = restoreAssetCardsFromLocalStorage();
        if (fallback.length > 0) {
          setAssetCards(fallback);
        }
      } catch (error) {
        console.error("Failed to restore local asset fallback after session end", error);
      }
    })();
  }

  const requestStopProduction = () => {
    if (isCaptureInProgressRef.current) {
      stopAfterCaptureRef.current = true;
      setIsStopQueued(true);
      pushStatusLog("[SYSTEM]: Finishing current clip before ending session...");
      return;
    }
    stopProduction();
  };

  useCopilotReadable({
    description: "The current visual state of the production studio",
    value: isCameraActive
      ? `Camera is LIVE. Speech channel is ${speechStatus}. Live socket is ${liveStatus}.`
      : "Camera is OFF"
  });

  //useCoPilotAction: Alerts the UI that a script and audio recording are ready.
  useCopilotAction({
    name: "capture_ad_script",
    description: "Alerts the UI that a script is ready and triggers a duration-based audio capture.",
    parameters: [
      { name: "product_name", type: "string" },
      { name: "final_script", type: "string" },
      { name: "duration_seconds", type: "number" }
    ],
    handler: async ({ product_name, final_script, duration_seconds }) => {
      await captureAndUploadAudio({ product_name, final_script, duration_seconds }, "copilot");
    }
  });

  useEffect(() => {
    let isCancelled = false;

    const loadFromBackend = async () => {
      try {
        const cards = await loadAssetsFromBackend();
        if (cards.length > 0 && !isCancelled) {
          setAssetCards(cards);
          return;
        }
      } catch (error) {
        console.error("Failed to load assets from backend", error);
      }

      try {
        const fallback = restoreAssetCardsFromLocalStorage();
        if (fallback.length > 0 && !isCancelled) {
          setAssetCards(fallback);
        }
      } catch (error) {
        console.error("Failed to restore asset dock", error);
      }
    };

    void loadFromBackend();
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(ASSET_DOCK_STORAGE_KEY, JSON.stringify(assetCards));
    } catch (error) {
      console.error("Failed to persist asset dock", error);
    }
  }, [assetCards]);

  useEffect(() => {
    if (!isCameraActive) {
      return;
    }

    const timer = setInterval(() => setElapsedSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [isCameraActive]);

  useEffect(() => {
    return () => stopProduction(false);
  }, []);

  useEffect(() => {
    return () => {
      clearReconnectTimer();
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  const timerText = new Date(elapsedSeconds * 1000).toISOString().substring(11, 19);
  const personaMode = "HYPE-LINK";
  const latestDirectorLine = liveFeedLogs.find((line) => line.startsWith("[DIRECTOR]:")) ?? "Awaiting director guidance";

  return (
    <main className="studio-shell min-h-screen px-4 py-6 md:px-8 md:py-8">
      {toastMessage ? (
        <div className="toast-stack" role="status" aria-live="polite">
          <div className="studio-toast studio-toast-success">{toastMessage}</div>
        </div>
      ) : null}
      <div className="mx-auto flex w-full max-w-350 flex-col gap-6">
        <header className="studio-sticky-header flex flex-col items-start gap-3">
          {!isCameraActive ? (
            <button onClick={startProduction} className="studio-btn studio-btn-start">
              Start Live Session
            </button>
          ) : (
            <button
              onClick={requestStopProduction}
              className="studio-btn studio-btn-stop"
              disabled={isStopQueued}
            >
              {isStopQueued ? "Finishing Clip..." : "End Live Session"}
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

          <aside className="obsidian-panel director-panel rounded-3xl lg:col-span-5 p-4 md:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="dock-title text-lg md:text-xl">Session Control</h2>
              <span className="dock-subtitle">Live-only mode</span>
            </div>
            <div className="space-y-3">
              <p className="dock-subtitle">Live status: {liveStatus}</p>
              <p className="dock-subtitle">Speech status: {speechStatus}</p>
              <p className="dock-subtitle">Persona: {personaMode}</p>
              {captureProgressLabel ? (
                <div className="capture-progress-wrap">
                  <p className="dock-subtitle">{captureProgressLabel}</p>
                  <div className="capture-progress-track" aria-hidden>
                    <div className="capture-progress-fill" style={{ width: `${captureProgressPercent}%` }} />
                  </div>
                </div>
              ) : null}
              <label className="dock-subtitle" htmlFor="duration-select">
                Target audio length:
              </label>
              <select
                id="duration-select"
                className="studio-btn studio-select w-full"
                value={selectedDurationSeconds}
                onChange={(event) => {
                  const nextValue = Number(event.target.value);
                  if (isAllowedDurationSeconds(nextValue)) {
                    setSelectedDurationSeconds(nextValue);
                  }
                }}
              >
                {ALLOWED_DURATIONS_SECONDS.map((duration) => (
                  <option key={duration} value={duration}>
                    {duration} seconds
                  </option>
                ))}
              </select>
              <p className="dock-subtitle">Latest director line:</p>
              <p className="live-feed-line">{latestDirectorLine}</p>
              <button
                className="studio-btn studio-btn-secondary"
                onClick={async () => {
                  try {
                    const cards = await loadAssetsFromBackend();
                    if (cards.length > 0) {
                      setAssetCards(cards);
                      pushStatusLog("[SYSTEM]: Asset Dock synced from backend");
                      return;
                    }
                  } catch (error) {
                    console.error("Manual asset sync failed", error);
                  }
                  const fallback = restoreAssetCardsFromLocalStorage();
                  if (fallback.length > 0) {
                    setAssetCards(fallback);
                    pushStatusLog("[SYSTEM]: Asset Dock loaded from local cache");
                  }
                }}
              >
                Sync Assets
              </button>
            </div>
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
                  <p className="asset-time">{asset.timestamp} · {asset.durationSeconds}s</p>
                  <div className="mt-4 flex gap-2">
                    {asset.wavUrl ? (
                      <a className="studio-btn studio-btn-primary" href={asset.wavUrl} download>
                        Download .WAV
                      </a>
                    ) : (
                      <button className="studio-btn studio-btn-secondary" disabled>
                        {captureProgressLabel ? "WAV generating..." : "WAV pending"}
                      </button>
                    )}
                    {asset.scriptUrl ? (
                      <a className="studio-btn studio-btn-secondary" href={asset.scriptUrl} download>
                        Download .TXT
                      </a>
                    ) : null}
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
