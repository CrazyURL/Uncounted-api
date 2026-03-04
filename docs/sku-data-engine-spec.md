# SKU 데이터 엔진 설계 명세

**Uncounted 플랫폼 — 8 SKU + 프리미엄 번들 3 + 품질·신뢰·가치 엔진**
버전: v1.0 | 작성일: 2026-02

---

## 절대 제약 (불변 정책)

| 제약 | 내용 |
|------|------|
| GPU 추론 금지 | 스트레스/우울/인지/감정 예측 등 모델 추론 결과 저장·판매 금지 |
| 라벨 유형 | 사용자 입력(User-labeled)만 허용 — AI 자동 라벨 판매 금지 |
| 자산 유형 | 음성파일 + 메타데이터(내용 없는 이벤트·버킷)만 |
| 정밀 위치 금지 | GPS 좌표, 셀 ID, Wi-Fi SSID 저장 금지 |
| 정밀 타임스탬프 금지 | 시각 정보는 time_bucket(2h/6h)으로만 |
| 연락처 금지 | 상대방 번호, 이름, 관계 저장 금지 |
| 텍스트 원문 금지 | 대화 내용, 문자, 화면 텍스트 저장 금지 |
| 앱명 금지 | 앱 패키지명 저장 금지 — 카테고리 버킷만 허용 |

---

## 공통 인프라

### pseudo_id 생성 및 관리

```
앱 최초 설치 시:
  pseudoId = UUID v4 (crypto.randomUUID())
  저장: localStorage('uncounted_pseudo_id')
  → 이메일/전화/기기 ID와 연결 없음

사용자 철회 시:
  1. 로컬 데이터 전체 삭제 (requestLocalDeletion())
  2. pseudoId 재발급 (rotatePseudoId())
     → 이전 서버 데이터와 연결 끊기
  3. 서버 삭제 요청 큐에 추가 (enqueueDeleteRequest())
     → 서버 연결 시 DELETE /api/v1/user/{old_pseudo_id} 전송
```

### time_bucket 규칙

| 버킷 크기 | 표현 형식 | 버킷 수 | 용도 |
|----------|---------|--------|------|
| 2h (기본) | `HH-HH` (e.g. `10-12`) | 12개/일 | U-A01/A02/A03, U-M01, U-M05 |
| 6h (옵션) | `HH-HH` (e.g. `06-12`) | 4개/일 | 강화된 프라이버시 요청 시 |
| 일 버킷 | `YYYY-MM-DD` | — | U-M05 일별 집계 |
| 월 버킷 | `YYYY-MM` | — | U-M01 월별 집계 |

```
calcTimeBucket(date): TimeBucket2h
  h = date.getHours()
  start = floor(h / 2) * 2
  return `${padStart(start, 2)}-${padStart(start+2, 2)}`
```

### device_bucket 규칙

```
calcDeviceBucket(): DeviceBucket
  if !navigator.onLine → 'offline'
  isWifi  = navigator.connection.type === 'wifi' (폴백: 미지원 시 true)
  isCharging = navigator.getBattery().charging (폴백: false)

  wifi + charging  → 'wifi_charging'
  wifi + battery   → 'wifi_battery'
  mobile + charging → 'mobile_charging'
  mobile + battery  → 'mobile_battery'
```

### 업로드 큐 / 오프라인 / 재시도

```
엔드포인트: POST /api/v1/upload
Content-Type: application/x-ndjson
Body: JSONL (줄당 1 레코드)

오프라인 처리:
  localStorage('uncounted_upload_queue') → QueueItem[]
  flushQueue() 호출 시점: 앱 포그라운드 복귀, 네트워크 연결 복원

재시도 전략 (지수 백오프):
  retryCount=0: 즉시
  retryCount=1: 1분 후
  retryCount=2: 2분 후
  retryCount=3: 4분 후
  retryCount=4: 8분 후
  retryCount=5: 16분 후 → 이후 status='failed' (수동 재시도)

배치 크기: 50개/요청
암호화: AES-256-GCM (Web Crypto API, 기기별 키)
```

### 철회 / 삭제 정책

