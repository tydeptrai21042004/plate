export type PlateDetection = {
  id: string;
  className: string;
  confidence: number;
  bbox: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    height: number;
  };
  raw?: unknown;
};

export function cleanPlateText(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^A-Z0-9.\- ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactPlateText(input: string): string {
  return cleanPlateText(input).replace(/\s+/g, "");
}

export function scorePlateText(input: string): number {
  const text = cleanPlateText(input);
  if (!text) return 0;

  const compact = compactPlateText(text);
  let score = 0;

  score += Math.min(compact.length, 12) * 2;
  if (/\d/.test(compact)) score += 8;
  if (/[A-Z]/.test(compact)) score += 4;
  if (compact.includes("-") || compact.includes(".")) score += 6;
  if (/^\d{2}[A-Z]?-?[A-Z0-9]{1,3}/.test(compact)) score += 10;
  if (/\d{3,5}[.]?\d{0,3}$/.test(compact)) score += 6;
  if (compact.length < 4) score -= 10;

  return score;
}

export function chooseBestPlateText(candidates: string[]): string {
  const valid = candidates.map(cleanPlateText).filter(Boolean);
  if (valid.length === 0) return "";
  return valid.sort((a, b) => scorePlateText(b) - scorePlateText(a))[0];
}
