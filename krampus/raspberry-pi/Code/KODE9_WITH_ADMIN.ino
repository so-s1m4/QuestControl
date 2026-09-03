#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
Adafruit_PWMServoDriver pwm0 = Adafruit_PWMServoDriver(&Wire, 0x40);
#include <SoftwareSerial.h>
SoftwareSerial mySerial(A14, 3); // RX, TX
SoftwareSerial mySerial2(A15, 12); // RX, TX
#include <Servo.h>
Servo myservo1;
Servo myservo2;
const uint8_t PIN_direction_TX_RX = 2;  // указываем номер вывода arduino, к которому подключены выводы RE и DE конвертирующего модуля
// ---- Pin map (typed constants) ----
static const uint8_t stilSensor1  = 40;
static const uint8_t stilSensor2  = 42;
static const uint8_t stilSensor3  = 44;
static const uint8_t stilSensor4  = 46;
static const uint8_t stilSensor0  = 48;
static const uint8_t sensorUp     = 26;
static const uint8_t sensorDown   = 28;
static const uint8_t cs           = A0;
static const uint8_t pwm          = 33;
static const uint8_t up           = 24;
static const uint8_t down         = 22;
static const uint8_t kontyrR      = 6;
static const uint8_t kontyrG      = 5;
static const uint8_t kontyrW      = 10;
static const uint8_t kontyrUV     = 11;
static const uint8_t pjatnashku   = A1;
static const uint8_t stypaSensor  = 52;
static const uint8_t tarilka1aSensor = 43;
static const uint8_t tarilka1bSensor = 45;
static const uint8_t tarilka2aSensor = 47;
static const uint8_t tarilka2bSensor = 49;
static const uint8_t tarilka3aSensor = 51;
static const uint8_t tarilka3bSensor = 53;
static const uint8_t tarilka4aSensor = 39;
static const uint8_t tarilka4bSensor = 41;
static const uint8_t parogen      = 30;
static const uint8_t pichkaUV     = 7;
static const uint8_t pichkaLight  = 13;
static const uint8_t pichkaMove   = 32;
static const uint8_t motyzka      = 50;
static const uint8_t ankhAktyator1 = 35;
static const uint8_t gorloAktyator = 23;
static const uint8_t irSensor     = A3;
static const uint8_t maskaGerkon  = A2;
static const uint8_t vedmidjGerkon = A4;
static const uint8_t pashchaSensor = A5;
static const uint8_t stil         = A6;
static const uint8_t strt         = A15;
static const uint8_t magnitKlitka = A11;

unsigned long zirkaTime;
unsigned long ss0time;
unsigned long ss1time;
unsigned long ss2time;
unsigned long ss3time;
unsigned long ss4time;
unsigned long krushkaTime;
unsigned long stypaTime;
unsigned long pjatnashkuTime;
unsigned long RlightTime;
unsigned long bluskavkaTime;
unsigned long tarilka1Time;
unsigned long tarilka2Time;
unsigned long tarilka3Time;
unsigned long tarilka4Time;
unsigned long motyzkaTime;
unsigned long mtzkTime;
unsigned long mskTime;
unsigned long mskLightTime;
unsigned long stlTime;
unsigned long rotTime;
unsigned long rtTime;
unsigned long irTime;
unsigned long lightTime;

byte zirka;
int bright0;
int bright1;
int bright2;
int bright3;
int bright4;
byte w;
byte ss0;
byte ss1;
byte ss2;
byte ss3;
byte ss4;
byte krushka;
byte brightLW;
byte uvMode = 0;  // 0 - обычный свет, 1 - режим УФ (всё остальное выключено)
byte ptnshk;
byte stypa;
byte bluskavka;
int del1;
int del2;
int i1;
byte tarilkuPlay;
byte tarilka1move;
byte tarilka2move;
byte tarilka3move;
byte tarilka4move;
byte trlk1;
byte trlk2;
byte trlk3;
byte trlk4;
byte pichkaBright;
byte mtzk;
byte mt;
byte msk;
byte mskL;
byte a;
byte ankh;
byte stl;
byte rot;
byte rt;
byte ir;
byte wasPulledOut;
byte shouldOpenDoorByBook;

// ---- ADMIN mode state ----
enum AdminMode : uint8_t { AM_GAME = 0, AM_ESTOP = 1 };
static AdminMode adminMode = AM_GAME;

enum LightMode : uint8_t {
  L_OFF,
  L_OK_FLASH_GREEN,  // короткая вспышка зеленым
  L_UV,              // UV режим (остальное вырубить)
  L_DEFAULT,
  L_LIGHT
};

static const __FlashStringHelper* adminModeName() {
  switch (adminMode) {
    case AM_GAME:  return F("GAME");
    case AM_ESTOP: return F("ESTOP");
  }
  return F("UNKNOWN");
}


LightMode currentLight = L_OFF;
unsigned long lightTs = 0;
const unsigned long FLASH_TIME = 300UL;
LightMode prevLight = L_DEFAULT;

// ---- ADMIN TABLE move state machine ----
enum TableMove : uint8_t { TM_IDLE = 0, TM_OPENING = 1, TM_CLOSING = 2 };
static TableMove tableMove = TM_IDLE;
static unsigned long tableMoveTs = 0;
static const unsigned long TABLE_MOVE_TIMEOUT = 12000UL; // safety timeout (ms)

static inline void tableStopMotor() {
  analogWrite(pwm, 0);
  digitalWrite(up, LOW);
  digitalWrite(down, LOW);
}
static inline void tableStartOpen() {
  digitalWrite(down, LOW);
  digitalWrite(up, HIGH);
  analogWrite(pwm, 150);
  tableMove = TM_OPENING;
  tableMoveTs = millis();
}
static inline void tableStartClose() {
  digitalWrite(up, LOW);
  digitalWrite(down, HIGH);
  analogWrite(pwm, 150);
  tableMove = TM_CLOSING;
  tableMoveTs = millis();
}

// Table leg latch: channel 13 holds the magnet, channel 14 is its indicator LED.
static inline void setTableLegReleased(bool released) {
  pwm0.setPWM(13, 0, released ? 0 : 4095);
  pwm0.setPWM(14, 0, released ? 4095 : 0);
}

// ---- Limit switches helpers (wired as INPUT_PULLUP, so PRESSED = LOW) ----
static inline bool isTableAtTop()    { return digitalRead(sensorUp)   == HIGH; }
static inline bool isTableAtBottom() { return digitalRead(sensorDown) == HIGH; }


// ---- Forward declarations (needed because we call these before definitions) ----
void execute_CMD(byte CMD, byte Par1, byte Par2, int l);
void adminStatus();
void adminSensors();
void adminStart();
void adminReset();
void adminEstop();
void adminLight(char* act, char* args);
void adminOven(char* act, char* args);
void adminPuzzle(char* act);
void adminBear(char* act);
void adminMask(char* act);
void adminDoor(char* act);
void adminTable(char* act, char* args);