| 단계 | 동작 |
|------|------|
| 로컬 즉시 삭제 | localStorage 전체 수집 키 삭제, pseudo_id 재발급 |
| 서버 삭제 요청 | DELETE 큐에 추가 → 연결 시 전송 |
| 서버 처리 기간 | 삭제 요청 수신 후 30일 이내 |
| 업로드 완료 데이터 | 기간 내 삭제 보장 (고객 지원 채널) |

---

## SKU 정의 + 수집 이벤트 + 권한 + 리스크

### 정책 리스크 평가표

| SKU | Android 권한 | iOS 권한 | 수집 가능 여부 | 리스크 | 대체안 |
|-----|-------------|---------|-------------|-------|-------|
| U-A01 | READ_EXTERNAL_STORAGE / MediaStore API | Privacy Manifest (파일 접근) | ✅ 가능 | Low | — |
| U-A02 | 동일 + 사용자 라벨 입력 UI | 동일 | ✅ 가능 | Low | — |
| U-A03 | 동일 | 동일 | ✅ 가능 | Low | — |
| U-M01 | READ_CALL_LOG | CallKit (제한적, iOS 13+) | ✅ Android 완전 가능 / ⚠ iOS 부분 가능 | Low | iOS: 통화 건수 자기보고 |
| U-M02 | PACKAGE_USAGE_STATS (특수 권한, 사용자 Settings 수동 허용) | ❌ 없음 (iOS 미지원) | ⚠ Android 특수 권한 / ⛔ iOS 불가 | Med | 앱 카테고리 자기보고 (10초/일) |
| U-M03 | AccessibilityService (정책 제한) / 대체: 없음 | ❌ 없음 | ⛔ 자동 수집 불가 | High | 일일 자기보고 10초 |
| U-M04 | AccessibilityService (정책 제한) / 대체: 없음 | ❌ 없음 | ⛔ 자동 수집 불가 | High | 일일 자기보고 10초 |
| U-M05 | ACCESS_NETWORK_STATE, BATTERY_STATS (일반 권한) | 제한적 (배터리 정밀도 낮음) | ✅ Android 완전 가능 / ⚠ iOS 일부 | Low | — |

**U-M03 상세 리스크:**
- AccessibilityService 자동 수집: Google 정책 위반 가능성 (계정 정지/앱 삭제 위험)
- 대체: 사용자가 직접 "오늘 타이핑 양" 버킷 선택 (none/light/moderate/heavy)
- 수집 빈도: 1회/일, 10초 소요, 기본 OFF

**U-M04 상세 리스크:**
- 동일 이유 (AccessibilityService)
- 대체: 사용자가 "오늘 기기 사용 강도" 버킷 선택 (minimal/normal/intensive)

---

## SKU별 상세 명세

---

### U-A01 — 익명화 음성 원천

**수집 이벤트:**
- 사용자가 음성 파일 스캔 승인 시 1회
- 스캔 단위: 파일(세션) 단위, 1분 청크 단위 서버 전송

**로컬 저장 스키마:**

```typescript
// src/types/audioAsset.ts → AudioScanRecord
{
  sessionId: string        // 로컬 UUID
  audioHash: string        // SHA-256 hex (중복 탐지)
  durationSec: number
  fileSizeBytes: number
  codec: AudioCodec
  sampleRate: number       // Hz
  channels: number
  validSpeechRatio: number // 1 - silenceRatio
  silenceRatio: number
  noiseLevelScore: number  // RMS 기반
  clippingRate: number
  qualityScore: number     // 0~100
  qualityGrade: 'A'|'B'|'C'
  duplicateFlag: boolean
  timeBucket: TimeBucket2h
  deviceBucket: DeviceBucket
  scannedAt: string        // YYYY-MM-DD
}
```

**서버 전송 JSONL 예시:**

```jsonl
{"schema":"U-A01-v1","pseudo_id":"a1b2c3d4","session_id":"s-001","audio_hash":"e3b0c44298fc1c149af","duration_sec":300,"valid_speech_ratio":0.78,"silence_ratio":0.22,"noise_level_score":0.12,"clipping_rate":0.001,"quality_score":82,"quality_grade":"A","sample_rate":44100,"codec":"m4a","time_bucket":"10-12","device_bucket":"wifi_charging"}
{"schema":"U-A01-v1","pseudo_id":"a1b2c3d4","session_id":"s-001","audio_hash":"e3b0c44298fc1c149af","duration_sec":300,"valid_speech_ratio":0.75,"silence_ratio":0.25,"noise_level_score":0.15,"clipping_rate":0.002,"quality_score":78,"quality_grade":"B","sample_rate":44100,"codec":"m4a","time_bucket":"10-12","device_bucket":"wifi_charging"}
```

