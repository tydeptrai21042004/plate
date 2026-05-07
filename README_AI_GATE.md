# Arduino RFID + Webcam AI Parking Gate

## What changed

This version adds:

- Web Serial connection from browser to Arduino.
- RFID UID registry using browser `localStorage`.
- Test plate quick buttons: `30F`, `55F`, `75`.
- Automatic flow: RFID scan -> matching gate camera capture -> detection/OCR -> compare saved plate -> send `OPEN_IN`, `OPEN_OUT`, or `DENY` to Arduino.
- Two browser camera streams: one camera for IN/entrance and one camera for OUT/exit.
- No Arduino code change is required for the two-camera routing. The browser uses the existing `RFID,IN,UID` and `RFID,OUT,UID` serial messages.
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
5. Connect two USB cameras if available.
6. Click **Refresh camera list**.
7. Choose the entrance camera in **IN camera / entrance** and the exit camera in **OUT camera / exit**.
8. Click **Start both cameras**.
9. Click **Connect Arduino** and choose the Arduino COM port.
10. Scan RFID once. The UID appears in the web page.
11. Select or type a plate such as `30F`, `55F`, or `75`.
12. Click **Save UID → Plate**.
13. Scan the RFID again with a matching plate in front of the correct camera.

When Arduino sends `RFID,IN,UID`, the browser captures the IN camera and sends back `OPEN_IN` if accepted.
When Arduino sends `RFID,OUT,UID`, the browser captures the OUT camera and sends back `OPEN_OUT` if accepted.

## Matching rule

For short saved values such as `30F`, `55F`, or `75`, the app uses prefix matching:

- Saved `30F` matches OCR `30F12345`.
- Saved `55F` matches OCR `55F99999`.
- Saved `75` matches OCR `75A12345`.

For longer saved plates, the app uses exact normalized matching.