static inline void updateAdminTableMove() {
  if (tableMove == TM_IDLE) return;

  // Stop at limit switches (PRESSED = LOW)
  if (tableMove == TM_OPENING) {
    if (isTableAtTop()) {
      tableStopMotor();
      tableMove = TM_IDLE;
      Serial.println(F("OK TABLE OPENED"));
      return;
    }
  } else if (tableMove == TM_CLOSING) {
    if (isTableAtBottom()) {
      tableStopMotor();
      tableMove = TM_IDLE;
      Serial.println(F("OK TABLE CLOSED"));
      return;
    }
  }

  // Safety timeout
  if (millis() - tableMoveTs > TABLE_MOVE_TIMEOUT) {
    tableStopMotor();
    tableMove = TM_IDLE;
    Serial.println(F("ERR TABLE TIMEOUT"));
    return;
  }
}

// ---- FULL RESET helper (game + hardware safe state) ----
static void fullResetAll() {
  // Stop any admin/auto table movement first
  tableMove = TM_IDLE;
  tableStopMotor();

  // Stop all sounds on all players
  // 0x0E is used in this sketch as STOP (see other calls)
  execute_CMD(0x0E, 0, 0, 1);
  execute_CMD(0x0E, 0, 0, 2);
  execute_CMD(0x0E, 0, 0, 3);
  execute_CMD(0x0E, 0, 0, 4);

  // Stop outputs / actuators to a known safe baseline
  digitalWrite(up, LOW);
  digitalWrite(down, LOW);

  digitalWrite(parogen, LOW);
  digitalWrite(pichkaUV, LOW);
  digitalWrite(pichkaLight, LOW);
  digitalWrite(pichkaMove, HIGH);   // HIGH = привод OFF (см. handlePichka)

  digitalWrite(gorloAktyator, LOW);
  digitalWrite(ankhAktyator1, LOW);

  // Lock door by default
  digitalWrite(magnitKlitka, HIGH);
  shouldOpenDoorByBook = 0;

  // PCA9685 baseline (off everything except magnets that should hold)
  setStarAll(0);
  pwm0.setPWM(8, 0, 0);
  pwm0.setPWM(7, 0, 0);
  pwm0.setPWM(10, 0, 0);
  // Lock chest + table leg magnet and turn its indicator LED off.
  pwm0.setPWM(15, 0, 4095);
  setTableLegReleased(false);

  // Reset game variables/state machines
  initGameVars();
  a = 0; // enter RESET mode (a==0)
  brightLW = 0;
  bluskavka = 0;

  // Force table lid to close on reset sequence
  krushka = 11;

  // Reset admin mode
  adminMode = AM_GAME;
  // Keep AM_GAME so loop() keeps running reset logic; gameplay is controlled by a==0

  // On reset we want full WHITE light
  setLightMode(L_LIGHT);

  // Reset servos to CLOSED position (safe)
  // (On boot, fullResetAll() can run before attach(), so guard it)
  if (myservo1.attached() || myservo2.attached()) {
    digitalWrite(ankhAktyator1, HIGH);
    if (myservo1.attached()) myservo1.write(5);
    if (myservo2.attached()) myservo2.write(163);
    delay(100);
    digitalWrite(ankhAktyator1, LOW);
  }
}


void setLightMode(LightMode m) {

  if (m == L_OK_FLASH_GREEN && currentLight != L_OK_FLASH_GREEN) {
    prevLight = currentLight;   // запомнили прошлый режим
  }

  currentLight = m;
  lightTs = millis();

  switch (m) {
    case L_OFF:
      analogWrite(kontyrUV, 255);
      analogWrite(kontyrR, 255);
      analogWrite(kontyrG, 255);
      analogWrite(kontyrW, 255);
      break;

    case L_LIGHT:
      analogWrite(kontyrUV, 0);
      analogWrite(kontyrR, 0);
      analogWrite(kontyrG, 0);
      analogWrite(kontyrW, 0);
      break;

    case L_DEFAULT:
      analogWrite(kontyrUV, 255);
      analogWrite(kontyrR, 0);
      analogWrite(kontyrG, 255);
      analogWrite(kontyrW, 255);
      break;

    case L_OK_FLASH_GREEN:
        analogWrite(kontyrUV, 255);   // UV точно OFF
        analogWrite(kontyrR, 255);
        analogWrite(kontyrG, 0);
        analogWrite(kontyrW, 255);
        break;

    case L_UV:
      analogWrite(kontyrR, 255);
      analogWrite(kontyrG, 255);
      analogWrite(kontyrW, 255);
      analogWrite(kontyrUV, 0);     // UV ON
      break;
  }
}

void updateLight() {
  if (currentLight == L_OK_FLASH_GREEN) {
    if (millis() - lightTs >= FLASH_TIME) {
      setLightMode(prevLight);  // возврат туда, где были
    }
  }
}

// ---- Setup helper: init all pullup inputs ----
static const uint8_t INPUT_PULLUP_PINS[] = {
  stilSensor0, stilSensor1, stilSensor2, stilSensor3, stilSensor4,
  sensorUp, sensorDown,
  stypaSensor,
  tarilka1aSensor, tarilka1bSensor,
  tarilka2aSensor, tarilka2bSensor,
  tarilka3aSensor, tarilka3bSensor,
  tarilka4aSensor, tarilka4bSensor,
  motyzka,
  maskaGerkon, vedmidjGerkon, pashchaSensor,
  stil,
  strt
};

static inline void initInputsPullup() {
  for (uint8_t i = 0; i < sizeof(INPUT_PULLUP_PINS)/sizeof(INPUT_PULLUP_PINS[0]); i++) {
    pinMode(INPUT_PULLUP_PINS[i], INPUT_PULLUP);
  }
}
static inline void initGameVars() {
  zirka = 0;
  bright0 = bright1 = bright2 = bright3 = bright4 = 0;
  brightLW = 0;
  w = 0;
  ss0 = ss1 = ss2 = ss3 = ss4 = 0;
  krushka = 0;
  ptnshk = 0;
  stypa = 4;
  bluskavka = 0;

  tarilkuPlay = 1;
  tarilka1move = tarilka2move = tarilka3move = tarilka4move = 0;
  trlk1 = trlk2 = trlk3 = trlk4 = 0;

  pichkaBright = 0;
  mtzk = 0; mt = 0;
  msk = 0; mskL = 0;
  stl = 0; rot = 0; rt = 0; ir = 0;

  ankh = 0;
  wasPulledOut = 0;
  uvMode = 0;
}
// ---- Helpers for PCA9685 channels ----
static inline void setStarAll(uint16_t value) {
  for (uint8_t ch = 0; ch < 5; ch++) {
    pwm0.setPWM(ch, 0, value);
  }
}

static inline void setStarAllFromByte(uint8_t b, uint8_t mul) {
  const uint16_t v = (uint16_t)b * (uint16_t)mul;
  setStarAll(v);
}