**품질/신뢰/가치 집계 로직:**

```
qualityScore =
  snrScore(0.35) + speechScore(0.25) + bitrateScore(0.20) + srScore(0.15) + noClipScore(0.05)

qualityGrade: A≥75, B≥50, C<50

적합 조건:
  qualityScore >= 50
  durationSec >= 30
  duplicateFlag = false

가치 범위:
  usable_hours = totalHours × avgValidSpeechRatio
  value_low  = usable_hours × 15,000 × qualityMult × labelMult_min × complianceMult
  value_high = usable_hours × 40,000 × qualityMult × labelMult_max × complianceMult
  qualityMult: A=1.2, B=1.0, C=0.6
  complianceMult: 동의완료=1.0, 미완=0.7
```

**UI 요소:**
- 세션 카드: 단일 ₩ 금액 표시 금지 → CP(기여포인트) 또는 `value` 탭 유도
- 적합도: ✅ 적합 / ⚠ 개선필요 / ⛔ 불가 (아이콘+텍스트, 색상 NO)
- 스캔 완료 배지: "N개 파일 스캔됨 · A등급 X개"

---

### U-A02 — 음성 + 상황 라벨

**수집 이벤트:**
- U-A01 조건 충족 + 사용자가 상황 라벨 입력 완료 시

**추가 라벨 필드:**

```typescript
user_label: {
  context: string   // 상황: '업무' | '일상' | '이동중' | '가정' | '야외'
  activity: string  // 활동: '회의' | '통화' | '이동중' | '식사' | '기타'
  mood: string      // 분위기: '집중' | '편안' | '긴박' | '보통'
  topic: string     // 주제: '기술_논의' | '잡담' | '협업' | '교육' | '기타'
}
label_trust_score: number   // 0~1
label_input_latency_ms: number
```

**서버 전송 JSONL 예시:**

```jsonl
{"schema":"U-A02-v1","pseudo_id":"a1b2c3d4","session_id":"s-001","audio_hash":"e3b0c44298fc","duration_sec":300,"quality_grade":"A","time_bucket":"10-12","device_bucket":"wifi_charging","user_label":{"context":"업무","activity":"회의","mood":"집중","topic":"기술_논의"},"label_trust_score":0.91,"label_input_latency_ms":2340}
{"schema":"U-A02-v1","pseudo_id":"a1b2c3d4","session_id":"s-002","audio_hash":"7f83b1657ff1","duration_sec":180,"quality_grade":"B","time_bucket":"14-16","device_bucket":"mobile_battery","user_label":{"context":"일상","activity":"이동중","mood":"보통","topic":"잡담"},"label_trust_score":0.85,"label_input_latency_ms":3100}
```

**라벨 신뢰도 집계:**

```
calcLabelTrust(inputLatencyMs, consecutiveSameLabel, todayLabelCount, editCount)

latencyPenalty:
  <600ms: -0.35  (fast_click 플래그)
  600~1000ms: -0.20
  1000~1500ms: -0.10
  ≥1500ms: 0

repeatDecay:
  1~3회: 1.0
  4~6회: 0.8   (same_label_spam 경고)
  7~10회: 0.5
  11~20회: 0.3
  21+회: 0.15

editPenalty:
  0회 편집: 0
  1~2회: -0.02
  3~5회: -0.05
  6+회: -0.10

rawScore = max(0, 1.0 + latencyPenalty + editPenalty) × repeatDecay
adjustedScore = min(1, rawScore × tierMult)  // A=1.1, B=1.0, C=0.3

daily_label_quota = 200 → 초과 시 over_quota 플래그
```

