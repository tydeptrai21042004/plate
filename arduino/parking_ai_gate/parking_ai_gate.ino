#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Servo.h>

#define SS_PIN 10
#define RST_PIN 9

#define odo1 2
#define odo2 3
#define odo3 4
#define odo4 5

#define SERVO_IN_PIN 8
#define SERVO_OUT_PIN 7

Servo servoIn;
Servo servoOut;

LiquidCrystal_I2C lcd(0x27, 16, 2);
MFRC522 mfrc522(SS_PIN, RST_PIN);

String uidList[20];
int uidCount = 0;

String pendingUID = "";
String pendingAction = "";
String serialBuffer = "";

unsigned long lastScanTime = 0;
String lastScanUID = "";

// =====================================================
// UID LIST: used only to know IN/OUT state after web accepts
// =====================================================

int findUID(String uid) {
  for (int i = 0; i < uidCount; i++) {
    if (uidList[i] == uid) return i;
  }
  return -1;
}

void addUID(String uid) {
  if (uidCount >= 20) return;
  if (findUID(uid) != -1) return;

  uidList[uidCount] = uid;
  uidCount++;
}

void removeUID(int index) {
  if (index < 0 || index >= uidCount) return;

  for (int i = index; i < uidCount - 1; i++) {
    uidList[i] = uidList[i + 1];
  }
  uidCount--;
}

// =====================================================
// RFID
// =====================================================

String getUID() {
  String uid = "";

  for (byte i = 0; i < mfrc522.uid.size; i++) {
    char buffer[4];
    sprintf(buffer, "%02X", mfrc522.uid.uidByte[i]);
    uid += buffer;
  }

  return uid;
}

// =====================================================
// GATE
// =====================================================

void openGateIn() {
  servoIn.write(180);
  delay(2000);
  servoIn.write(140);
}

void openGateOut() {
  servoOut.write(0);
  delay(2000);
  servoOut.write(40);
}

// =====================================================
// LCD
// =====================================================

void showHome() {
  lcd.clear();
  lcd.setCursor(2, 0);
  lcd.print("Parking Area");
  lcd.setCursor(0, 1);
  lcd.print("Slot:");
}

void updateSlots() {
  lcd.setCursor(8, 1);
  lcd.print(digitalRead(odo1) == LOW ? "X" : "O");

  lcd.setCursor(7, 1);
  lcd.print(digitalRead(odo2) == LOW ? "X" : "O");

  lcd.setCursor(6, 1);
  lcd.print(digitalRead(odo3) == LOW ? "X" : "O");

  lcd.setCursor(5, 1);
  lcd.print(digitalRead(odo4) == LOW ? "X" : "O");
}

void showWaitingAI() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("RFID scanned");
  lcd.setCursor(0, 1);
  lcd.print("Wait AI check");
}

void showPlate(String title, String plate) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(title);
  lcd.setCursor(0, 1);

  if (plate.length() > 16) {
    lcd.print(plate.substring(0, 16));
  } else {
    lcd.print(plate);
  }
}

void showDenied(String reason) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("ACCESS DENIED");
  lcd.setCursor(0, 1);

  if (reason.length() > 16) {
    lcd.print(reason.substring(0, 16));
  } else {
    lcd.print(reason);
  }

  delay(2000);
  showHome();
}

// =====================================================
// SERIAL PROTOCOL
// Arduino sends to web browser:
//   RFID,IN,UID
//   RFID,OUT,UID
//
// Browser sends to Arduino:
//   OPEN_IN,UID,PLATE
//   OPEN_OUT,UID,PLATE
//   DENY,UID,REASON
// =====================================================

String getCsvField(String line, int index) {
  int current = 0;
  int start = 0;

  for (int i = 0; i <= line.length(); i++) {
    if (i == line.length() || line.charAt(i) == ',') {
      if (current == index) {
        return line.substring(start, i);
      }
      current++;
      start = i + 1;
    }
  }

  return "";
}

void clearPending() {
  pendingUID = "";
  pendingAction = "";
}

void processCommand(String line) {
  line.trim();
  if (line.length() == 0) return;

  String cmd = getCsvField(line, 0);
  String uid = getCsvField(line, 1);
  String value = getCsvField(line, 2);

  uid.trim();
  value.trim();

  if (pendingUID.length() > 0 && uid != pendingUID) {
    Serial.println("ERROR,UID_MISMATCH");
    return;
  }

  if (cmd == "OPEN_IN") {
    addUID(uid);
    showPlate("VAO OK", value);
    openGateIn();
    clearPending();
    showHome();
    Serial.println("DONE,OPEN_IN");
  }

  else if (cmd == "OPEN_OUT") {
    int index = findUID(uid);
    if (index != -1) {
      removeUID(index);
    }

    showPlate("RA OK", value);
    openGateOut();
    clearPending();
    showHome();
    Serial.println("DONE,OPEN_OUT");
  }

  else if (cmd == "DENY") {
    showDenied(value.length() > 0 ? value : "WRONG PLATE");
    clearPending();
    Serial.println("DONE,DENY");
  }

  else {
    Serial.print("ERROR,UNKNOWN_CMD,");
    Serial.println(cmd);
  }
}

void readSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n') {
      processCommand(serialBuffer);
      serialBuffer = "";
    } else if (c != '\r') {
      serialBuffer += c;

      if (serialBuffer.length() > 120) {
        serialBuffer = "";
      }
    }
  }
}

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(9600);

  SPI.begin();
  mfrc522.PCD_Init();

  lcd.init();
  lcd.backlight();

  servoIn.attach(SERVO_IN_PIN);
  servoOut.attach(SERVO_OUT_PIN);

  servoIn.write(140);
  servoOut.write(40);

  pinMode(odo1, INPUT_PULLUP);
  pinMode(odo2, INPUT_PULLUP);
  pinMode(odo3, INPUT_PULLUP);
  pinMode(odo4, INPUT_PULLUP);

  showHome();
  Serial.println("ARDUINO_READY");
}

// =====================================================
// LOOP
// =====================================================

void loop() {
  readSerialCommands();

  if (mfrc522.PICC_IsNewCardPresent() && mfrc522.PICC_ReadCardSerial()) {
    String uid = getUID();

    // Prevent duplicate scan spam.
    if (!(uid == lastScanUID && millis() - lastScanTime < 2500)) {
      lastScanUID = uid;
      lastScanTime = millis();

      int index = findUID(uid);
      pendingAction = (index == -1) ? "IN" : "OUT";
      pendingUID = uid;

      showWaitingAI();

      Serial.print("RFID,");
      Serial.print(pendingAction);
      Serial.print(",");
      Serial.println(uid);
    }

    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
  }

  if (pendingUID.length() == 0) {
    updateSlots();
  }
}