void setup() {
  pinMode(PIN_direction_TX_RX, OUTPUT);      // устанавливаем режим работы вывода PIN_direction_TX_RX, как "выход"
  digitalWrite(PIN_direction_TX_RX, LOW);    // устанавливаем уровень логического «0» на выводе PIN_direction_TX_RX (переводим модуль в режим приёма данных)
  pwm0.begin();
  pwm0.setPWMFreq(1600);  // Set to whatever you like, we don't use it in this demo!
  //Wire.setClock(400000);
  pinMode(pwm, OUTPUT);
  pinMode(up, OUTPUT);
  digitalWrite(up, LOW);
  pinMode(down, OUTPUT);
  digitalWrite(down, LOW);
  pinMode(parogen, OUTPUT);
  digitalWrite(parogen, LOW);
  pinMode(pichkaUV, OUTPUT);
  digitalWrite(pichkaUV, LOW);
  pinMode(pichkaLight, OUTPUT);
  digitalWrite(pichkaLight, LOW);
  pinMode(kontyrR, OUTPUT);
  analogWrite(kontyrR, LOW);
  pinMode(kontyrG, OUTPUT);
  digitalWrite(kontyrG, LOW);
  pinMode(pichkaMove, OUTPUT);
  digitalWrite(pichkaMove, HIGH);
  pinMode(ankhAktyator1, OUTPUT);
  digitalWrite(ankhAktyator1, LOW);
  pinMode(kontyrUV, OUTPUT);
  pinMode(gorloAktyator, OUTPUT);
  pinMode(magnitKlitka, OUTPUT);
  digitalWrite(magnitKlitka, HIGH);
  initInputsPullup();
  digitalWrite(gorloAktyator, LOW);
  
  Serial.begin(9600);
  Serial1.begin(9600);
  Serial2.begin(9600);
  Serial3.begin(9600);
  mySerial.begin(9600);
  mySerial2.begin(9600);
  initGameVars();
  // Ensure everything is in a known safe baseline on boot
  fullResetAll();
  brightLW = 0;
  execute_CMD(0x06, 0, 0x40,1); // Set the volume (0x00~0x30)
  execute_CMD(0x06, 0, 0x40,2);  // Set the volume (0x00~0x30)
  execute_CMD(0x06, 0, 0x40,3);  // Set the volume (0x00~0x30)
  delay(100);
  krushka = 11;  //Закриваємо кришку
  pwm0.setPWM(15, 0, 4095);  //Вмикаєм магніт скрині
  pwm0.setPWM(13, 0, 4095); //Вмикаєм магніт ніжки стола
  myservo1.attach(34);
  myservo2.attach(36);
  digitalWrite(ankhAktyator1, HIGH);
  myservo1.write(5);
  myservo2.write(163);
  delay(2000);
  digitalWrite(ankhAktyator1, LOW);
  digitalWrite(PIN_direction_TX_RX, HIGH);
  delay(2);
  Serial.write('B');
  delay(2);
  digitalWrite(PIN_direction_TX_RX, LOW);
}
void loop() {
  processAdminSerial();
  updateAdminTableMove();
  if (adminMode == AM_ESTOP) {
    updateLight();
    return;
  }

  // ------------------ Режим reset (a == 0) ------------------
  if (a == 0) {
    handleResetMode();
  }
  // Кнопка старту (локальний старт без команди по Serial)
  if (a == 0 && digitalRead(strt) == LOW) {
    delay(5);
    if (digitalRead(strt) == LOW) {
      a = 1;
      // Ensure table lid state machine is in the initial state for the star puzzle
      tableStopMotor();
      krushka = 0;
      execute_CMD(0x0F, 1, 1, 1);   // Фон 1
      pwm0.setPWM(8, 0, 1024);      // Зелена підсвітка тумби з анкхами
      pwm0.setPWM(10, 0, 100);      // Червона підсвітка очей маски

      setLightMode(L_DEFAULT);

      digitalWrite(PIN_direction_TX_RX, HIGH);
      delay(2);
      Serial.write('A');
      delay(2);
      digitalWrite(PIN_direction_TX_RX, LOW);
    }
  }
  // ------------------ Режим гри (a == 1) ------------------
  if (a == 1) {
    handleGameMode();
  }
}



// --- GAME LOGIC ---
void handleGameMode() {
    updateLight();
    handleBearHead();
    handleIR();
    handleStol();
    handleMask();
    handlePlates();
    handleMotuzka();
    handlePichka();
    handlePyatnashki();
    handleStarAndLid();
    handleLightning();
    handleStarAnimation();
}
void handleResetMode() {
  // If admin is moving the table, don't let reset-logic fight the motor
  if (tableMove != TM_IDLE) return;
  // ---------------- Мотузка + анкх ----------------
  if (ankh == 0 && mtzk == 0 && digitalRead(motyzka) == LOW) {
    mtzk       = 1;
    motyzkaTime = millis();
  }

  if (mtzk == 1 && millis() - motyzkaTime > 5) {
    if (digitalRead(motyzka) == LOW) {
      mtzk      = 2;
      motyzkaTime = millis();
      mtzkTime  = millis();
      pwm0.setPWM(8, 0, 1000);  // Зелена підсвітка тумби з анкхами
      pwm0.setPWM(7, 0, 1000);  // Червона підсвітка тумби з анкхами
    } else {
      mtzk = 0;
    }
  }

  if (mtzk == 2) {
    if (mt == 0 && millis() - mtzkTime > 500) {
      pwm0.setPWM(8, 0, 0);
      pwm0.setPWM(7, 0, 0);
      mtzkTime = millis();
      mt       = 1;
    }

    if (mt == 1 && millis() - mtzkTime > 500) {
      pwm0.setPWM(8, 0, 1000);
      pwm0.setPWM(7, 0, 1000);
      mtzkTime = millis();
      mt       = 0;
    }

    if (millis() - motyzkaTime > 5000) {
      pwm0.setPWM(8, 0, 0);
      pwm0.setPWM(7, 0, 0);
      digitalWrite(ankhAktyator1, HIGH);
      myservo1.write(180);
      myservo2.write(0);
      ankh      = 1;
      mt        = 0;
      mtzk      = 3;
      motyzkaTime = millis();
    }
  }

  if (mtzk == 3 && millis() - motyzkaTime > 2000) {
    mtzk = 0;
    digitalWrite(ankhAktyator1, LOW);
  }

  // ---------------- Кришка стола: на RESET закрываем и возвращаем krushka в 0 ----------------
  // krushka = 11 -> начинаем закрытие, krushka = 12 -> ждём концевик/таймаут
  if (krushka == 11) {
    // If already at bottom, just finish reset state
    if (isTableAtBottom()) {
      tableStopMotor();
      krushka = 0;
    } else {
      krushka = 12;
      digitalWrite(up, LOW);
      digitalWrite(down, HIGH);
      analogWrite(pwm, 150);
      krushkaTime = millis();
    }
  }

  if (krushka == 12) {
    // Stop when bottom limit reached
    if (isTableAtBottom()) {
      tableStopMotor();
      krushka = 0;
    }
    // Safety timeout (if something is wrong, still stop motor)
    else if (millis() - krushkaTime > 7000) {
      tableStopMotor();
      krushka = 0;
    }
  }
}