**UI 요소 (라벨 바텀시트):**
- 저장 버튼: 900~1200ms 무작위 딜레이 (클릭 농사 방지)
- 신뢰도 배지: 저장 후 "신뢰도 0.91 기록됨" 팝업 (일시적)
- 반복 경고: 동일 라벨 7회+ 시 "다양한 상황 라벨 입력을 권장합니다" 인라인 힌트

---

### U-A03 — 음성 + 대화행위 라벨

**수집 이벤트:**
- U-A01 기준 충족 + 사용자가 대화행위 + 강도 라벨 입력

**추가 라벨 필드:**

```typescript
dialog_act: '진술' | '질문' | '요청' | '지시' | '반응' | '기타'
intensity: 1 | 2 | 3  // 1=낮음, 2=보통, 3=높음
```

**서버 전송 JSONL 예시:**

```jsonl
{"schema":"U-A03-v1","pseudo_id":"a1b2c3d4","session_id":"s-001","audio_hash":"e3b0c44298fc","quality_grade":"A","time_bucket":"10-12","dialog_act":"질문","intensity":2,"label_trust_score":0.89,"label_input_latency_ms":2800}
{"schema":"U-A03-v1","pseudo_id":"a1b2c3d4","session_id":"s-002","audio_hash":"7f83b1657ff1","quality_grade":"B","time_bucket":"08-10","dialog_act":"진술","intensity":1,"label_trust_score":0.92,"label_input_latency_ms":3500}
```

---

### U-M01 — 통화/통신 메타데이터

**수집 이벤트:**
- 사용자 동의 + Android READ_CALL_LOG 권한 승인 후 자동
- 수집 주기: 앱 포그라운드 시 또는 1회/일 백그라운드
- 집계 단위: 월 × 시간대 × 유형 × 길이 버킷

**로컬 저장 스키마:**

```typescript
// src/types/metadata.ts → CallMetaRecord
{
  schema: 'U-M01-v1'
  pseudoId: string
  dateBucket: string         // 'YYYY-MM' (월 버킷)
  timeBucket: TimeBucket2h
  callType: 'incoming'|'outgoing'|'missed'|'rejected'
  durationBucket: 'under_30s'|'30s_3m'|'3m_15m'|'15m_60m'|'over_60m'
  count: number              // 해당 버킷 합계
  // ❌ 금지: 번호, 이름, 정밀 시각
}
```

**서버 전송 JSONL 예시:**

```jsonl
{"schema":"U-M01-v1","pseudo_id":"a1b2c3d4","date_bucket":"2026-02","time_bucket":"10-12","call_type":"incoming","duration_bucket":"3m_15m","count":3}
{"schema":"U-M01-v1","pseudo_id":"a1b2c3d4","date_bucket":"2026-02","time_bucket":"14-16","call_type":"outgoing","duration_bucket":"30s_3m","count":7}
```

**집계 로직:**

```
입력: CallLog 이벤트 목록
for each event:
  dateBucket = YYYY-MM
  timeBucket = calcTimeBucket(event.startTime)
  durationBucket = classify(event.duration)
  callType = event.type
  → 버킷 키(dateBucket+timeBucket+callType+durationBucket)로 count++

결과: CallMetaRecord[]  (상대방 정보 없음)
```

**UI 요소:**
- 수집 상태 표시: "이번 달 X건 집계됨 · Y시간대"
- 개인정보 보호 설명: "상대방 번호/이름은 저장하지 않습니다"
- iOS 안내: "iOS에서는 자기보고로 대체됩니다" (토글 비활성)

---

### U-M02 — 앱 카테고리 시퀀스

**수집 이벤트:**
- Android PACKAGE_USAGE_STATS 특수 권한 필요 (Settings > 앱 > 특수 앱 접근)
- iOS: 미지원 (Privacy Manifest 불가)
- 앱명 저장 금지 — 앱 카테고리만 기록

**로컬 저장 스키마:**

```typescript
// src/types/metadata.ts → AppCategoryEvent
{
  schema: 'U-M02-v1'
  pseudoId: string
  dateBucket: string        // 'YYYY-MM'
  timeBucket: TimeBucket2h
  fromCategory: AppCategory
  toCategory: AppCategory
  transitionBucket: 'short'|'med'|'long'  // 이전 앱 체류 <5m/<30m/>30m
  sessionDurationBucket: 'short'|'med'|'long'  // 현재 앱 체류
}
```

