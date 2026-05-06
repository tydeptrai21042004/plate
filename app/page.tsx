"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlateDetection } from "../lib/plate-utils";
import { chooseBestPlateText, cleanPlateText, compactPlateText } from "../lib/plate-utils";

type DetectionResponse = {
  ok: boolean;
  detections?: PlateDetection[];
  outputImageDataUrl?: string | null;
  error?: string;
  detail?: unknown;
};

type OcrResponse = {
  ok: boolean;
  text?: string;
  candidates?: string[];
  rawTexts?: string[];
  error?: string;
};

type PlateResult = {
  detection: PlateDetection;
  text: string;
  candidates: string[];
  cropDataUrl: string;
};

type Registry = Record<string, string>;
type GateAction = "IN" | "OUT";

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open: (options: { baudRate: number }) => Promise<void>;
  close?: () => Promise<void>;
};

const REGISTRY_KEY = "parkingPlateRegistry.v1";

const DEFAULT_REGISTRY: Registry = {
  DEMO30F: "30F",
  DEMO55F: "55F",
  DEMO75: "75"
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image."));
    img.src = src;
  });
}

async function resizeImageDataUrl(src: string, maxSide = 900, quality = 0.72): Promise<string> {
  const img = await loadImage(src);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context.");

  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

function estimateDataUrlBytes(dataUrl: string): number {
  const marker = "base64,";
  const idx = dataUrl.indexOf(marker);
  const base64 = idx >= 0 ? dataUrl.slice(idx + marker.length) : dataUrl;
  return Math.floor((base64.replace(/\s/g, "").length * 3) / 4);
}

async function compressForFreeApis(src: string): Promise<string> {
  const targets = [
    { maxSide: 900, quality: 0.72 },
    { maxSide: 768, quality: 0.68 },
    { maxSide: 640, quality: 0.62 },
    { maxSide: 512, quality: 0.58 }
  ];

  let best = await resizeImageDataUrl(src, targets[0].maxSide, targets[0].quality);

  for (const target of targets) {
    best = await resizeImageDataUrl(src, target.maxSide, target.quality);
    if (estimateDataUrlBytes(best) <= 850_000) return best;
  }

  return best;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  body: unknown,
  timeoutMs = 28_000
): Promise<{ response: Response; json: T }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();

    let json: T;
    try {
      json = text ? (JSON.parse(text) as T) : ({} as T);
    } catch {
      json = { ok: false, error: text || `Non-JSON response from ${url}` } as T;
    }

    return { response, json };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `${url} timed out after ${Math.round(timeoutMs / 1000)} seconds. Try a smaller/clearer image or test again.`
      );
    }

    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function cropImageDataUrl(
  src: string,
  bbox: PlateDetection["bbox"],
  paddingRatio = 0.12,
  mode: "full" | "top" | "bottom" = "full"
): Promise<string> {
  const img = await loadImage(src);

  const padX = bbox.width * paddingRatio;
  const padY = bbox.height * paddingRatio;

  let x1 = Math.max(0, Math.floor(bbox.x1 - padX));
  let y1 = Math.max(0, Math.floor(bbox.y1 - padY));
  let x2 = Math.min(img.naturalWidth, Math.ceil(bbox.x2 + padX));
  let y2 = Math.min(img.naturalHeight, Math.ceil(bbox.y2 + padY));

  if (mode !== "full") {
    const midY = Math.round((y1 + y2) / 2);

    if (mode === "top") {
      y2 = midY + Math.round((y2 - y1) * 0.06);
    }

    if (mode === "bottom") {
      y1 = midY - Math.round((y2 - y1) * 0.06);
    }
  }

  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);

  const canvas = document.createElement("canvas");
  const upscale = Math.min(3, Math.max(1.4, 360 / Math.max(width, 1)));

  canvas.width = Math.round(width * upscale);
  canvas.height = Math.round(height * upscale);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create crop canvas context.");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x1, y1, width, height, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/jpeg", 0.9);
}