void handleBearHead() {
    if(rot == 0 && analogRead(A5) > 200){
      rot = 1;
      rotTime = millis();
    }
    if(rot == 1 && millis() - rotTime > 5){
      if(analogRead(A5) > 200){
        rot = 2;
        execute_CMD(0x0F,1,2,3);
        rtTime = millis();
      } else rot = 0;
    }
    if(rot == 2 && millis() - rtTime > 25){
      rt++;
      pwm0.setPWM(8, 0, 4000 - rt*100);
      pwm0.setPWM(7, 0, 100*rt);
      rtTime = millis();
      if(rt == 40) rot = 3;
    }
    if(rot == 3 && analogRead(A5) < 100){
      rot = 4;
      rotTime = millis();
    }
    if(rot == 4 && millis() - rotTime > 5){
      if(analogRead(A5) < 100){
        rot = 5;
      } else rot = 3;
    }
    if(rot == 5 && millis() - rtTime > 10){
      rt--;
      pwm0.setPWM(8, 0, 4000 - rt*100);
      pwm0.setPWM(7, 0, 100*rt);
      rtTime = millis();
      if(rt == 0) rot = 0;
    }
}

void handleIR(){
    if(ir == 0 && rot != 0 && digitalRead(irSensor) == LOW){
      execute_CMD(0x0F,1,3,3);
      irTime = millis();
      digitalWrite(gorloAktyator, HIGH);
      ir = 1;
    }
    if(ir == 1 && millis() - irTime > 400){
      ir = 2;
      irTime = millis();
      digitalWrite(gorloAktyator, LOW);
    }
    if(ir == 2){
      if(rot == 0) ir = 0;
    }
}

void handleStol() {
    if(stl == 0 && digitalRead(vedmidjGerkon) == LOW){
      stl = 1;
      stlTime = millis();
    }
    if(stl == 1 && millis() - stlTime > 5){
      if(digitalRead(vedmidjGerkon) == LOW){
        stl = 2;
        setTableLegReleased(true);
        execute_CMD(0x0F,1,14,2);
        setLightMode(L_OK_FLASH_GREEN);
      } else stl = 0;
    }
}

void handleMask(){
    if(msk == 0 && digitalRead(maskaGerkon) == LOW){
      msk = 1;
      mskTime = millis();
    }
    if(msk == 1 && millis() - mskTime > 5){
      if(digitalRead(maskaGerkon) == LOW){
        msk = 2;
        mskTime = millis();
        mskLightTime = millis();
        execute_CMD(0x0F,1,1,4);
      } else msk = 0;
    }
    if(msk == 2){
      if(mskL < 25 && millis() - mskLightTime > 75 && millis() - mskTime < 5000){
        mskL++;
        pwm0.setPWM(10, 0, 100 + mskL * 150);
        mskLightTime = millis();
      }
      if(mskL > 0 && millis() - mskLightTime > 40 && millis() - mskTime > 5000){
        mskL--;
        pwm0.setPWM(10, 0, 100 + mskL * 150);
        mskLightTime = millis();
      }
      if(millis() - mskTime > 6500){
        msk = 0;
      }
    }
}
static inline bool othersIdle(byte a, byte b, byte c) { return a == 0 && b == 0 && c == 0; }
static inline void handlePlate(
  uint8_t sensorA,
  byte track,
  byte &moveState,
  unsigned long &tPulse,
  byte &trlk,
  byte &tarilkuPlay,
  unsigned long &lightTime
) {
  if (moveState == 0 && digitalRead(sensorA) == LOW) {
    moveState = 1;
    tPulse = millis();
  }

  if (moveState == 1 && digitalRead(sensorA) == HIGH) {
    moveState = 2;
  }

  if (moveState == 2 && digitalRead(sensorA) == LOW) {
    moveState = 1;

    if (millis() - tPulse < 1000) {
      if (tarilkuPlay == 1) {
        execute_CMD(0x0F, 1, track, 2);
        trlk = 1;
        tarilkuPlay = 2;
        lightTime = millis();
      }
    }
    tPulse = millis();
  }
}

void handlePlates() {
    // Тарілка 1
    if (othersIdle(trlk2, trlk3, trlk4)) {
      handlePlate(tarilka1aSensor, 9, tarilka1move, tarilka1Time, trlk1, tarilkuPlay, lightTime);
      if (tarilkuPlay == 2 && millis() - tarilka1Time > 1000) {
        execute_CMD(0x0E, 0, 0, 2);
        tarilkuPlay = 1;
        trlk1 = 2;
        lightTime = millis();
      }
      if (trlk1 >= 2 && millis() - lightTime > 3) {
        lightTime = millis();
        trlk1++;
        if (trlk1 == 255) trlk1 = 0;
      }
    }

    // Тарілка 2
    if (othersIdle(trlk1, trlk3, trlk4)) {
      handlePlate(tarilka2aSensor, 10, tarilka2move, tarilka2Time, trlk2, tarilkuPlay, lightTime);
      if (tarilkuPlay == 2 && millis() - tarilka2Time > 1000) {
        execute_CMD(0x0E, 0, 0, 2);
        trlk2 = 0;
        tarilkuPlay = 1;
      }
    }

    // Тарілка 3
    if (othersIdle(trlk1, trlk2, trlk4)) {
      handlePlate(tarilka3aSensor, 11, tarilka3move, tarilka3Time, trlk3, tarilkuPlay, lightTime);
      if (tarilkuPlay == 2 && millis() - tarilka3Time > 1000) {
        execute_CMD(0x0E, 0, 0, 2);
        trlk3 = 0;
        tarilkuPlay = 1;
      }
    }

    // Тарілка 4
    if (othersIdle(trlk1, trlk2, trlk3)) {
      handlePlate(tarilka4aSensor, 12, tarilka4move, tarilka4Time, trlk4, tarilkuPlay, lightTime);
      if (tarilkuPlay == 2 && millis() - tarilka4Time > 1000) {
        execute_CMD(0x0E, 0, 0, 2);
        trlk4 = 0;
        tarilkuPlay = 1;
      }
    }

    // --- Всі тарілки в правильному положенні / UV режим ---
    if (digitalRead(tarilka1bSensor) == LOW &&
        digitalRead(tarilka2bSensor) == LOW &&
        digitalRead(tarilka3bSensor) == LOW &&
        digitalRead(tarilka4bSensor) == LOW) {

      if (tarilkuPlay < 3) {
        tarilkuPlay = 3;
        trlk1       = 0;
        trlk2       = 0;
        trlk3       = 0;
        trlk4       = 0;
        tarilka4Time = millis();
      }
    } else {
      if (tarilkuPlay == 5) {
        tarilkuPlay = 1;
        setLightMode(L_DEFAULT);
      }
    }

    if (tarilkuPlay == 3 && millis() - tarilka4Time > 100) {
      tarilkuPlay = 4;
      tarilka4Time = millis();
      execute_CMD(0x0F, 1, 13, 2);  //Звуковий ефект 13
      setLightMode(L_UV);
      
    }

    if (tarilkuPlay == 4 && millis() - tarilka4Time > 1000) {
      tarilkuPlay = 5;
    }
}