**서버 전송 JSONL 예시:**

```jsonl
{"schema":"U-M02-v1","pseudo_id":"a1b2c3d4","date_bucket":"2026-02","time_bucket":"10-12","from_category":"communication","to_category":"productivity","transition_bucket":"short","session_duration_bucket":"med"}
{"schema":"U-M02-v1","pseudo_id":"a1b2c3d4","date_bucket":"2026-02","time_bucket":"14-16","from_category":"entertainment","to_category":"social","transition_bucket":"med","session_duration_bucket":"short"}
```

**현재 상태:** MVP 미지원 (특수 권한 UX + iOS 미지원)
**v2 일정:** 특수 권한 온보딩 플로우 + Android 전용 활성화

---

### U-M03 — 타이핑/편집 메타데이터

**정책 리스크 평가:**
- AccessibilityService 자동 수집: Google Play 정책 위반 위험 (앱 삭제/계정 정지)
- 키스트로크 수집과 유사 → 개인정보 침해 위험
- **결론: 자동 수집 완전 금지**

**대체안: 일일 자기보고 (10초)**

```typescript
{
  schema: 'self-report-v1'
  pseudoId: string
  dateBucket: 'YYYY-MM-DD'
  typingAmountBucket: 'none'|'light'|'moderate'|'heavy'
  gestureBucket: 'minimal'|'normal'|'intensive'
  reportedAt: 'YYYY-MM-DD'
}
```

**UI 요소:**
- 선택 ON/OFF 토글 (기본 OFF)
- 매일 앱 열 때 바텀시트: "오늘 타이핑·터치 활동은?" (3개 칩 선택)
- "건너뛰기" 항상 표시

---

### U-M04 — 터치/제스처 메타데이터

**정책 리스크 평가:**
- U-M03와 동일 이유 — AccessibilityService 경유 수집 불가
- **결론: 자동 수집 완전 금지**

**대체안:** U-M03 자기보고에 gestureBucket 통합 (별도 SKU 미지원)

---

### U-M05 — 기기/환경 버킷

**수집 이벤트:**
- 앱 포그라운드 진입 시 자동 (별도 권한 불필요)
- navigator.onLine, navigator.connection, navigator.getBattery()

**로컬 저장 스키마:**

```typescript
// src/types/metadata.ts → DeviceContextRecord
{
  schema: 'U-M05-v1'
  pseudoId: string
  dateBucket: 'YYYY-MM-DD'
  timeBucket: TimeBucket2h
  deviceBucket: 'wifi_charging'|'wifi_battery'|'mobile_charging'|'mobile_battery'|'offline'
  batteryLevelBucket: 'high'|'medium'|'low'  // >60%, 20-60%, <20%
  screenTimeBucket: 'active'|'moderate'|'light'
  // ❌ 금지: GPS, 셀 ID, SSID
}
```

**서버 전송 JSONL 예시:**

```jsonl
{"schema":"U-M05-v1","pseudo_id":"a1b2c3d4","date_bucket":"2026-02-23","time_bucket":"10-12","device_bucket":"wifi_charging","battery_level_bucket":"high","screen_time_bucket":"active"}
{"schema":"U-M05-v1","pseudo_id":"a1b2c3d4","date_bucket":"2026-02-23","time_bucket":"14-16","device_bucket":"mobile_battery","battery_level_bucket":"medium","screen_time_bucket":"moderate"}
```

---

## 프리미엄 번들

### P1 — 이동성 컨텍스트 팩

```
구성: U-M05 기기/환경 버킷 + 사용자 환경 라벨
라벨: 집/회사/이동/기타 (목적 라벨)
가치: ₩8,000~₩20,000/unit (U-M05 단독 대비 +60~+150%)
MVP: 지원 (U-M05 + 라벨 입력)

적합 조건:
  U-M05 수집 동의 ON
  labels.purpose 입력 완료
```

### P2 — 이동 전환 팩

```
구성: U-M02 앱 카테고리 시퀀스 + transition_bucket + 사용자 라벨
MVP: 미지원 (U-M02 특수 권한 필요)
v2 일정: U-M02 활성화 이후 연동
```

### P3 — 생활 루틴 팩

