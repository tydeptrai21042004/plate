"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlateDetection } from "../lib/plate-utils";

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
  // Vercel + free OCR APIs are much more stable with sub-1MB images.
  // Try several sizes/qualities until the image is small enough.
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

async function fetchJsonWithTimeout<T>(url: string, body: unknown, timeoutMs = 28_000): Promise<{ response: Response; json: T }> {
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
      throw new Error(`${url} timed out after ${Math.round(timeoutMs / 1000)} seconds. Try a smaller/clearer image or test again.`);
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
    if (mode === "top") y2 = midY + Math.round((y2 - y1) * 0.06);
    if (mode === "bottom") y1 = midY - Math.round((y2 - y1) * 0.06);
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

async function drawAnnotatedImage(src: string, results: PlateResult[], detections: PlateDetection[]): Promise<string> {
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
  const clean = (value: string) =>
    value
      .toUpperCase()
      .replace(/[^A-Z0-9.\- ]+/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const full = clean(fullText);
  const top = clean(topText);
  const bottom = clean(bottomText);
  const combined = clean(`${top} ${bottom}`);

  const fullCompactLength = full.replace(/\s/g, "").length;
  const combinedCompactLength = combined.replace(/\s/g, "").length;

  if (top && bottom && combinedCompactLength >= Math.max(5, fullCompactLength)) return combined;
  return full || combined;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
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

  const canRun = useMemo(() => Boolean(imageDataUrl) && !busy, [imageDataUrl, busy]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  async function startCamera() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraActive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start camera.");
    }
  }

  async function captureFromCamera() {
    setError("");
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setError("Camera is not ready yet.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Could not capture camera frame.");
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const compressed = await compressForFreeApis(canvas.toDataURL("image/jpeg", 0.9));
    setImageDataUrl(compressed);
    setAnnotatedDataUrl("");
    setDetections([]);
    setResults([]);
    setStatus(`Captured camera image (${Math.round(estimateDataUrlBytes(compressed) / 1024)} KB). Click Detect + OCR.`);
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

  async function runDetectionAndOcr() {
    if (!imageDataUrl) return;

    setBusy(true);
    setError("");
    setStatus("Detecting license plate with Roboflow...");
    setAnnotatedDataUrl("");
    setDetections([]);
    setResults([]);

    try {
      const apiImage = await compressForFreeApis(imageDataUrl);
      if (apiImage !== imageDataUrl) setImageDataUrl(apiImage);
      setStatus(`Detecting license plate with Roboflow (${Math.round(estimateDataUrlBytes(apiImage) / 1024)} KB image)...`);

      const { response: detectResponse, json: detectJson } = await fetchJsonWithTimeout<DetectionResponse>(
        "/api/detect",
        { imageBase64: apiImage, confidence },
        28_000
      );

      if (!detectResponse.ok || !detectJson.ok) {
        throw new Error(detectJson.error || `Detection failed with status ${detectResponse.status}.`);
      }

      const srcForProcessing = apiImage;
      const found = (detectJson.detections ?? []).slice(0, 3);
      setDetections(found);
      if (detectJson.outputImageDataUrl) {
        setAnnotatedDataUrl(detectJson.outputImageDataUrl);
      }

      if (found.length === 0) {
        setStatus("No plate detected. Try lowering confidence or using a clearer image.");
        setAnnotatedDataUrl(detectJson.outputImageDataUrl || (await drawAnnotatedImage(srcForProcessing, [], [])));
        return;
      }

      const plateResults: PlateResult[] = [];
      for (let i = 0; i < found.length; i += 1) {
        const det = found[i];
        setStatus(`OCR.space reading plate ${i + 1}/${found.length}...`);

        const fullCrop = await cropImageDataUrl(srcForProcessing, det.bbox, 0.14, "full");
        const images = [fullCrop];

        if (twoLineOcr) {
          images.push(await cropImageDataUrl(srcForProcessing, det.bbox, 0.14, "top"));
          images.push(await cropImageDataUrl(srcForProcessing, det.bbox, 0.14, "bottom"));
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
          : ocrJson.text ?? "";

        plateResults.push({
          detection: det,
          text: chosenText || "NO_TEXT",
          candidates,
          cropDataUrl: fullCrop
        });
      }

      setResults(plateResults);
      setAnnotatedDataUrl(await drawAnnotatedImage(srcForProcessing, plateResults, found));
      setStatus("Done.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div>
          <p className="eyebrow">Roboflow detection + OCR.space OCR</p>
          <h1>Free API License Plate Reader</h1>
          <p className="hero-text">
            Choose an image from your computer or capture one from the webcam. The app shows the
            original image and the annotated output side by side, while API keys stay protected in
            Vercel server routes.
          </p>
        </div>
        <div className="badge">Vercel-ready • No local .pt model</div>
      </section>

      <section className="panel input-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Step 1</p>
            <h2>Choose input source</h2>
          </div>
          <p className="muted no-margin">Upload an existing image or capture directly from the user webcam.</p>
        </div>

        <div className="input-options">
          <label className="file-box input-card">
            <input
              type="file"
              accept="image/*"
              onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
            />
            <span>Upload image</span>
            <small>JPG / PNG / WebP. Large images are compressed before API calls.</small>
          </label>

          <div className="camera-box input-card">
            <div className="camera-preview">
              <video ref={videoRef} autoPlay playsInline muted className={cameraActive ? "video active" : "video"} />
              {!cameraActive ? <div className="camera-placeholder">Webcam preview appears here</div> : null}
            </div>
            <div className="button-row">
              {!cameraActive ? (
                <button type="button" onClick={startCamera}>Start webcam</button>
              ) : (
                <>
                  <button type="button" onClick={captureFromCamera}>Capture</button>
                  <button type="button" className="secondary" onClick={stopCamera}>Stop</button>
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
            <input
              type="checkbox"
              checked={twoLineOcr}
              onChange={(event) => setTwoLineOcr(event.target.checked)}
            />
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
            <p className="eyebrow">Step 2</p>
            <h2>Before and after</h2>
          </div>
          <p className="muted no-margin">Left: original input. Right: Roboflow box + OCR.space plate text.</p>
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
                <div className="placeholder">Click Detect + OCR to create the annotated result.</div>
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
            <p className="eyebrow">Step 3</p>
            <h2>Plate OCR results</h2>
          </div>
          <p className="muted no-margin">Detected plate crop, final text, confidence, and OCR candidates.</p>
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