async function drawAnnotatedImage(
  src: string,
  results: PlateResult[],
  detections: PlateDetection[]
): Promise<string> {
  const img = await loadImage(src);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create annotation canvas context.");

  ctx.drawImage(img, 0, 0);

  const lineWidth = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 450));
  const fontSize = Math.max(18, Math.round(Math.max(canvas.width, canvas.height) / 36));

  ctx.lineWidth = lineWidth;
  ctx.font = `700 ${fontSize}px Arial, sans-serif`;

  const textByDetection = new Map(results.map((item) => [item.detection.id, item.text]));

  for (const det of detections) {
    const { x1, y1, width, height } = det.bbox;
    const label = textByDetection.get(det.id) || `${det.className} ${(det.confidence * 100).toFixed(1)}%`;

    ctx.strokeStyle = "#22c55e";
    ctx.fillStyle = "rgba(34, 197, 94, 0.18)";
    ctx.fillRect(x1, y1, width, height);
    ctx.strokeRect(x1, y1, width, height);

    const text = `${label}  (${(det.confidence * 100).toFixed(1)}%)`;
    const metrics = ctx.measureText(text);
    const labelHeight = fontSize + 14;
    const labelWidth = metrics.width + 18;
    const labelY = Math.max(0, y1 - labelHeight - 4);

    ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
    ctx.fillRect(x1, labelY, labelWidth, labelHeight);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x1 + 9, labelY + fontSize + 3);
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}

function combineTwoLineText(fullText: string, topText: string, bottomText: string): string {
  const full = cleanPlateText(fullText);
  const top = cleanPlateText(topText);
  const bottom = cleanPlateText(bottomText);
  const combined = cleanPlateText(`${top} ${bottom}`);

  const fullCompactLength = full.replace(/\s/g, "").length;
  const combinedCompactLength = combined.replace(/\s/g, "").length;

  if (top && bottom && combinedCompactLength >= Math.max(5, fullCompactLength)) {
    return combined;
  }

  return full || combined;
}