```
구성: U-M05 기기/환경 + 생활 루틴 라벨 + 선택적 U-A02 조인
라벨: 생활 패턴 (아침루틴/출퇴근/업무/여가/취침)
가치: ₩12,000~₩35,000/unit (U-A02 조인 시 상단)
MVP: 지원 (U-M05 + 라벨 입력, U-A02 조인은 선택)

적합 조건:
  U-M05 수집 동의 ON
  labels.domain 또는 목적 라벨 입력
  선택: U-A02 라벨 있는 세션과 매핑
```

---

## 음성 스캔 확장 지표

### 레코드 단위 지표

| 지표 | 계산법 | 비고 |
|------|-------|------|
| `audioHash` | SHA-256(audioBuffer) hex | 중복 탐지 |
| `validSpeechRatio` | 1 - silenceRatio | DSP 기반 |
| `silenceRatio` | 무음 프레임(RMS < 0.01) / 전체 | |
| `noiseLevelScore` | 1 - (snrDb / 42) clamp(0,1) | 높을수록 잡음 |
| `clippingRate` | 클리핑 샘플(|s| > 0.99) / 전체 | |
| `qualityScore` | 복합 지수 0~100 (아래 상세) | |
| `qualityGrade` | A≥75, B≥50, C<50 | |
| `duplicateFlag` | audioHash 캐시 충돌 여부 | |
| `timeBucket` | 2h 버킷 | |
| `deviceBucket` | 연결+충전 상태 | |

### quality_score 계산식

```
weightSNR    = 0.35  → snrDb 구간: ≥30→1.0, ≥20→0.8, ≥10→0.5, <10→0.2
weightSpeech = 0.25  → validSpeechRatio: ≥0.7→1.0, ≥0.5→0.85, ≥0.3→0.65, <0.3→0.3
weightBitrate= 0.20  → bitrate kbps: ≥192→1.0, ≥128→0.85, ≥96→0.65, ≥64→0.45, <64→0.2
weightSR     = 0.15  → sampleRate: ≥44100→1.0, ≥16000→0.8, ≥8000→0.5
weightNoClip = 0.05  → clippingRate: ≤0.001→1.0, ≤0.01→0.8, ≤0.05→0.4, >0.05→0.1

qualityScore = round(composite × 100)
```

### 집계 지표

| 지표 | 계산법 |
|------|-------|
| `totalFiles` | 스캔 세션 수 |
| `totalHours` | Σ durationSec / 3600 |
| `usableHoursLow` | totalHours × avgValidSpeechRatio × 0.70 |
| `usableHoursHigh` | totalHours × avgValidSpeechRatio × 0.90 |
| `duplicateHoursEstimate` | Σ durationSec(duplicateFlag=true) / 3600 |
| `qualityGradeDistribution` | A/B/C 파일 수 |
| `skuEligibleCounts` | SKU별 적합 파일 수 |

---

## 라벨 신뢰도 시스템

### 저장 필드

```typescript
// 세션 단위 저장 (Supabase sessions 테이블 확장 예정)
label_trust_score: number           // adjustedScore
label_input_latency_ms: number      // 라벨 화면 진입~저장 시간
label_edit_count: number            // 저장 전 선택 변경 횟수
label_repeat_decay_factor: number   // repeatDecay
validation_flag: ValidationFlag     // 'ok'|'fast_click'|'same_label_spam'|'over_quota'
user_reliability_tier: 'A'|'B'|'C' // 누적 평균 기반
```

### 신뢰도 계산 의사코드