void handleMotuzka(){
    if(mtzk == 0 && digitalRead(motyzka) == LOW){
      mtzk = 1;
      motyzkaTime = millis();
    }
    if(mtzk == 1 && millis() - motyzkaTime > 5){
      if(digitalRead(motyzka) == LOW){
        mtzk = 2;
        motyzkaTime = millis();
        execute_CMD(0x0F,1,1,3);
        pwm0.setPWM(8, 0, 0);
        pwm0.setPWM(7, 0, 1024);
        digitalWrite(ankhAktyator1, HIGH);
        myservo1.write(5);
        myservo2.write(163);
        setLightMode(L_OK_FLASH_GREEN);
        ankh = 0;
      }
      else mtzk = 0;
    }
    if(mtzk == 2 && millis() - motyzkaTime > 5000){
      mtzk = 0;
      pwm0.setPWM(8, 0, 1024);
      pwm0.setPWM(7, 0, 0);
      digitalWrite(ankhAktyator1, LOW);
    }
}



void pichkaNormal(){
  execute_CMD(0x0F, 1, 8, 2);   // звук котелка 
  digitalWrite(parogen, HIGH);  // парогенератор ON
  digitalWrite(pichkaMove, LOW); // привод камина ON
  digitalWrite(pichkaLight, HIGH);
  digitalWrite(pichkaUV, LOW);  // UV точно OFF
}
void pichkaSolved(){
    digitalWrite(pichkaLight, LOW);
    digitalWrite(pichkaUV, HIGH);   // включаем UV печки
    digitalWrite(parogen, LOW);
    digitalWrite(pichkaMove, HIGH);
    execute_CMD(0x0E, 1, 8, 2);   // стоп звук котелка
    // pcaWrite(CH_FAN, 0);          // вентилятор OFF
}
void handlePichka() {
  // stypa – состояние автомата печки:
  // 0 – ступа вынута, загадка не решена
  // 1 – антидребезг "ступу вставили"
  // 2 – ступа вставлена, загадка решена
  // 3 – антидребезг "ступу вытащили"
  // 4 – вход в состояние "загадка не решена"

  static unsigned long stypaStableTime = 0;
  static const unsigned long STYPA_DEBOUNCE_MS = 50UL;

  bool stepIn = (digitalRead(stypaSensor) == HIGH);  // HIGH = ступа стоит на датчике

  switch (stypa) {
    case 0: // Ступа вынута: загадка не решена
      if (stepIn) {
        stypa = 1;
        stypaStableTime = millis();
      }
      break;

    case 1: // Антидребезг при вставке
      if (!stepIn) {
        stypa = 0;
        break;
      }
      if (millis() - stypaStableTime > STYPA_DEBOUNCE_MS) {
        stypa = 2;
        pichkaSolved();
        setLightMode(L_OK_FLASH_GREEN);
      }
      break;

    case 2: // Ступа вставлена: загадка решена, ждём вынимания
      if (!stepIn) {
        stypa = 3;
        stypaStableTime = millis();
      }
      break;

    case 3: // Антидребезг при вынимании
      if (stepIn) {
        stypa = 2;
        break;
      }
      if (millis() - stypaStableTime > STYPA_DEBOUNCE_MS) {
        stypa = 4;
      }
      break;

    case 4: // Включаем обычный режим один раз при старте/вынимании
      pichkaBright = 0;
      pichkaNormal();
      stypa = 0;
      if (stepIn) {
        stypa = 1;
        stypaStableTime = millis();
      }
      break;

    // case 1: // Антидребезг при вставке
    //   if (!stepIn) {
    //     // передумали / дребезг – назад в ожидание
    //     stypa = 0;
    //     break;
    //   }
    //   if (millis() - stypaStableTime > 50) {  // 50 мс стабильно HIGH
    //     // Запуск эффекта печки
    //     stypa = 2;
    //     stypaTime = millis();
    //     pichkaBright = 0;

    //     execute_CMD(0x0F, 1, 8, 2);   // звук котелка
    //     digitalWrite(parogen, HIGH);  // парогенератор ON
    //     digitalWrite(pichkaMove, LOW); // привод камина ON

    //     analogWrite(pichkaLight, 0);  // начинаем с нуля
    //     digitalWrite(pichkaLight, LOW);
    //     digitalWrite(pichkaUV, LOW);  // UV точно OFF
    //   }
    //   break;

    // case 2: // Разгорается огонь, ступа стоит
    //   if (!stepIn) {
    //     // Ступу слишком рано вытащили – считаем, что загадка не выполнена, всё гасим
    //     stypa = 0;
    //     digitalWrite(parogen, LOW);
    //     digitalWrite(pichkaMove, HIGH);
    //     digitalWrite(pichkaLight, LOW);
    //     digitalWrite(pichkaUV, LOW);
    //     // pcaWrite(CH_FAN, 0);
    //     break;
    //   }

    //   if (millis() - stypaTime > 30) { // плавный разгон света
    //     stypaTime = millis();
    //     if (pichkaBright < 255) {
    //       pichkaBright++;
    //       analogWrite(pichkaLight, pichkaBright);
    //     } else {
    //       // свет разгорелся полностью – ждём вытаскивания ступы
    //       stypa = 3;
    //     }
    //   }
    //   break;

    // case 3: // Ступа стоит, печка горит, ждём, когда её вытащат
    //   if (!stepIn) {
    //     stypa = 4;
    //     stypaStableTime = millis();
    //   }
    //   break;

    // case 4: // Антидребезг при вынимании ступы
    //   if (stepIn) {
    //     // передумали / дребезг – вернулись в состояние "ждём вытаскивания"
    //     stypa = 3;
    //     break;
    //   }
    //   if (millis() - stypaStableTime > 50) {  // 50 мс стабильно LOW
    //     // Считаем, что ступу точно вынули → финал сцены
    //     stypa = 0;

    //     digitalWrite(pichkaLight, LOW);
    //     digitalWrite(pichkaUV, HIGH);   // включаем UV печки
    //     digitalWrite(parogen, LOW);
    //     digitalWrite(pichkaMove, HIGH);
    //     execute_CMD(0x0E, 1, 8, 2);   // стоп звук котелка
    //     setLightMode(L_OK_FLASH_GREEN);
    //     // pcaWrite(CH_FAN, 0);          // вентилятор OFF
    //   }
    //   break;

  }
}

void handlePyatnashki(){
    if(ptnshk == 0 && analogRead(pjatnashku) <= 428){
      ptnshk = 1;
      pjatnashkuTime = millis();
    }
    if(ptnshk == 1 && millis() - pjatnashkuTime > 5){
      if(analogRead(pjatnashku) <= 428){
        ptnshk = 2;
        setLightMode(L_OK_FLASH_GREEN);
        execute_CMD(0x0F,1,7,2);
        pwm0.setPWM(15, 0, 0);        // Магніт скрині выкл
      }
      else ptnshk = 0;
    }
}

void handleLightning(){
    if(bluskavka > 0){
      if(bluskavka == 1){
        del1 = random(10, 15);
        del2 = random(15, 40);
        i1 = random(1,3);
        bluskavka = 2;
        bluskavkaTime = millis();
      }
      if(bluskavka == 2 && millis() - bluskavkaTime > del2){
        setLightMode(L_DEFAULT);
        setStarAll(4095);
        bluskavka = 3;
        bluskavkaTime = millis();
      }
      if(bluskavka == 3 && millis() - bluskavkaTime > del1){
        setLightMode(L_OFF);
        setStarAll(0);
        bluskavka = 4;
        bluskavkaTime = millis();
        i1--;
        if(i1 < 0){
          bluskavka = 2;
          del1 = random(10, 15);
          del2 = random(15, 40);
          i1 = random(1,3);
        }
      }
      if(bluskavka == 4 && millis() - bluskavkaTime > del1){
        setLightMode(L_OFF);
        setStarAll(0);
        bluskavka = 3;
        bluskavkaTime = millis();
      }
    }
}