function normalizeUid(uid: string): string {
  return uid.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizePlate(value: string): string {
  return compactPlateText(value).replace(/[.\-]/g, "");
}

function isPlateMatch(detectedPlate: string, savedPlate: string): boolean {
  const detected = normalizePlate(detectedPlate);
  const saved = normalizePlate(savedPlate);

  if (!detected || !saved) return false;

  if (saved.length <= 3) return detected.startsWith(saved);

  return detected === saved;
}

function loadRegistryFromStorage(): Registry {
  if (typeof window === "undefined") return DEFAULT_REGISTRY;

  try {
    const raw = window.localStorage.getItem(REGISTRY_KEY);
    if (!raw) return DEFAULT_REGISTRY;

    return {
      ...DEFAULT_REGISTRY,
      ...(JSON.parse(raw) as Registry)
    };
  } catch {
    return DEFAULT_REGISTRY;
  }
}

function saveRegistryToStorage(registry: Registry) {
  window.localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry, null, 2));
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const portRef = useRef<SerialPortLike | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const registryRef = useRef<Registry>(DEFAULT_REGISTRY);

  const [cameraActive, setCameraActive] = useState(false);
  const [imageDataUrl, setImageDataUrl] = useState<string>("");
  const [annotatedDataUrl, setAnnotatedDataUrl] = useState<string>("");
  const [detections, setDetections] = useState<PlateDetection[]>([]);
  const [results, setResults] = useState<PlateResult[]>([]);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [confidence, setConfidence] = useState(0.03);
  const [twoLineOcr, setTwoLineOcr] = useState(true);
  const [ocrEngine, setOcrEngine] = useState("2");

  const [serialConnected, setSerialConnected] = useState(false);
  const [lastArduinoLine, setLastArduinoLine] = useState("none");

  const [pendingUid, setPendingUid] = useState("");
  const [pendingAction, setPendingAction] = useState<GateAction | "">("");

  const [registry, setRegistry] = useState<Registry>(DEFAULT_REGISTRY);
  const [registerUid, setRegisterUid] = useState("");
  const [registerPlate, setRegisterPlate] = useState("30F");

  const [lastDecision, setLastDecision] = useState("No RFID scan yet.");

  const canRun = useMemo(() => Boolean(imageDataUrl) && !busy, [imageDataUrl, busy]);
  const savedPlateForPendingUid = pendingUid ? registry[normalizeUid(pendingUid)] ?? "" : "";

  useEffect(() => {
    const loaded = loadRegistryFromStorage();
    registryRef.current = loaded;
    setRegistry(loaded);
  }, []);

  useEffect(() => {
    registryRef.current = registry;
  }, [registry]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    setCameraActive(false);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();

      try {
        readerRef.current?.cancel();
      } catch {
        // Ignore cleanup errors.
      }

      try {
        writerRef.current?.releaseLock();
      } catch {
        // Ignore cleanup errors.
      }
    };
  }, [stopCamera]);

  async function startCamera() {
    setError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      setCameraActive(true);
      setStatus("Webcam started. Now connect Arduino and scan RFID.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start camera.");
    }
  }

  async function captureFrameDataUrl(): Promise<string> {
    const video = videoRef.current;

    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      throw new Error("Camera is not ready. Click Start webcam first.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not capture camera frame.");

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return compressForFreeApis(canvas.toDataURL("image/jpeg", 0.9));
  }

  async function captureFromCamera() {
    setError("");

    try {
      const compressed = await captureFrameDataUrl();

      setImageDataUrl(compressed);
      setAnnotatedDataUrl("");
      setDetections([]);
      setResults([]);
      setStatus(`Captured camera image (${Math.round(estimateDataUrlBytes(compressed) / 1024)} KB). Click Detect + OCR.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not capture camera frame.");
    }
  }

  async function handleFile(file: File | null) {
    if (!file) return;

    setError("");
    setStatus("Loading image...");

    try {
      const raw = await fileToDataUrl(file);
      const compressed = await compressForFreeApis(raw);

      setImageDataUrl(compressed);
      setAnnotatedDataUrl("");
      setDetections([]);
      setResults([]);
      setStatus(`Image ready (${Math.round(estimateDataUrlBytes(compressed) / 1024)} KB). Click Detect + OCR.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load image.");
    }
  }

  async function detectPlatesFromImage(inputImageDataUrl: string, maxResults = 3): Promise<PlateResult[]> {
    const apiImage = await compressForFreeApis(inputImageDataUrl);

    if (apiImage !== imageDataUrl) {
      setImageDataUrl(apiImage);
    }

    setStatus(`Detecting license plate (${Math.round(estimateDataUrlBytes(apiImage) / 1024)} KB image)...`);

    const { response: detectResponse, json: detectJson } = await fetchJsonWithTimeout<DetectionResponse>(
      "/api/detect",
      { imageBase64: apiImage, confidence },
      28_000
    );

    if (!detectResponse.ok || !detectJson.ok) {
      throw new Error(detectJson.error || `Detection failed with status ${detectResponse.status}.`);
    }

    const found = (detectJson.detections ?? []).slice(0, maxResults);

    setDetections(found);

    if (detectJson.outputImageDataUrl) {
      setAnnotatedDataUrl(detectJson.outputImageDataUrl);
    }

    if (found.length === 0) {
      setAnnotatedDataUrl(detectJson.outputImageDataUrl || (await drawAnnotatedImage(apiImage, [], [])));
      return [];
    }

    const plateResults: PlateResult[] = [];

    for (let i = 0; i < found.length; i += 1) {
      const det = found[i];

      setStatus(`OCR reading plate ${i + 1}/${found.length}...`);

      const fullCrop = await cropImageDataUrl(apiImage, det.bbox, 0.14, "full");
      const images = [fullCrop];

      if (twoLineOcr) {
        images.push(await cropImageDataUrl(apiImage, det.bbox, 0.14, "top"));
        images.push(await cropImageDataUrl(apiImage, det.bbox, 0.14, "bottom"));
      }

      const { response: ocrResponse, json: ocrJson } = await fetchJsonWithTimeout<OcrResponse>(
        "/api/ocr",
        { imagesBase64: images, engine: ocrEngine },
        24_000
      );

      if (!ocrResponse.ok || !ocrJson.ok) {
        throw new Error(ocrJson.error || `OCR failed with status ${ocrResponse.status}.`);
      }

      const candidates = ocrJson.candidates ?? [];

      const chosenText = twoLineOcr
        ? combineTwoLineText(candidates[0] ?? ocrJson.text ?? "", candidates[1] ?? "", candidates[2] ?? "")
        : chooseBestPlateText([ocrJson.text ?? "", ...candidates]);

      plateResults.push({
        detection: det,
        text: chosenText || "NO_TEXT",
        candidates,
        cropDataUrl: fullCrop
      });
    }

    setResults(plateResults);
    setAnnotatedDataUrl(await drawAnnotatedImage(apiImage, plateResults, found));

    return plateResults;
  }

  async function runDetectionAndOcr() {
    if (!imageDataUrl) return;

    setBusy(true);
    setError("");
    setStatus("Detecting license plate...");
    setAnnotatedDataUrl("");
    setDetections([]);
    setResults([]);

    try {
      const plateResults = await detectPlatesFromImage(imageDataUrl, 3);
      setStatus(plateResults.length > 0 ? "Done." : "No plate detected. Try a clearer image or lower confidence.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function connectArduino() {
    setError("");

    try {
      const serial = (navigator as Navigator & {
        serial?: {
          requestPort: () => Promise<SerialPortLike>;
        };
      }).serial;

      if (!serial) {
        throw new Error("Web Serial is not available. Use Chrome or Edge at http://localhost:3000.");
      }

      const port = await serial.requestPort();
      await port.open({ baudRate: 9600 });

      portRef.current = port;

      if (!port.writable) {
        throw new Error("Selected serial port is not writable.");
      }

      writerRef.current = port.writable.getWriter();

      setSerialConnected(true);
      setStatus("Arduino connected. Start webcam, then scan RFID.");

      void readArduinoLoop(port);
    } catch (err) {
      setSerialConnected(false);
      setError(err instanceof Error ? err.message : "Could not connect Arduino.");
    }
  }

  async function disconnectArduino() {
    try {
      await readerRef.current?.cancel();
    } catch {
      // Ignore.
    }

    try {
      writerRef.current?.releaseLock();
    } catch {
      // Ignore.
    }

    writerRef.current = null;

    try {
      await portRef.current?.close?.();
    } catch {
      // Ignore.
    }

    portRef.current = null;

    setSerialConnected(false);
    setStatus("Arduino disconnected.");
  }

  async function readArduinoLoop(port: SerialPortLike) {
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (port.readable) {
        const reader = port.readable.getReader();
        readerRef.current = reader;

        try {
          while (true) {
            const { value, done } = await reader.read();

            if (done) break;
            if (!value) continue;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const rawLine of lines) {
              const line = rawLine.trim();

              if (line) {
                void handleArduinoLine(line);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    } catch (err) {
      setSerialConnected(false);

      if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message);
      }
    }
  }

  async function sendToArduino(command: string) {
    if (!writerRef.current) {
      throw new Error("Arduino is not connected.");
    }

    const encoder = new TextEncoder();
    await writerRef.current.write(encoder.encode(`${command}\n`));
  }

  async function manualOpenGate(action: GateAction) {
    setError("");

    if (!serialConnected || !writerRef.current) {
      setError("Arduino is not connected. Click Connect Arduino first.");
      return;
    }

    const command = action === "IN" ? "MANUAL_IN" : "MANUAL_OUT";

    try {
      await sendToArduino(`${command},MANUAL,OPEN`);

      setPendingUid("");
      setPendingAction("");

      if (action === "IN") {
        setLastDecision("MANUAL_IN: Entrance gate opened manually.");
        setStatus("Manual entrance gate open command sent.");
      } else {
        setLastDecision("MANUAL_OUT: Exit gate opened manually.");
        setStatus("Manual exit gate open command sent.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send manual open command.");
    }
  }

  async function handleArduinoLine(line: string) {
    setLastArduinoLine(line);

    const parts = line.split(",").map((item) => item.trim());

    if (parts[0] !== "RFID") return;

    const action = parts[1] as GateAction;
    const uid = normalizeUid(parts[2] ?? "");

    if (!uid || (action !== "IN" && action !== "OUT")) return;

    setPendingUid(uid);
    setPendingAction(action);
    setRegisterUid(uid);

    const savedPlate = registryRef.current[uid] ?? "";

    if (!savedPlate) {
      setLastDecision(`UID ${uid} is not registered. Save a plate first.`);
      await sendToArduino(`DENY,${uid},UID_NOT_FOUND`);
      return;
    }

    await processGateCheck(uid, action, savedPlate);
  }

  async function processGateCheck(uid: string, action: GateAction, savedPlate: string) {
    setBusy(true);
    setError("");
    setAnnotatedDataUrl("");
    setDetections([]);
    setResults([]);

    try {
      setStatus(`RFID ${uid} detected. Capturing webcam image...`);

      const captured = await captureFrameDataUrl();
      setImageDataUrl(captured);

      const plateResults = await detectPlatesFromImage(captured, 1);

      if (plateResults.length === 0) {
        await sendToArduino(`DENY,${uid},NO_PLATE`);
        setLastDecision(`DENY: UID=${uid}. No plate detected.`);
        setStatus("No plate detected. Gate denied.");
        return;
      }

      const detectedPlate = plateResults[0].text;
      const accepted = isPlateMatch(detectedPlate, savedPlate);

      if (accepted) {
        const command = action === "IN" ? "OPEN_IN" : "OPEN_OUT";
        await sendToArduino(`${command},${uid},${normalizePlate(detectedPlate) || detectedPlate}`);

        setLastDecision(`OPEN_${action}: UID=${uid}. Saved=${savedPlate}. Detected=${detectedPlate}.`);
        setStatus(`Access accepted. Saved=${savedPlate}, Detected=${detectedPlate}.`);
      } else {
        await sendToArduino(`DENY,${uid},WRONG_PLATE`);

        setLastDecision(`DENY: UID=${uid}. Saved=${savedPlate}. Detected=${detectedPlate}.`);
        setStatus(`Access denied. Saved=${savedPlate}, Detected=${detectedPlate}.`);
      }
    } catch (err) {
      try {
        await sendToArduino(`DENY,${uid},AI_ERROR`);
      } catch {
        // Ignore nested serial errors.
      }

      setLastDecision(`DENY: UID=${uid}. AI/webcam error.`);
      setError(err instanceof Error ? err.message : "AI check failed.");
    } finally {
      setBusy(false);
    }
  }

  function savePlateForUid(uidInput = registerUid, plateInput = registerPlate) {
    const uid = normalizeUid(uidInput);
    const plate = normalizePlate(plateInput);

    if (!uid) {
      setError("Please scan or enter an RFID UID first.");
      return;
    }

    if (!plate) {
      setError("Please enter a plate number.");
      return;
    }

    const nextRegistry = {
      ...registry,
      [uid]: plate
    };

    registryRef.current = nextRegistry;
    setRegistry(nextRegistry);
    saveRegistryToStorage(nextRegistry);

    setRegisterUid(uid);
    setRegisterPlate(plate);
    setError("");
    setStatus(`Saved: UID ${uid} → plate ${plate}`);
  }

  function removePlateForUid(uid: string) {
    const normalizedUid = normalizeUid(uid);
    const nextRegistry = { ...registry };

    delete nextRegistry[normalizedUid];

    registryRef.current = nextRegistry;
    setRegistry(nextRegistry);
    saveRegistryToStorage(nextRegistry);

    setStatus(`Removed UID ${normalizedUid}.`);
  }

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">Arduino RFID + Webcam AI</p>
          <h1>Parking Gate Plate Checker</h1>
          <p className="hero-text">
            Scan an RFID card, capture the webcam image, detect the plate, compare it with the saved plate for that UID,
            then send OPEN or DENY back to Arduino.
          </p>
        </div>

        <div className="badge">USB Serial • Local browser • AI API</div>
      </section>

      <section className="panel gate-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Gate mode</p>
            <h2>Arduino connection and RFID registry</h2>
          </div>

          <p className="muted no-margin">Close Arduino Serial Monitor before connecting here.</p>
        </div>

        <div className="gate-grid">
          <article className="mini-card">
            <h3>1. Connect hardware</h3>

            <div className="button-row">
              <button type="button" onClick={connectArduino} disabled={serialConnected}>
                {serialConnected ? "Arduino connected" : "Connect Arduino"}
              </button>

              <button type="button" className="secondary" onClick={disconnectArduino} disabled={!serialConnected}>
                Disconnect
              </button>
            </div>

            <p className="muted">Serial: {serialConnected ? "Connected" : "Not connected"}</p>
            <p className="muted">Last line: {lastArduinoLine}</p>
          </article>

          <article className="mini-card">
            <h3>2. Save card plate</h3>

            <label>
              RFID UID
              <input
                value={registerUid}
                onChange={(event) => setRegisterUid(normalizeUid(event.target.value))}
                placeholder="Scan card or type UID"
              />
            </label>

            <label>
              Plate number
              <input
                value={registerPlate}
                onChange={(event) => setRegisterPlate(event.target.value.toUpperCase())}
                placeholder="Example: 30F, 55F, 75"
              />
            </label>

            <div className="quick-buttons">
              {["30F", "55F", "75"].map((plate) => (
                <button type="button" className="secondary" key={plate} onClick={() => setRegisterPlate(plate)}>
                  {plate}
                </button>
              ))}
            </div>

            <button type="button" className="primary" onClick={() => savePlateForUid()}>
              Save UID → Plate
            </button>
          </article>

          <article className="mini-card decision-card">
            <h3>3. Current check</h3>

            <p>
              <strong>Pending UID:</strong> {pendingUid || "None"}
            </p>

            <p>
              <strong>Action:</strong> {pendingAction || "None"}
            </p>

            <p>
              <strong>Saved plate:</strong> {savedPlateForPendingUid || "None"}
            </p>

            <p className="decision-text">{lastDecision}</p>

            <div className="manual-controls">
              <h4>Manual open gate</h4>

              <p className="muted">Use this only for testing or emergency. It bypasses RFID and plate checking.</p>

              <div className="button-row">
                <button
                  type="button"
                  className="danger-button"
                  disabled={!serialConnected || busy}
                  onClick={() => manualOpenGate("IN")}
                >
                  Manual open entrance
                </button>

                <button
                  type="button"
                  className="danger-button"
                  disabled={!serialConnected || busy}
                  onClick={() => manualOpenGate("OUT")}
                >
                  Manual open exit
                </button>
              </div>
            </div>
          </article>
        </div>

        <div className="registry-list">
          <h3>Saved plates</h3>

          {Object.keys(registry).length === 0 ? (
            <p className="muted">No saved plates yet.</p>
          ) : (
            <div className="registry-table">
              {Object.entries(registry).map(([uid, plate]) => (
                <div className="registry-row" key={uid}>
                  <code>{uid}</code>
                  <strong>{plate}</strong>

                  <button type="button" className="secondary" onClick={() => removePlateForUid(uid)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="panel input-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Image input</p>
            <h2>Webcam or manual image test</h2>
          </div>

          <p className="muted no-margin">For gate mode, start webcam first, then scan RFID.</p>
        </div>

        <div className="input-options">
          <label className="file-box input-card">
            <input type="file" accept="image/*" onChange={(event) => handleFile(event.target.files?.[0] ?? null)} />
            <span>Upload image</span>
            <small>Manual testing only. JPG / PNG / WebP.</small>
          </label>

          <div className="camera-box input-card">
            <div className="camera-preview">
              <video ref={videoRef} autoPlay playsInline muted className={cameraActive ? "video active" : "video"} />
              {!cameraActive ? <div className="camera-placeholder">Webcam preview appears here</div> : null}
            </div>

            <div className="button-row">
              {!cameraActive ? (
                <button type="button" onClick={startCamera}>
                  Start webcam
                </button>
              ) : (
                <>
                  <button type="button" onClick={captureFromCamera}>
                    Capture
                  </button>

                  <button type="button" className="secondary" onClick={stopCamera}>
                    Stop
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="settings action-settings">
          <label>
            Detection confidence
            <input
              type="number"
              step="0.01"
              min="0.01"
              max="0.9"
              value={confidence}
              onChange={(event) => setConfidence(Number(event.target.value))}
            />
          </label>

          <label>
            OCR engine
            <select value={ocrEngine} onChange={(event) => setOcrEngine(event.target.value)}>
              <option value="1">Engine 1</option>
              <option value="2">Engine 2</option>
              <option value="3">Engine 3</option>
            </select>
          </label>

          <label className="checkbox-row">
            <input type="checkbox" checked={twoLineOcr} onChange={(event) => setTwoLineOcr(event.target.checked)} />
            Use two-line plate OCR crop
          </label>

          <button type="button" className="primary" disabled={!canRun} onClick={runDetectionAndOcr}>
            {busy ? "Processing..." : "Detect + OCR"}
          </button>
        </div>

        {status ? <p className="status">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel compare-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Result view</p>
            <h2>Before and after</h2>
          </div>

          <p className="muted no-margin">Left: input image. Right: detected plate + OCR text.</p>
        </div>

        <div className="compare-grid">
          <article className="image-card">
            <div className="image-card-head">
              <strong>Before</strong>
              <span>Original input</span>
            </div>

            <div className="image-stage">
              {imageDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageDataUrl} alt="Original uploaded or webcam input" />
              ) : (
                <div className="placeholder">Upload an image or capture from webcam.</div>
              )}
            </div>
          </article>

          <article className="image-card">
            <div className="image-card-head">
              <strong>After</strong>
              <span>Detected + OCR result</span>
            </div>

            <div className="image-stage">
              {annotatedDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={annotatedDataUrl} alt="Annotated output with license plate result" />
              ) : imageDataUrl ? (
                <div className="placeholder">Click Detect + OCR or scan RFID to create result.</div>
              ) : (
                <div className="placeholder">Result will appear here.</div>
              )}
            </div>
          </article>
        </div>
      </section>

      <section className="panel results-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">OCR output</p>
            <h2>Plate OCR results</h2>
          </div>

          <p className="muted no-margin">Detected crop, final text, confidence, and OCR candidates.</p>
        </div>

        {detections.length === 0 && results.length === 0 ? (
          <p className="muted">No detection result yet.</p>
        ) : results.length === 0 ? (
          <p className="muted">Plate detection returned no OCR result.</p>
        ) : (
          <div className="results-grid">
            {results.map((item, index) => (
              <article key={item.detection.id} className="result-card">
                <div className="crop-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.cropDataUrl} alt={`Plate crop ${index + 1}`} />
                </div>

                <div>
                  <p className="result-title">Plate #{index + 1}</p>
                  <p className="plate-text">{item.text || "NO_TEXT"}</p>
                  <p className="muted">Normalized: {normalizePlate(item.text)}</p>
                  <p className="muted">Detection confidence: {(item.detection.confidence * 100).toFixed(1)}%</p>

                  {item.candidates.length > 0 ? (
                    <details>
                      <summary>OCR candidates</summary>
                      <ul>
                        {item.candidates.map((candidate, candidateIndex) => (
                          <li key={`${candidate}-${candidateIndex}`}>{candidate || "EMPTY"}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