```
function calcLabelTrust(inputLatencyMs, consecutiveSameLabel, todayCount, editCount, userTier):

  latencyPenalty =
    inputLatencyMs < 600  → -0.35 + flag('fast_click')
    inputLatencyMs < 1000 → -0.20
    inputLatencyMs < 1500 → -0.10
    else → 0

  repeatDecay =
    consecutiveSameLabel <= 3  → 1.0
    consecutiveSameLabel <= 6  → 0.8 (경고 표시)
    consecutiveSameLabel <= 10 → 0.5
    consecutiveSameLabel <= 20 → 0.3
    else → 0.15 + flag('same_label_spam')

  editPenalty =
    editCount = 0   → 0
    editCount <= 2  → -0.02
    editCount <= 5  → -0.05
    else → -0.10

  if todayCount >= 200 → flag('over_quota'), return {adjustedScore: 0}

  rawScore = max(0, min(1, 1.0 + latencyPenalty + editPenalty)) × repeatDecay
  tierMult = {A: 1.1, B: 1.0, C: 0.3}
  adjustedScore = min(1, rawScore × tierMult[userTier])

  return {rawScore, adjustedScore, validationFlag, latencyPenalty, repeatDecay, editCount, editPenalty}

user_reliability_tier:
  평균 adjustedScore ≥ 0.8 → A
  평균 adjustedScore ≥ 0.5 → B
  else → C
```

---

## 가치 표시 UI 시스템

### 핵심 원칙: 단일 확정 ₩ 표시 금지

| 화면 | 허용 표시 | 금지 표시 |
|------|---------|---------|
| 홈/리스트/카드 | CP(기여포인트), "가치 탭에서 확인" | ₩ 단일값 |
| `value` 탭 | ₩X~₩Y 범위 + "조건부" 배지 | ₩ 단일 확정값 |
| SKU 카드 | ✅/⚠/⛔ + 개선 CTA | "₩X 수익 예정" |

### 가치 UI 3요소

```
A) 자산 규모 (확정):
   → 총 파일 N개 · 총 X.X시간 · Y.Y GB

B) 품질 (측정):
   → A등급 X개 / B등급 Y개 / C등급 Z개
   → 유효발화 추정: X.X ~ Y.Y시간

C) 가치 (조건부 범위):
   → ₩X ~ ₩Y
   → "조건부" 배지 + 미충족 조건 목록
   → "이렇게 하면 가치가 올라갑니다" CTA
```

### 가치 범위 산식

```
value_range = usable_hours × base_rate × quality_mult × label_mult × compliance_mult

usable_hours = totalHours × avgValidSpeechRatio (Low: ×0.70, High: ×0.90)
base_rate: Low=₩15,000/h, High=₩40,000/h (SKU별 상이)
quality_mult: A=1.2, B=1.0, C=0.6
label_mult(trust≥0.8 조건):
  labeledRatio=0 → {min:1.0, max:1.0}
  labeledRatio>0, trustQualified → {min: 1+(boost×0.7), max: 1+(boost×1.0)} (boost=labeledRatio×0.3)
compliance_mult: 동의완료=1.0, 미완=0.7
```

### SKU별 상태 표시

```
eligible    → ✅ 적합 (check_circle 아이콘 + 텍스트, 색상 사용 금지)
needs_work  → ⚠ 개선 필요 (warning 아이콘 + 개선 CTA)
not_eligible → ⛔ 현재 불가 (block 아이콘 + 이유 + v2 일정)
```

---

## 라이트 테마 시스템 (연보라 1색)

### 디자인 원칙

- Single accent: Lavender 600 (`#6B4EE8`) — CTA, 진행바, 선택 칩만
- Eligible/Risk/High/Low = **아이콘+텍스트만** (색상 구분 금지)
- 다크 모드: 기존 `#101322` 계열 유지 (accent만 동일 퍼플 계열 가능)

### 토큰 표

| 토큰 | 라이트 값 | 다크 값 | 용도 |
|------|---------|--------|------|
| `--color-bg` | `#F9F8FF` | `#101322` | 메인 배경 |
| `--color-surface` | `#FFFFFF` | `#1b1e2e` | 카드/시트 |
| `--color-surface-alt` | `#F0EEFF` | `#252840` | 강조 카드 |
| `--color-accent` | `#6B4EE8` | `#1337ec` | CTA/진행바 |
| `--color-accent-dim` | `#EDE9FE` | `rgba(19,55,236,0.15)` | 비활성 칩 |
| `--color-text` | `#1A1333` | `#FFFFFF` | 주 텍스트 |
| `--color-text-sub` | `#5F5A7A` | `rgba(255,255,255,0.70)` | 보조 텍스트 |
| `--color-text-tertiary` | `#9B96BC` | `rgba(255,255,255,0.40)` | 힌트 |
| `--color-border` | `rgba(107,78,232,0.12)` | `rgba(255,255,255,0.08)` | 경계선 |

