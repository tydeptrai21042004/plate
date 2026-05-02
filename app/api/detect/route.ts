import { NextRequest, NextResponse } from "next/server";
import type { PlateDetection } from "../../../lib/plate-utils";

export const runtime = "nodejs";
export const maxDuration = 30;

type JsonObject = Record<string, unknown>;
type RoboflowPrediction = JsonObject;

type DetectRequestBody = {
  imageBase64?: string;
  confidence?: number;
};

function stripDataUrl(image: string): string {
  const marker = "base64,";
  const idx = image.indexOf(marker);
  return idx >= 0 ? image.slice(idx + marker.length) : image;
}

function base64ToDataUrl(base64: string, mime = "image/jpeg"): string {
  if (base64.startsWith("data:")) return base64;
  return `data:${mime};base64,${base64}`;
}

function approximateBase64Bytes(base64: string): number {
  const cleaned = base64.replace(/\s/g, "");
  return Math.floor((cleaned.length * 3) / 4);
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function hasPredictionShape(value: unknown): value is RoboflowPrediction {
  const obj = asObject(value);
  if (!obj) return false;

  return (
    ("x" in obj && "y" in obj && "width" in obj && "height" in obj) ||
    "bbox" in obj ||
    "box" in obj ||
    ("xmin" in obj && "ymin" in obj && "xmax" in obj && "ymax" in obj)
  );
}

function extractWorkflowItems(raw: unknown): JsonObject[] {
  if (Array.isArray(raw)) return raw.map(asObject).filter((item): item is JsonObject => Boolean(item));
  const obj = asObject(raw);
  return obj ? [obj] : [];
}

function extractOutputImageDataUrl(raw: unknown): string | null {
  for (const item of extractWorkflowItems(raw)) {
    const outputImage = asObject(item.output_image);
    const value = outputImage?.value;
    if (typeof value === "string" && value.length > 20) {
      return base64ToDataUrl(value, "image/jpeg");
    }
  }
  return null;
}

function extractPredictionsFromKnownRoboflowShape(raw: unknown): RoboflowPrediction[] {
  const found: RoboflowPrediction[] = [];

  for (const item of extractWorkflowItems(raw)) {
    // Exact shape from your working workflow:
    // [{ predictions: { image: {...}, predictions: [{x,y,width,height,...}] } }]
    const predictionsContainer = asObject(item.predictions);
    const predictionsArray = predictionsContainer?.predictions;
    if (Array.isArray(predictionsArray)) {
      for (const pred of predictionsArray) {
        if (hasPredictionShape(pred)) found.push(pred);
      }
    }

    // Some Roboflow workflows return result.predictions directly.
    const directPredictions = item.predictions;
    if (Array.isArray(directPredictions)) {
      for (const pred of directPredictions) {
        if (hasPredictionShape(pred)) found.push(pred);
      }
    }
  }

  return found;
}

function collectPredictionObjectsDeep(value: unknown, out: RoboflowPrediction[] = []): RoboflowPrediction[] {
  if (!value) return out;

  if (Array.isArray(value)) {
    for (const item of value) collectPredictionObjectsDeep(item, out);
    return out;
  }

  const obj = asObject(value);
  if (!obj) return out;

  if (hasPredictionShape(obj)) out.push(obj);

  for (const child of Object.values(obj)) {
    if (typeof child === "object") collectPredictionObjectsDeep(child, out);
  }

  return out;
}

function normalizeDetection(pred: RoboflowPrediction, index: number): PlateDetection | null {
  const confidence = toNumber(pred.confidence ?? pred.score ?? pred.probability ?? pred.class_confidence, 0);
  const className = String(pred.class ?? pred.class_name ?? pred.label ?? pred.name ?? "License_Plate");

  let x1 = 0;
  let y1 = 0;
  let x2 = 0;
  let y2 = 0;

  if ("x" in pred && "y" in pred && "width" in pred && "height" in pred) {
    const x = toNumber(pred.x);
    const y = toNumber(pred.y);
    const width = toNumber(pred.width);
    const height = toNumber(pred.height);
    x1 = x - width / 2;
    y1 = y - height / 2;
    x2 = x + width / 2;
    y2 = y + height / 2;
  } else if (asObject(pred.bbox)) {
    const bbox = asObject(pred.bbox)!;
    x1 = toNumber(bbox.xmin ?? bbox.x1 ?? bbox.left);
    y1 = toNumber(bbox.ymin ?? bbox.y1 ?? bbox.top);
    x2 = toNumber(bbox.xmax ?? bbox.x2 ?? bbox.right);
    y2 = toNumber(bbox.ymax ?? bbox.y2 ?? bbox.bottom);
  } else if (asObject(pred.box)) {
    const box = asObject(pred.box)!;
    x1 = toNumber(box.xmin ?? box.x1 ?? box.left);
    y1 = toNumber(box.ymin ?? box.y1 ?? box.top);
    x2 = toNumber(box.xmax ?? box.x2 ?? box.right);
    y2 = toNumber(box.ymax ?? box.y2 ?? box.bottom);
  } else {
    x1 = toNumber(pred.xmin ?? pred.x1 ?? pred.left);
    y1 = toNumber(pred.ymin ?? pred.y1 ?? pred.top);
    x2 = toNumber(pred.xmax ?? pred.x2 ?? pred.right);
    y2 = toNumber(pred.ymax ?? pred.y2 ?? pred.bottom);
  }

  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  if (width <= 1 || height <= 1) return null;

  return {
    id: `${className}-${index}-${Math.round(x1)}-${Math.round(y1)}-${Math.round(width)}-${Math.round(height)}`,
    className,
    confidence,
    bbox: { x1, y1, x2, y2, width, height },
    raw: pred
  };
}

function dedupeDetections(detections: PlateDetection[]): PlateDetection[] {
  const seen = new Set<string>();
  const deduped: PlateDetection[] = [];

  for (const det of detections) {
    const key = [
      Math.round(det.bbox.x1 / 3),
      Math.round(det.bbox.y1 / 3),
      Math.round(det.bbox.x2 / 3),
      Math.round(det.bbox.y2 / 3)
    ].join(":");

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(det);
    }
  }

  return deduped;
}