static inline void handleStarSegment(uint8_t sensorPin, uint8_t pcaCh, uint8_t soundTrack,
                                     byte &ss, unsigned long &ssTimeRef) {
  if (pcaCh == 1 && !shouldOpenDoorByBook && digitalRead(sensorPin) == LOW) {
    shouldOpenDoorByBook = 1;
  }
  if (pcaCh == 1 && shouldOpenDoorByBook && digitalRead(sensorPin) == HIGH) {
    digitalWrite(magnitKlitka, LOW);
  }
  if (ss == 0 && digitalRead(sensorPin) == LOW) {
    delay(1);
    if (digitalRead(sensorPin) == LOW) {
      execute_CMD(0x0F, 1, soundTrack, 2);
      setLightMode(L_OK_FLASH_GREEN);
      pwm0.setPWM(pcaCh, 0, 1000);
      ss = 1;
      ssTimeRef = millis();
    }
  }

  if (ss == 1 && millis() - ssTimeRef > 7000) ss = 2;

  if (ss == 2 && digitalRead(sensorPin) == HIGH) {
    delay(1);
    if (digitalRead(sensorPin) == HIGH) {
      pwm0.setPWM(pcaCh, 0, 0);
      ss = 0;
    }
  }
}
void handleStarAndLid() {
  // --- Зірка на столі (5 сегментів) поки krushka == 0 ---
  if (krushka == 0) {
    // 5 сегментів зірки
    handleStarSegment(stilSensor0, 0, 2, ss0, ss0time);
    handleStarSegment(stilSensor1, 1, 1, ss1, ss1time);
    handleStarSegment(stilSensor2, 2, 3, ss2, ss2time);
    handleStarSegment(stilSensor3, 3, 4, ss3, ss3time);
    handleStarSegment(stilSensor4, 4, 5, ss4, ss4time);
    // Всі п'ять сегментів активовані → старт сцени з кришкою
    if (krushka == 0 &&
        ss0 == 2 && ss1 == 2 &&
        ss2 == 2 && ss3 == 2 &&
        ss4 == 2) {
      execute_CMD(0x0F, 1, 6, 2);  // звук "успіх"
      krushka = 1;
      zirka   = 11;                // старт мерехтіння зірки
    }
  }
  // --- Стан машини krushka (кришка стола + глобальне світло) ---
  if (krushka > 0) {
    // krushka = 1 → 2: почати повільний перехід у червоне
    if (krushka == 1) {
      krushka    = 2;
      krushkaTime = millis();
    }

    // krushka = 2: чекаємо 8 сек, потім блискавка + підйом кришки
    if (krushka == 2 && millis() - krushkaTime > 8000) {
      krushka    = 3;
      bluskavka  = 1;             // handleLightning() підхопить
      zirka      = 0;             // старий режим зірки гасимо
      digitalWrite(down, LOW);
      digitalWrite(up, HIGH);
      analogWrite(pwm, 150);
      
      krushkaTime = millis();
    }

    // krushka = 3: чекаємо спрацювання верхнього датчика
    if (krushka == 3 && isTableAtTop()) {
      krushkaTime = millis();
      krushka     = 4;
    }

    // Аварія: кришка не піднялася за 8 сек
    if (krushka == 3 && millis() - krushkaTime > 8000) {
      krushka = 100;              // проміжний "сервісний" стан
      digitalWrite(up, LOW);
      krushka = 5;
      krushkaTime = millis();
    }

    // krushka = 4: ще трішки тримаємо, потім стоп підйом
    if (krushka == 4 && millis() - krushkaTime > 1 && isTableAtTop()) {
      krushka = 5;
      digitalWrite(up, LOW);
      krushkaTime = millis();
    }

    // krushka = 5: гасимо все світло, готуємо плавне вмикання білого
    if (krushka == 5 && millis() - krushkaTime > 100) {
      krushka   = 6;
      bluskavka = 0;              // вимикаємо блискавку

      analogWrite(kontyrR, 255);
      analogWrite(kontyrG, 255);
      analogWrite(kontyrW, 255);

      setStarAll(0);

      krushkaTime = millis();
    }

    // krushka = 6: плавно піднімаємо білий і зірку
    if (krushka == 6 && millis() - krushkaTime > 40) {
      brightLW++;
      analogWrite(kontyrR, 255-brightLW);
      analogWrite(kontyrG, 255-brightLW);
      analogWrite(kontyrW, 255-brightLW);

      setStarAllFromByte(brightLW, 7);

      if (brightLW == 150) {
        krushka = 7;
        zirka   = 1;              // запуск хвилеподібної анімації зірки
      }
      krushkaTime = millis();
    }

    // krushka == 7 – фінальний стан сцени, логіка тут може не мінятись
  }
}
void handleStarAnimation() {
    if (zirka > 0) { //функція мерехтіння зірки
      // Режим випадкового мерехтіння (zirka = 11..14)
      if (zirka == 11) {
        del1 = random(10, 15);
        del2 = random(15, 40);
        i1   = random(1, 3);
        zirka = 12;
        zirkaTime = millis();
      }
      if (zirka == 12 && millis() - zirkaTime > del2) {
        setStarAll(250);
        zirka = 13;
        zirkaTime = millis();
      }
      if (zirka == 13 && millis() - zirkaTime > del1) {
        setStarAll(1000);
        zirka = 14;
        zirkaTime = millis();
        i1--;
        if (i1 < 0) {
          zirka = 12;
          del1 = random(10, 15);
          del2 = random(15, 40);
          i1   = random(1, 3);
        }
      }
      if (zirka == 14 && millis() - zirkaTime > del1) {
        setStarAll(1000);
        zirka = 13;
        zirkaTime = millis();
      }

      // Хвильова анімація зірки (zirka = 1..9)
      if (zirka == 1) {
        zirka = 2;
        zirkaTime = millis();
      }
      if (zirka == 2 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright0   = bright0 + 10;
        pwm0.setPWM(0, 0, bright0);
        if (bright0 == 2050) zirka = 3;
      }
      if (zirka == 3 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright0   = bright0 + 10;
        pwm0.setPWM(0, 0, bright0);
        bright1   = bright1 + 10;
        pwm0.setPWM(1, 0, bright1);
        if (bright0 == 4090) zirka = 4;
      }
      if (zirka == 4 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright0   = bright0 - 10;
        pwm0.setPWM(0, 0, bright0);
        bright1   = bright1 + 10;
        pwm0.setPWM(1, 0, bright1);
        bright2   = bright2 + 10;
        pwm0.setPWM(2, 0, bright2);
        if (bright1 == 4090) zirka = 5;
      }
      if (zirka == 5 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright0   = bright0 - 10;
        pwm0.setPWM(0, 0, bright0);
        bright1   = bright1 - 10;
        pwm0.setPWM(1, 0, bright1);
        bright2   = bright2 + 10;
        pwm0.setPWM(2, 0, bright2);
        bright3   = bright3 + 10;
        pwm0.setPWM(3, 0, bright3);
        if (bright2 == 4090) zirka = 6;
      }
      if (zirka == 6 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright1   = bright1 - 10;
        pwm0.setPWM(1, 0, bright1);
        bright2   = bright2 - 10;
        pwm0.setPWM(2, 0, bright2);
        bright3   = bright3 + 10;
        pwm0.setPWM(3, 0, bright3);
        bright4   = bright4 + 10;
        pwm0.setPWM(4, 0, bright4);
        if (bright3 == 4090) zirka = 7;
      }
      if (zirka == 7 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright2   = bright2 - 10;
        pwm0.setPWM(2, 0, bright2);
        bright3   = bright3 - 10;
        pwm0.setPWM(3, 0, bright3);
        bright4   = bright4 + 10;
        pwm0.setPWM(4, 0, bright4);
        bright0   = bright0 + 10;
        pwm0.setPWM(0, 0, bright0);
        if (bright4 == 4090) zirka = 8;
      }
      if (zirka == 8 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright3   = bright3 - 10;
        pwm0.setPWM(3, 0, bright3);
        bright4   = bright4 - 10;
        pwm0.setPWM(4, 0, bright4);
        bright0   = bright0 + 10;
        pwm0.setPWM(0, 0, bright0);
        bright1   = bright1 + 10;
        pwm0.setPWM(1, 0, bright1);
        if (bright0 == 4090) zirka = 9;
      }
      if (zirka == 9 && millis() - zirkaTime > 1) {
        zirkaTime = millis();
        bright4   = bright4 - 10;
        pwm0.setPWM(4, 0, bright4);
        bright0   = bright0 - 10;
        pwm0.setPWM(0, 0, bright0);
        bright1   = bright1 + 10;
        pwm0.setPWM(1, 0, bright1);
        bright2   = bright2 + 10;
        pwm0.setPWM(2, 0, bright2);
        if (bright1 == 4090) zirka = 5;
      }
    }
}