### 마이그레이션 방법

현재 컴포넌트는 모두 `style={{ backgroundColor: '#101322' }}` 형태의 인라인 스타일 사용.
신규 컴포넌트부터 CSS 변수 적용:

```tsx
// 기존 (마이그레이션 필요)
<div style={{ backgroundColor: '#101322' }}>

// 신규 방식 (CSS 변수)
<div style={{ backgroundColor: 'var(--color-bg)' }}>
```

테마 토글:
```typescript
import { applyTheme, loadThemeMode, saveThemeMode } from '../lib/theme'

// 앱 초기화 시
applyTheme(loadThemeMode())

// 토글 시
saveThemeMode('light')
applyTheme('light')
```

---

## 로드맵

### MVP 4주 (우선순위 SKU)

| 주차 | 작업 | SKU/기능 |
|------|------|---------|
| 1주 | 음성 스캔 확장 | audioScanner.ts 통합, audioHash, quality_grade, timeBucket |
| 1주 | 가치 UI 적용 | ValuePage 3요소(A/B/C), 단일값 제거, 범위 배지 |
| 2주 | U-A02 라벨 플로우 | LabelBottomSheet 신뢰도 통합, editCount 추적 |
| 2주 | U-M05 수집 | DeviceContextRecord 저장, 업로드 큐 연동 |
| 3주 | U-M01 Android | READ_CALL_LOG 권한, 버킷 집계, 업로드 |
| 3주 | 업로드 큐 | flushQueue, 지수 백오프, JSONL 배치 |
| 4주 | 라이트 테마 | CSS 변수 적용, 신규 컴포넌트 마이그레이션 |
| 4주 | P1/P3 번들 | 번들 적합도 표시, 라벨 조건 안내 |

### MVP 8주 (확장)

| 주차 | 작업 | SKU/기능 |
|------|------|---------|
| 5주 | U-A03 라벨 | 대화행위 라벨 UI (dialog_act + intensity) |
| 5주 | 자기보고 (U-M03/M04 대체) | 일일 바텀시트, 10초 UX |
| 6주 | 사용자 신뢰도 티어 | A/B/C 계산, 가치 배수 반영 |
| 6주 | 철회/삭제 완성 | 서버 DELETE 큐 처리, 진행 상태 표시 |
| 7주 | U-M02 준비 (Android) | PACKAGE_USAGE_STATS 온보딩 플로우 설계 |
| 7주 | P1/P3 완성 | 번들 JSONL 생성, 서버 스키마 확정 |
| 8주 | iOS 대응 | U-M01 iOS 대체, U-M05 Battery API 폴백 |
| 8주 | 빌드 검증 | 전체 SKU 플로우 E2E, 암호화 키 관리 |

### 미정 (v2+)

- U-M02 (PACKAGE_USAGE_STATS 특수 권한 + iOS 대체)
- P2 번들 (U-M02 의존)
- 서버측 삭제 처리 파이프라인
- 교차 SKU 가치 최적화 엔진

---

## 엣지케이스 정의

| ID | 상황 | 정책 |
|----|------|------|
| EC-01 | audioHash 충돌 (동일 파일 재스캔) | duplicateFlag=true, 별도 집계. 사용자에게 중복 안내 |
| EC-02 | qualityScore=0 (완전 무음 파일) | qualityGrade='C', U-A01 적합 불가 안내 |
| EC-03 | 라벨 신뢰도 < 0.5 (C 티어) | tierMult=0.3 적용, 가치 범위 대폭 하락 + 힌트 표시 |
| EC-04 | 업로드 큐 5회 재시도 실패 | status='failed', 수동 재시도 버튼 노출 |
| EC-05 | localStorage 용량 초과 | 큐 오래된 항목 500개 제한으로 자동 trim |
| EC-06 | 네트워크 오프라인 + 배치 적용 중 | cancelledRef=true → 중단, 완료 항목만 반영 |
| EC-07 | iOS에서 Battery API 미지원 | getBattery() 없음 → isCharging=false 폴백 |
| EC-08 | pseudo_id 충돌 (이론적 UUID 충돌) | 확률 무시 (UUID v4 중복 확률 ≈ 0) |
