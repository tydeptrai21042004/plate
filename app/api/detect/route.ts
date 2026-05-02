import { NextRequest, NextResponse } from "next/server";
import type { PlateDetection } from "../../../lib/plate-utils";

export const runtime = "nodejs";
export const maxDuration = 60;

type RoboflowPredictionLike = Record<string, unknown>;

function stripDataUrl(image: string): string {
  const marker = "base64,";
  const idx = image.indexOf(marker);
  return idx >= 0 ? image.slice(idx + marker.length) : image;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function hasPredictionShape(item: unknown): item is RoboflowPredictionLike {
  if (!item || typeof item !== "object") return false;
  const obj = item as Record<string, unknown>;
  return (
    ("x" in obj && "y" in obj && "width" in obj && "height" in obj) ||
    "bbox" in obj ||
    "box" in obj ||
    ("xmin" in obj && "ymin" in obj && "xmax" in obj && "ymax" in obj)
  );
}

function collectPredictionObjects(value: unknown, out: RoboflowPredictionLike[] = []): RoboflowPredictionLike[] {
  if (!value) return out;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasPredictionShape(item)) out.push(item);
      collectPredictionObjects(item, out);
    }
    return out;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (hasPredictionShape(obj)) out.push(obj);

    for (const key of Object.keys(obj)) {
      // Roboflow Workflow responses are often nested under outputs, predictions, or model_predictions.
      if (["outputs", "predictions", "model_predictions", "results", "detections", "data"].includes(key)) {
        collectPredictionObjects(obj[key], out);
      }
    }
  }

  return out;
}

function normalizeDetection(pred: RoboflowPredictionLike, index: number): PlateDetection | null {
  const confidence = toNumber(pred.confidence ?? pred.score ?? pred.probability, 0);
  const className = String(pred.class ?? pred.class_name ?? pred.label ?? pred.name ?? "plate");

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
  } else if (pred.bbox && typeof pred.bbox === "object") {
    const bbox = pred.bbox as Record<string, unknown>;
    x1 = toNumber(bbox.xmin ?? bbox.x1 ?? bbox.left);
    y1 = toNumber(bbox.ymin ?? bbox.y1 ?? bbox.top);
    x2 = toNumber(bbox.xmax ?? bbox.x2 ?? bbox.right);
    y2 = toNumber(bbox.ymax ?? bbox.y2 ?? bbox.bottom);
  } else if (pred.box && typeof pred.box === "object") {
    const box = pred.box as Record<string, unknown>;
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
    id: `${className}-${index}-${Math.round(x1)}-${Math.round(y1)}`,
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

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const workflowUrl = process.env.ROBOFLOW_WORKFLOW_URL;
    const minConfidence = Number(process.env.ROBOFLOW_MIN_CONFIDENCE ?? "0.03");

    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Missing ROBOFLOW_API_KEY environment variable." },
        { status: 500 }
      );
    }

    if (!workflowUrl) {
      return NextResponse.json(
        { ok: false, error: "Missing ROBOFLOW_WORKFLOW_URL environment variable." },
        { status: 500 }
      );
    }

    const body = (await request.json()) as { imageBase64?: string; confidence?: number };
    if (!body.imageBase64) {
      return NextResponse.json({ ok: false, error: "Missing imageBase64." }, { status: 400 });
    }

    const imageBase64 = stripDataUrl(body.imageBase64);

    const roboflowPayload = {
      api_key: apiKey,
      inputs: {
        image: {
          type: "base64",
          value: imageBase64
        }
      }
    };

    const rfResponse = await fetch(workflowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(roboflowPayload)
    });

    const raw = await rfResponse.json().catch(() => null);

    if (!rfResponse.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Roboflow request failed.",
          status: rfResponse.status,
          detail: raw
        },
        { status: 502 }
      );
    }

    const threshold = Number.isFinite(body.confidence) ? Number(body.confidence) : minConfidence;
    const predictions = collectPredictionObjects(raw);
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
      raw: process.env.RETURN_RAW_ROBOFLOW === "true" ? raw : undefined
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown detection error." },
      { status: 500 }
    );
  }
}