// ---- ADMIN MENU: Serial (USB) reader ----
static char adminBuf[128];
static uint8_t adminLen = 0;

static void processAdminSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;

    if (c == '\n') {
      adminBuf[adminLen] = 0;

      // Only handle lines starting with "ADMIN"
      if (adminLen >= 5 && strncmp(adminBuf, "ADMIN", 5) == 0) {
        handleAdminCommand(adminBuf);
      }

      adminLen = 0;
      continue;
    }

    if (adminLen < sizeof(adminBuf) - 1) {
      adminBuf[adminLen++] = c;
    } else {
      adminLen = 0; // overflow reset
    }
  }
}
void handleAdminCommand(char* line) {
  char* save;
  char* root = strtok_r(line, " ", &save); // ADMIN
  char* mod  = strtok_r(nullptr, " ", &save); // MODULE
  char* act  = strtok_r(nullptr, " ", &save); // ACTION

  if (!mod) { Serial.println(F("ERR no module")); return; }

  // ---- SYSTEM ----
  if (strcmp(mod, "STATUS") == 0) { adminStatus(); return; }
  if (strcmp(mod, "SENSORS") == 0) { adminSensors(); return; }
  if (strcmp(mod, "START")  == 0) { adminStart();  return; }
  if (strcmp(mod, "RESET")  == 0) { adminReset();  return; }
  if (strcmp(mod, "ESTOP")  == 0) { adminEstop();  return; }

  // ---- MODULES ----
  if (strcmp(mod, "LIGHT") == 0)     { adminLight(act, save); return; }
  if (strcmp(mod, "OVEN") == 0)      { adminOven(act, save);  return; }
  if (strcmp(mod, "PUZZLE") == 0)  { adminPuzzle(act);      return; }
  if (strcmp(mod, "BEAR") == 0)      { adminBear(act);        return; }
  if (strcmp(mod, "MASK") == 0)      { adminMask(act);        return; }
  if (strcmp(mod, "DOOR") == 0)      { adminDoor(act);        return; }
  if (strcmp(mod, "TABLE") == 0)     { adminTable(act, save); return; }

  Serial.println(F("ERR unknown module"));
}
void adminStatus() {
  Serial.print(F("OK STATUS mode=")); Serial.print(adminModeName());
  Serial.print(F(" a=")); Serial.print((int)a);
  Serial.print(F(" krushka=")); Serial.print((int)krushka);
  Serial.print(F(" zirka=")); Serial.print((int)zirka);
  Serial.print(F(" tarilkuPlay=")); Serial.print((int)tarilkuPlay);
  Serial.print(F(" uvMode=")); Serial.print((int)uvMode);
  Serial.println();
}
void adminSensors() {
  Serial.print(F("SENSORS "));
  Serial.print(digitalRead(stilSensor0)); Serial.write(',');
  Serial.print(digitalRead(stilSensor1)); Serial.write(',');
  Serial.print(digitalRead(stilSensor2)); Serial.write(',');
  Serial.print(digitalRead(stilSensor3)); Serial.write(',');
  Serial.print(digitalRead(stilSensor4)); Serial.write(',');
  Serial.print(isTableAtTop() ? 1 : 0); Serial.write(',');
  Serial.print(isTableAtBottom() ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(stypaSensor) == HIGH ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka1aSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka1bSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka2aSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka2bSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka3aSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka3bSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka4aSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(tarilka4bSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(motyzka) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(irSensor) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(maskaGerkon) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(digitalRead(vedmidjGerkon) == LOW ? 1 : 0); Serial.write(',');
  Serial.print(analogRead(pashchaSensor)); Serial.write(',');
  Serial.print(analogRead(pjatnashku)); Serial.write(',');
  Serial.print(digitalRead(stil)); Serial.write(',');
  Serial.print(digitalRead(strt) == LOW ? 1 : 0); Serial.write(',');
  Serial.print((int)a);
  Serial.println();
}
void adminStart() {
  // Always force back to GAME mode + start baseline scene
  adminMode = AM_GAME;
  a = 1;

  // Ensure all previous sounds are stopped, then start standard background
  execute_CMD(0x0E, 0, 0, 1);
  execute_CMD(0x0E, 0, 0, 2);
  execute_CMD(0x0E, 0, 0, 3);
  execute_CMD(0x0E, 0, 0, 4);
  execute_CMD(0x0F, 1, 1, 1);   // стандартная фоновая (как local START)

  // Standard baseline lights/outputs (same as local START)
  pwm0.setPWM(8, 0, 1024);
  pwm0.setPWM(10, 0, 100);

  // LIGHT_RESET = default mode
  setLightMode(L_DEFAULT);

  Serial.println(F("OK START"));
}

void adminReset() {
  fullResetAll();
  Serial.println(F("OK RESET"));
}
void adminDoor(char* act) {
  if (!act) { Serial.println(F("ERR DOOR missing")); return; }


  if (strcmp(act, "OPEN") == 0) {
    digitalWrite(magnitKlitka, LOW);
    Serial.println(F("OK DOOR OPENED"));
    return;
  }

  if (strcmp(act, "CLOSE") == 0) {
    digitalWrite(magnitKlitka, HIGH);
    Serial.println(F("OK DOOR CLOSED"));
    return;
  }
  Serial.println(F("ERR DOOR unknown"));
}
void adminEstop() {
  adminMode = AM_ESTOP;
  digitalWrite(up, LOW);
  digitalWrite(down, LOW);
  digitalWrite(parogen, LOW);
  digitalWrite(pichkaUV, LOW);
  digitalWrite(pichkaLight, LOW);
  digitalWrite(pichkaMove, HIGH);
  setStarAll(0);
  setLightMode(L_LIGHT);
  tableMove = TM_IDLE;
  Serial.println(F("OK ESTOP"));
}
void adminLight(char* act, char* args) {
  if (!act) { Serial.println(F("ERR LIGHT missing")); return; }

  if (strcmp(act, "UV") == 0)     { setLightMode(L_UV); Serial.println(F("OK LIGHT UV")); return; }
  if (strcmp(act, "RESET") == 0)  { setLightMode(L_DEFAULT); Serial.println(F("OK LIGHT RESET")); return; }
  if (strcmp(act, "WHITE") == 0)  { setLightMode(L_LIGHT); Serial.println(F("OK LIGHT WHITE")); return; }
  if (strcmp(act, "OK") == 0)     { setLightMode(L_OK_FLASH_GREEN); Serial.println(F("OK LIGHT OK")); return; }
  if (strcmp(act, "OFF") == 0)    { setLightMode(L_OFF); Serial.println(F("OK LIGHT OFF")); return; }

  Serial.println(F("ERR LIGHT unknown"));
}
void adminOven(char* act, char* args) {
  if (!act) return;

  if (strcmp(act, "RESET") == 0) {
    pichkaBright = 0;
    digitalWrite(pichkaUV, LOW);
    digitalWrite(pichkaLight, LOW);
    digitalWrite(pichkaMove, LOW);
    digitalWrite(parogen, LOW);
    Serial.println(F("OK OVEN RESET"));
    return;
  }

  if (strcmp(act, "SOLVED") == 0) {
    pichkaBright = 255;
    Serial.println(F("OK OVEN SOLVED"));
    return;
  }

  char* state = strtok_r(nullptr, " ", &args);
  bool on = state && strcmp(state, "ON") == 0;

  if (strcmp(act, "UV") == 0)    { digitalWrite(pichkaUV, on); Serial.println(F("OK OVEN UV")); return; }
  if (strcmp(act, "LIGHT") == 0) { digitalWrite(pichkaLight, on); Serial.println(F("OK OVEN LIGHT")); return; }
  if (strcmp(act, "MOVE") == 0)  { digitalWrite(pichkaMove, on); Serial.println(F("OK OVEN MOVE")); return; }
  if (strcmp(act, "FOG") == 0)   { digitalWrite(parogen, on); Serial.println(F("OK OVEN FOG")); return; }

  Serial.println(F("ERR OVEN unknown"));
}
void adminPuzzle(char* act) {
  if (!act) return;

  if (strcmp(act, "SOLVE") == 0) {
    ptnshk = 1;
    pwm0.setPWM(15, 0, 0); // unlock chest
    setLightMode(L_OK_FLASH_GREEN);
    Serial.println(F("OK 15PUZZLE SOLVED"));
    return;
  }

  if (strcmp(act, "RESET") == 0) {
    ptnshk = 0;
    pwm0.setPWM(15, 0, 4095); // lock chest
    Serial.println(F("OK 15PUZZLE RESET"));
    return;
  }

  Serial.println(F("ERR 15PUZZLE unknown"));
}
void adminBear(char* act) {
  if (!act) return;

  if (strcmp(act, "SOUND") == 0) {
    execute_CMD(0x0F, 1, 2, 3);
    Serial.println(F("OK BEAR SOUND"));
    return;
  }

  digitalWrite(ankhAktyator1, HIGH);

  if (strcmp(act, "OPEN") == 0) {
    myservo1.write(5);
    myservo2.write(163);
    Serial.println(F("OK BEAR OPEN"));
  }
  else if (strcmp(act, "CLOSE") == 0) {
    myservo1.write(180);
    myservo2.write(0);

    Serial.println(F("OK BEAR CLOSE"));
  }

  delay(100);
  digitalWrite(ankhAktyator1, LOW);
}
void adminMask(char* act) {
  if (!act) return;

  if (strcmp(act, "SOUND") == 0) {
    execute_CMD(0x0F,1,1,4);
    Serial.println(F("OK MASK SOUND"));
    return;
  }
}
void adminTable(char* act, char* args) {
  if (!act) { Serial.println(F("ERR TABLE missing")); return; }

  // The table leg latch is independent from the motorized table lid.
  if (strcmp(act, "LEG") == 0) {
    char* legAction = args ? strtok_r(args, " ", &args) : nullptr;
    if (!legAction) {
      Serial.println(F("ERR TABLE LEG missing"));
      return;
    }
    if (strcmp(legAction, "OPEN") == 0) {
      setTableLegReleased(true);
      stl = 2;
      Serial.println(F("OK TABLE LEG OPEN"));
      return;
    }
    if (strcmp(legAction, "CLOSE") == 0) {
      setTableLegReleased(false);
      // If the tooth is still present, keep the manual lock from being
      // immediately undone. Otherwise arm the normal game trigger again.
      stl = digitalRead(vedmidjGerkon) == LOW ? 2 : 0;
      Serial.println(F("OK TABLE LEG CLOSED"));
      return;
    }
    Serial.println(F("ERR TABLE LEG unknown"));
    return;
  }

  // If a move is already in progress, ignore new commands
  if (tableMove != TM_IDLE) {
    Serial.println(F("ERR TABLE BUSY"));
    return;
  }

  if (strcmp(act, "OPEN") == 0) {
    // Already at top
    if (isTableAtTop()) {
      tableStopMotor();
      Serial.println(F("OK TABLE ALREADY OPEN"));
      return;
    }

    tableStartOpen();
    Serial.println(F("OK TABLE OPENING"));
    return;
  }

  if (strcmp(act, "CLOSE") == 0) {
    // Already at bottom
    if (isTableAtBottom()) {
      tableStopMotor();
      Serial.println(F("OK TABLE ALREADY CLOSED"));
      return;
    }

    tableStartClose();
    Serial.println(F("OK TABLE CLOSING"));
    return;
  }

  Serial.println(F("ERR TABLE unknown"));
}
void execute_CMD(byte CMD, byte Par1, byte Par2, int l) {
  word checksum = -(0xFF + 0x06 + CMD + 0x00 + Par1 + Par2);
  byte Command_line[10] = { 0x7E, 0xFF, 0x06, CMD, 0x00,
                            Par1, Par2, highByte(checksum), lowByte(checksum), 0xEF };

  Stream* out = nullptr;
  if (l == 1) out = &Serial1;
  else if (l == 2) out = &Serial2;
  else if (l == 3) out = &mySerial;
  else if (l == 4) out = &mySerial2;
  if (!out) return;

  out->write(Command_line, 10);
}
