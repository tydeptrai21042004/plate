# ALPR Vercel Webcam App

Next.js app for API-based license plate recognition:

- Roboflow Workflow API for license-plate detection
- OCR.space API for plate OCR
- Image upload input
- Webcam capture input
- Before / After side-by-side result
- No local `.pt` model weight

## Important Roboflow fix

Use this workflow URL:

```env
ROBOFLOW_WORKFLOW_URL=https://serverless.roboflow.com/dang-ba-ty/workflows/detect-count-and-visualize
```

Do **not** use the older `detect-and-classify` workflow if it still contains the broken `classification_model` step. That workflow calls `car-colors-1smyc/5` and can return:

```text
Service misconfiguration
500 Server Error
classification_model
```

This project parses the working response shape you pasted:

```json
[
  {
    "output_image": { "type": "base64", "value": "..." },
    "predictions": {
      "image": { "width": 439, "height": 325 },
      "predictions": [
        {
          "x": 213.5,
          "y": 232,
          "width": 113,
          "height": 30,
          "confidence": 0.8647,
          "class": "License_Plate"
        }
      ]
    }
  }
]
```

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open:

```text
http://localhost:3000
```

## Example `.env.local`

```env
ROBOFLOW_API_KEY=your_roboflow_api_key_here
ROBOFLOW_WORKFLOW_URL=https://serverless.roboflow.com/dang-ba-ty/workflows/detect-count-and-visualize
ROBOFLOW_MIN_CONFIDENCE=0.03
ROBOFLOW_TIMEOUT_MS=18000
MAX_API_IMAGE_BYTES=900000

OCR_SPACE_API_KEY=your_ocr_space_api_key_here
OCR_SPACE_ENGINE=2
OCR_SPACE_LANGUAGE=eng
OCR_SPACE_TIMEOUT_MS=15000
MAX_OCR_IMAGE_BYTES=650000

RETURN_RAW_ROBOFLOW=false
```

## Vercel deploy

1. Push this folder to GitHub.
2. Import the repo into Vercel.
3. Add the environment variables from `.env.example`.
4. Redeploy.

## If `/api/detect` returns 504

Try smaller images or lower these values:

```env
ROBOFLOW_TIMEOUT_MS=12000
MAX_API_IMAGE_BYTES=600000
```

## Security note

Do not put API keys in frontend code. This app keeps keys inside server-side API routes. If you pasted real keys publicly, rotate/regenerate them before deployment.
