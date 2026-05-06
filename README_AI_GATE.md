# Arduino RFID + Webcam AI Parking Gate

## What changed

This version adds:

- Web Serial connection from browser to Arduino.
- RFID UID registry using browser `localStorage`.
- Test plate quick buttons: `30F`, `55F`, `75`.
- Automatic flow: RFID scan -> webcam capture -> detection/OCR -> compare saved plate -> send `OPEN_IN`, `OPEN_OUT`, or `DENY` to Arduino.
- Corrected Arduino code in `arduino/parking_ai_gate/parking_ai_gate.ino`.

## Arduino serial protocol

Arduino sends:

```text
RFID,IN,UID
RFID,OUT,UID
```

Browser sends:

```text
OPEN_IN,UID,PLATE
OPEN_OUT,UID,PLATE
DENY,UID,REASON
```

## Test steps

1. Upload `arduino/parking_ai_gate/parking_ai_gate.ino` to Arduino.
2. Close Arduino Serial Monitor.
3. Run the web app:

```bash
npm install
npm run dev
```

4. Open `http://localhost:3000` in Chrome or Edge.
5. Click **Start webcam**.
6. Click **Connect Arduino** and choose the Arduino COM port.
7. Scan RFID once. The UID appears in the web page.
8. Select or type a plate such as `30F`, `55F`, or `75`.
9. Click **Save UID → Plate**.
10. Scan the RFID again with a matching plate image in front of the webcam.

## Matching rule

For short saved values such as `30F`, `55F`, or `75`, the app uses prefix matching:

- Saved `30F` matches OCR `30F12345`.
- Saved `55F` matches OCR `55F99999`.
- Saved `75` matches OCR `75A12345`.

For longer saved plates, the app uses exact normalized matching.
