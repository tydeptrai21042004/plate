# Free API License Plate Reader for Vercel

This is a Vercel-ready **Next.js** website for license plate detection and OCR.

It uses:

- **Roboflow Workflow API** for license plate detection
- **OCR.space API** for OCR
- **Image upload** from user computer
- **Webcam capture** from browser camera
- **Before / After preview** side by side
- **No local `.pt` weight** and no Python model server

API keys are used only inside Next.js API routes, so they are not exposed to browser JavaScript.

---

## 1. Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open:

```text
http://localhost:3000
```

---

## 2. Example `.env.local`

Create `.env.local` in the project root:

```env
# Roboflow Workflow API
# Keep this server-side only. Do NOT use NEXT_PUBLIC_ for this key.
ROBOFLOW_API_KEY=your_roboflow_api_key_here
ROBOFLOW_WORKFLOW_URL=https://serverless.roboflow.com/dang-ba-ty/workflows/detect-and-classify
ROBOFLOW_MIN_CONFIDENCE=0.03

# OCR.space API
# Keep this server-side only. Do NOT use NEXT_PUBLIC_ for this key.
OCR_SPACE_API_KEY=your_ocr_space_api_key_here
OCR_SPACE_ENGINE=2
OCR_SPACE_LANGUAGE=eng

# Debug option. Keep false in production.
RETURN_RAW_ROBOFLOW=false
```

### Important

Do **not** paste real API keys into frontend files like `app/page.tsx`. Put them only in `.env.local` locally and in Vercel Environment Variables after deployment.

---

## 3. Deploy to Vercel

1. Push this folder to GitHub.
2. Go to Vercel and import your repository.
3. Open **Project Settings → Environment Variables**.
4. Add these variables:

```env
ROBOFLOW_API_KEY=your_roboflow_api_key_here
ROBOFLOW_WORKFLOW_URL=https://serverless.roboflow.com/dang-ba-ty/workflows/detect-and-classify
ROBOFLOW_MIN_CONFIDENCE=0.03
OCR_SPACE_API_KEY=your_ocr_space_api_key_here
OCR_SPACE_ENGINE=2
OCR_SPACE_LANGUAGE=eng
RETURN_RAW_ROBOFLOW=false
```

5. Click **Deploy**.

---

## 4. How the website works

```text
User uploads image OR captures webcam frame
→ Browser compresses image to JPEG
→ /api/detect calls Roboflow Workflow with base64 image
→ Browser crops detected plate region
→ /api/ocr calls OCR.space with the cropped plate
→ Browser draws box + OCR text
→ UI shows Before and After side by side
```

---

## 5. Two-line Vietnamese plates

The UI includes **Use two-line plate OCR crop**. When enabled, the app sends three OCR crops:

```text
full plate crop
top half crop
bottom half crop
```

This helps with Vietnamese motorbike plates such as:

```text
90-B2
452.30
```

---

## 6. Troubleshooting

### No plate detected

Try lowering confidence in the UI to:

```text
0.01
```

Or set this in `.env.local` / Vercel:

```env
ROBOFLOW_MIN_CONFIDENCE=0.01
```

### OCR reads only one line

Enable:

```text
Use two-line plate OCR crop
```

Then try OCR Engine `1`, `2`, and `3`.

### Webcam does not work

Camera access requires HTTPS. Vercel deployments use HTTPS. Localhost also works in most browsers.

### Roboflow response has no detections

Set this temporarily:

```env
RETURN_RAW_ROBOFLOW=true
```

Then check the `/api/detect` response in the browser Network tab. After debugging, set it back to:

```env
RETURN_RAW_ROBOFLOW=false
```
