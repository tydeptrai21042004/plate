import { NextRequest, NextResponse } from "next/server";
import { cleanPlateText, chooseBestPlateText } from "../../../lib/plate-utils";

export const runtime = "nodejs";
export const maxDuration = 60;

type OcrSpaceParsedResult = {
  ParsedText?: string;
  ErrorMessage?: string;
};

type OcrSpaceResponse = {
  ParsedResults?: OcrSpaceParsedResult[];
  OCRExitCode?: number;
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[];
  ErrorDetails?: string;
};

function asDataUrl(image: string): string {
  if (image.startsWith("data:")) return image;
  return `data:image/jpeg;base64,${image}`;
}

function normalizeErrorMessage(message: unknown): string {
  if (Array.isArray(message)) return message.map(String).join("; ");
  if (message) return String(message);
  return "OCR.space request failed.";
}

async function callOcrSpace(imageBase64: string, engine: string): Promise<{ rawText: string; cleanText: string; raw: OcrSpaceResponse }> {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  const language = process.env.OCR_SPACE_LANGUAGE ?? "eng";

  if (!apiKey) {
    throw new Error("Missing OCR_SPACE_API_KEY environment variable.");
  }

  const form = new FormData();
  form.append("apikey", apiKey);
  form.append("base64Image", asDataUrl(imageBase64));
  form.append("language", language);
  form.append("OCREngine", engine);
  form.append("isOverlayRequired", "false");
  form.append("scale", "true");
  form.append("detectOrientation", "true");
  form.append("isTable", "false");

  const response = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: form
  });

  const raw = (await response.json().catch(() => null)) as OcrSpaceResponse | null;

  if (!response.ok || !raw) {
    throw new Error(`OCR.space HTTP error: ${response.status}`);
  }

  if (raw.IsErroredOnProcessing) {
    throw new Error(normalizeErrorMessage(raw.ErrorMessage ?? raw.ErrorDetails));
  }

  const rawText = raw.ParsedResults?.map((item) => item.ParsedText ?? "").join("\n") ?? "";
  return {
    rawText,
    cleanText: cleanPlateText(rawText),
    raw
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      imageBase64?: string;
      imagesBase64?: string[];
      engine?: string;
    };

    const images = body.imagesBase64?.length ? body.imagesBase64 : body.imageBase64 ? [body.imageBase64] : [];
    if (images.length === 0) {
      return NextResponse.json({ ok: false, error: "Missing imageBase64 or imagesBase64." }, { status: 400 });
    }

    // Keep this small because the free OCR.space quota is limited.
    const safeImages = images.slice(0, 3);
    const engine = String(body.engine ?? process.env.OCR_SPACE_ENGINE ?? "2");

    const results = [];
    for (const image of safeImages) {
      results.push(await callOcrSpace(image, engine));
    }

    const candidates = results.map((item) => item.cleanText).filter(Boolean);
    const bestText = chooseBestPlateText(candidates);

    return NextResponse.json({
      ok: true,
      text: bestText,
      candidates,
      rawTexts: results.map((item) => item.rawText)
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown OCR error." },
      { status: 500 }
    );
  }
}