function timeoutMessage(ms: number): string {
  return `Roboflow did not respond within ${Math.round(ms / 1000)} seconds. Try a smaller image or test the workflow directly in Roboflow.`;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  try {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const workflowUrl = process.env.ROBOFLOW_WORKFLOW_URL;
    const minConfidence = Number(process.env.ROBOFLOW_MIN_CONFIDENCE ?? "0.03");
    const timeoutMs = Number(process.env.ROBOFLOW_TIMEOUT_MS ?? "18000");
    const maxImageBytes = Number(process.env.MAX_API_IMAGE_BYTES ?? "900000");

    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "Missing ROBOFLOW_API_KEY environment variable." }, { status: 500 });
    }

    if (!workflowUrl) {
      return NextResponse.json({ ok: false, error: "Missing ROBOFLOW_WORKFLOW_URL environment variable." }, { status: 500 });
    }

    const body = (await request.json()) as DetectRequestBody;
    if (!body.imageBase64) {
      return NextResponse.json({ ok: false, error: "Missing imageBase64." }, { status: 400 });
    }

    const imageBase64 = stripDataUrl(body.imageBase64);
    const imageBytes = approximateBase64Bytes(imageBase64);
    if (imageBytes > maxImageBytes) {
      return NextResponse.json(
        {
          ok: false,
          error: `Image is too large after compression (${Math.round(imageBytes / 1024)} KB). Please use a smaller image.`,
          imageBytes,
          maxImageBytes
        },
        { status: 413 }
      );
    }

    const roboflowPayload = {
      api_key: apiKey,
      inputs: {
        image: {
          type: "base64",
          value: imageBase64
        }
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let rfResponse: Response;
    try {
      rfResponse = await fetch(workflowUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(roboflowPayload),
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return NextResponse.json(
          { ok: false, error: timeoutMessage(timeoutMs), elapsedMs: Date.now() - startedAt },
          { status: 504 }
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const rawText = await rfResponse.text();
    let raw: unknown = null;
    try {
      raw = rawText ? JSON.parse(rawText) : null;
    } catch {
      raw = { nonJsonResponse: rawText.slice(0, 800) };
    }

    if (!rfResponse.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Roboflow request failed. Check that the workflow URL is detect-count-and-visualize, not the broken detect-and-classify workflow.",
          status: rfResponse.status,
          detail: raw,
          elapsedMs: Date.now() - startedAt
        },
        { status: 502 }
      );
    }

    const threshold = Number.isFinite(body.confidence) ? Number(body.confidence) : minConfidence;
    const knownShapePredictions = extractPredictionsFromKnownRoboflowShape(raw);
    const fallbackPredictions = knownShapePredictions.length > 0 ? [] : collectPredictionObjectsDeep(raw);
    const predictions = knownShapePredictions.length > 0 ? knownShapePredictions : fallbackPredictions;

    const detections = dedupeDetections(
      predictions
        .map((pred, index) => normalizeDetection(pred, index))
        .filter((item): item is PlateDetection => Boolean(item))
        .filter((item) => item.confidence >= threshold)
        .sort((a, b) => b.confidence - a.confidence)
    );

    return NextResponse.json({
      ok: true,
      detections,
      outputImageDataUrl: extractOutputImageDataUrl(raw),
      elapsedMs: Date.now() - startedAt,
      raw: process.env.RETURN_RAW_ROBOFLOW === "true" ? raw : undefined
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown detection error.",
        elapsedMs: Date.now() - startedAt
      },
      { status: 500 }
    );
  }
}
