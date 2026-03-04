# Uncounted Data Spec v2
> 작성일: 2026-02-23 | 상태: MVP 설계 기준

---

## 핵심 제약 (변경 불가)

| # | 제약 | 이유 |
|---|------|------|
| C1 | GPU 기반 AI 추론 결과(스트레스/우울/인지 등) 저장 금지 | 의료기기 리스크, 개인정보 |
| C2 | 라벨은 사용자 직접 입력(체크/슬라이더)만 허용 | 신뢰도 보장, 규제 리스크 |
| C3 | 자산 = 음성파일 + 내용 없는 이벤트/버킷 메타 | 비즈니스 범위 명확화 |
| C4 | 정밀 위치/정밀 타임스탬프/연락처/텍스트 원문/화면 내용 저장 금지 | 개인정보보호법 |
| C5 | 접근성 서비스/키로깅/화면캡처 방식 금지 | Google Play 정책, 법률 |

---

## 공통 인프라

### user_pseudo_id
```
생성: crypto.randomUUID() → localStorage 'uncounted_pid' 에 영구 저장
포맷: UUID v4 (예: a1b2c3d4-e5f6-...)
서버 전송: 모든 레코드에 pid 포함
재식별 방지: pid ↔ 개인 연결 정보 서버 미저장
```

### time_bucket 규칙
```
시간대 버킷: 2시간 단위 (0~2h, 2~4h, ..., 22~24h)
날짜: YYYY-MM-DD (정확한 시:분:초 금지)
구현:
  timeBucket(ts: Date): string
    hour = ts.getHours()
    slot = Math.floor(hour / 2) * 2
    return `${ts.toISOString().slice(0,10)}_${String(slot).padStart(2,'0')}h`
```

### duration_bucket 규칙
```
0~30s → "short"
30s~2min → "brief"
2~10min → "medium"
10~30min → "long"
30min+ → "extended"
```

### audio_hash (중복 탐지)
```
SHA-256 of: [file_size_bytes + duration_sec + codec + sample_rate]
경량 fingerprint (파일 내용 미전송)
```

### Audio Scan Pipeline
```
트리거: 앱 시작 / 사용자 수동 / 백그라운드 15분 간격
단계:
  1. READ_MEDIA_AUDIO로 파일 목록 수집
  2. 신규/변경 파일만 필터 (hash 비교)
  3. 배터리 > 20% + 충전 중일 때만 전체 분석
  4. 배터리 ≤ 20%: 기본 메타만 수집 (codec/size/duration)
  5. VAD(경량 RMS 기반): valid_speech_ratio 산출
  6. 결과 로컬 SQLite 캐시 → 서버 업로드 큐 삽입
배터리 고려: 전체 분석은 충전 중에만, 스캔은 항상 가능
```

### 업로드 큐 / 오프라인 / 재시도
```
큐: localStorage 'uncounted_upload_queue' (JSON array)
오프라인: 큐에 쌓아두고 연결 시 자동 플러시
재시도: 3회 지수 백오프 (1s, 4s, 16s)
최대 큐 크기: 500개 레코드
암호화: HTTPS만 사용 (TLS 1.2+), 로컬 저장은 평문 (기기 암호화 의존)
```

### 삭제/철회 정책
```
로컬: localStorage/캐시 즉시 삭제
서버: 삭제 요청 큐 생성 → 24시간 내 처리 (서버 구현 필요)
캠페인 철회: 동의 취소 → 해당 session의 is_public=false
전체 탈퇴: pid 기반 전체 레코드 삭제 요청
```

---

## SKU 1: U-A01 — VoiceRaw (익명화 음성 원천)

### (a) 수집 이벤트 정의
| 필드 | 타입 | 설명 |
|------|------|------|
| session_id | string | UUID |
| audio_hash | string | SHA-256 fingerprint (중복 탐지) |
| duration_sec | number | 정확한 길이 |
| file_size_bytes | number | 파일 크기 |
| codec | string | 'aac'|'mp3'|'wav'|'opus' |
| sample_rate | number | 8000|16000|44100|48000 |
| channel | number | 1 or 2 |
| valid_speech_ratio | number | 0~1, VAD 기반 유효발화 비율 |
| silence_ratio | number | 0~1 |
| noise_level_score | number | 0~1 (RMS/SNR 기반) |
| clipping_rate | number | 0~1 |
| time_bucket | string | '2025-02-23_14h' |
| device_bucket | string | 'android_mid' |
| pii_mask_report_id | string | null=미처리, 향후 PII 탐지 ID |
| quality_score | number | 0~100 (산출식 아래) |
| quality_grade | string | 'A'|'B'|'C' |

**quality_score 산출:**
```
Q = (bitrate/192)*30 + (snrDb/42)*50 + (sampleRate≥44100?1:sampleRate/44100)*20
grade: Q≥75→A, Q≥50→B, else C
```

### (b) Android/iOS 권한
| 권한 | Android | iOS | 대체안 |
|------|---------|-----|--------|
| READ_MEDIA_AUDIO | ✅ (API 33+) | ✅ PhotoLibrary | - |
| READ_EXTERNAL_STORAGE | ✅ (API < 33) | - | - |
| 백그라운드 스캔 | WorkManager | BGProcessingTask | 충전 중에만 |

### (c) 로컬 저장 스키마
```typescript
type VoiceRawRecord = {
  sessionId: string
  audioHash: string
  durationSec: number
  fileSizeBytes: number
  codec: string
  sampleRate: number
  channel: number
  validSpeechRatio: number
  silenceRatio: number
  noiseLevelScore: number
  clippingRate: number
  timeBucket: string
  deviceBucket: string
  piiMaskReportId: string | null
  qualityScore: number
  qualityGrade: 'A' | 'B' | 'C'
  scannedAt: string  // ISO date
}
```

### (d) 서버 전송 JSONL
```jsonl
{"sku":"U-A01","pid":"a1b2-...","session_id":"s001","audio_hash":"sha256abc","duration_sec":342,"file_size_bytes":5430000,"codec":"aac","sample_rate":44100,"channel":1,"valid_speech_ratio":0.78,"silence_ratio":0.22,"noise_level_score":0.82,"clipping_rate":0.001,"time_bucket":"2025-02-23_14h","device_bucket":"android_mid","quality_grade":"A","ts":"2025-02-23"}
{"sku":"U-A01","pid":"a1b2-...","session_id":"s002","audio_hash":"sha256def","duration_sec":128,"file_size_bytes":2048000,"codec":"aac","sample_rate":16000,"channel":1,"valid_speech_ratio":0.55,"silence_ratio":0.45,"noise_level_score":0.51,"clipping_rate":0.008,"time_bucket":"2025-02-23_10h","device_bucket":"android_mid","quality_grade":"C","ts":"2025-02-23"}
```

### (e) 집계 로직 (의사코드)
```
aggregate(records: VoiceRawRecord[]):
  total_files = records.length
  total_hours = sum(r.durationSec) / 3600
  total_size_gb = sum(r.fileSizeBytes) / 1e9
  usable_hours = sum(r.durationSec * r.validSpeechRatio) / 3600
  duplicate_count = records.filter(r => duplicateHashSet.has(r.audioHash)).length
  grade_dist = { A: count(grade='A'), B: count(grade='B'), C: count(grade='C') }
  eligible_u_a01 = records.filter(r => r.qualityGrade !== 'C' && r.durationSec >= 60).length
```

### (f) UI 요소
- 자산 대시보드: 총 음성/총 시간/Eligible 수량 카드
- SKU 카탈로그 카드: 참여 토글 + "수집 항목: 길이/품질/포맷" + "비PII ✓"
- 적합도: `eligible_u_a01 / total * 100`% 표시

---

## SKU 2: U-A02 — Voice+Context (음성+상황 라벨)

### (a) 수집 이벤트 정의
VoiceRaw의 모든 필드 + 아래 사용자 라벨:
| 필드 | 타입 | 옵션 |
|------|------|------|
| context_tag | string | '집'|'직장'|'이동'|'야외'|'기타' |
| activity_tag | string | '업무'|'일상대화'|'교육'|'엔터'|'기타' |
| mood_tag | string | '보통'|'긍정'|'부정'|'모름' |
| topic_tag | string | '업무'|'가족'|'쇼핑'|'금융'|'의료'|'기타' |
| label_trust_score | number | 0~1 (라벨 신뢰도) |
| label_input_latency_ms | number | 입력까지 걸린 ms |

### (b) 권한
U-A01 동일 (음성 파일 읽기만 필요, 라벨은 사용자 입력)

### (c) 스키마
```typescript
type VoiceContextLabel = {
  sessionId: string
  contextTag: string
  activityTag: string
  moodTag: string
  topicTag: string
  labelTrustScore: number
  labelInputLatencyMs: number
  labeledAt: string
}
```

### (d) JSONL
```jsonl
{"sku":"U-A02","pid":"a1b2-...","session_id":"s001","context_tag":"직장","activity_tag":"업무","mood_tag":"보통","topic_tag":"업무","label_trust_score":0.92,"label_input_latency_ms":1240,"ts":"2025-02-23"}
{"sku":"U-A02","pid":"a1b2-...","session_id":"s003","context_tag":"집","activity_tag":"일상대화","mood_tag":"긍정","topic_tag":"가족","label_trust_score":0.75,"label_input_latency_ms":820,"ts":"2025-02-23"}
```

### (e) 집계
```
label_completion_rate = labeled_count / total_count
avg_trust_score = mean(label_trust_score)
user_reliability_tier = trust>=0.8→'A', >=0.5→'B', else→'C'
eligible_u_a02 = records.filter(r => r.labelTrustScore >= 0.5 && r.qualityGrade !== 'C')
label_multiplier = 1.0 + (labeledRatio * 0.3 * (trust>=0.8 ? 1.0 : 0.5))
```

### (f) UI
- 라벨 바텀시트: 4개 필드 칩 선택 (3탭/3초 이상 → 저장 버튼 활성화)
- 저장 버튼: 900~1200ms 딜레이 (fast-click 방지)
- 신뢰도 표시: "내 라벨 신뢰도: A" (프로필 → 라벨 탭)

---

## SKU 3: U-A03 — Voice+DialogAct Lite

### (a) 수집 이벤트
VoiceRaw 필드 + 대화행위 라벨:
| 필드 | 타입 | 옵션 |
|------|------|------|
| dialog_act | string | '진술'|'질문'|'요청'|'인사'|'거절'|'기타' |
| intensity | number | 1(낮음)~3(높음) |
| speaker_count_estimate | number | 1|2|3+(사용자 입력) |

### (b) 권한
U-A01 동일

### (c) 스키마
```typescript
type DialogActLabel = {
  sessionId: string
  dialogAct: string
  intensity: 1 | 2 | 3
  speakerCountEstimate: number
  labelTrustScore: number
  labeledAt: string
}
```

### (d) JSONL
```jsonl
{"sku":"U-A03","pid":"a1b2-...","session_id":"s001","dialog_act":"요청","intensity":2,"speaker_count_estimate":2,"label_trust_score":0.88,"ts":"2025-02-23"}
{"sku":"U-A03","pid":"a1b2-...","session_id":"s004","dialog_act":"질문","intensity":1,"speaker_count_estimate":1,"label_trust_score":0.95,"ts":"2025-02-23"}
```

### (e) 집계
```
da_distribution = { '진술': N, '질문': N, ... }
avg_intensity = mean(intensity)
eligible_u_a03 = records.filter(r => r.labelTrustScore >= 0.6 && r.qualityGrade !== 'C')
```

### (f) UI
- 간소화 라벨 카드: 대화행위 6버튼 + 강도 슬라이더 (1~3)
- 발화자 수: 1/2/3+ 칩

---

## SKU 4: U-M01 — Call/Comm Metadata (통화 메타)

### (a) 수집 이벤트
| 필드 | 타입 | 설명 |
|------|------|------|
| event_type_bucket | string | 'inbound'|'outbound'|'missed' |
| duration_bucket | string | 'short'|'brief'|'medium'|'long' |
| time_bucket | string | 2시간 버킷 |
| day_of_week | number | 0~6 (월~일) |
| is_known_contact | string | null(기본)/사용자 선택: 'known'|'unknown' |
| daily_call_count | number | 당일 통화 수 |
| weekly_freq_bucket | string | 'low'|'med'|'high' |

**절대 저장 금지:** 전화번호, 연락처명, 통화 내용, 정밀 타임스탬프

### (b) 권한
| | Android | iOS | 대체 |
|--|---------|-----|------|
| READ_CALL_LOG | ✅ Dangerous permission | ✅ 통화 기록 접근 (제한적) | 사용자 수동 입력 |
| 연락처 | ❌ 금지 | ❌ 금지 | is_known은 사용자 직접 선택 |

### (c) 스키마
```typescript
type CallMetaRecord = {
  eventId: string
  pid: string
  eventTypeBucket: 'inbound' | 'outbound' | 'missed'
  durationBucket: 'short' | 'brief' | 'medium' | 'long' | 'extended'
  timeBucket: string
  dayOfWeek: number
  isKnownContact: 'known' | 'unknown' | null
  dailyCallCount: number
  weeklyFreqBucket: 'low' | 'med' | 'high'
  recordedDate: string  // YYYY-MM-DD
}
```

### (d) JSONL
```jsonl
{"sku":"U-M01","pid":"a1b2-...","event_type_bucket":"outbound","duration_bucket":"medium","time_bucket":"2025-02-23_10h","day_of_week":6,"is_known_contact":null,"daily_call_count":5,"weekly_freq_bucket":"med","date":"2025-02-23"}
{"sku":"U-M01","pid":"a1b2-...","event_type_bucket":"inbound","duration_bucket":"brief","time_bucket":"2025-02-23_18h","day_of_week":6,"is_known_contact":"known","daily_call_count":5,"weekly_freq_bucket":"med","date":"2025-02-23"}
```

### (e) 집계
```
daily_stats = groupBy(date): { inbound_count, outbound_count, missed_count, total_duration_bucket }
weekly_pattern = { peak_day_of_week, peak_time_bucket, avg_daily_calls }
eligible_u_m01 = events where duration_bucket != 'missed'
```

### (f) UI
- SKU 카탈로그 카드: "수집: 통화 건수/길이 버킷/시간대 버킷 (통화 내용 없음)"
- is_known 선택: 통화 목록에서 "아는 사람/모르는 사람" 수동 태그 버튼 (기본 OFF)

---

## SKU 5: U-M02 — App Category Sequence

### (a) 수집 이벤트
| 필드 | 타입 | 설명 |
|------|------|------|
| category | string | 'productivity'|'social'|'entertainment'|'finance'|'health'|'other' |
| session_duration_bucket | string | 세션 길이 버킷 |
| transition_from | string | 이전 카테고리 |
| time_bucket | string | 2시간 버킷 |
| daily_category_time | Record<string, number> | 카테고리별 총 시간(분) |

**앱명 저장 절대 금지**

### (b) 권한
| | Android | iOS |
|--|---------|-----|
| PACKAGE_USAGE_STATS | ✅ (UsageStatsManager, 특수권한) | ⚠️ Screen Time API 제한 |
| 앱명 → 카테고리 변환 | 기기 내 매핑 테이블 (서버에 앱명 전송 금지) | 동일 |

### (c) 스키마
```typescript
type AppCategoryRecord = {
  pid: string
  category: string
  sessionDurationBucket: string
  transitionFrom: string | null
  timeBucket: string
  date: string
}
```

### (d) JSONL
```jsonl
{"sku":"U-M02","pid":"a1b2-...","category":"productivity","session_duration_bucket":"medium","transition_from":"social","time_bucket":"2025-02-23_08h","date":"2025-02-23"}
{"sku":"U-M02","pid":"a1b2-...","category":"social","session_duration_bucket":"brief","transition_from":"entertainment","time_bucket":"2025-02-23_20h","date":"2025-02-23"}
```

### (e) 집계
```
category_seq = ordered sequence of categories per day
transition_matrix[from][to] = count
top_categories = sort by daily_category_time DESC
```

### (f) UI
- 특수권한 요청 UX: "앱 이름은 저장하지 않습니다. 사용 패턴 카테고리만 수집합니다." 안내

---

## SKU 6: U-M03 — Typing/Edit Metadata

> **정책 리스크: HIGH** — 접근성 서비스/키로거 방식 금지

### 가능한 방식
- ❌ 접근성 서비스 (AccessibilityService) — Google Play 정책 위반 위험
- ❌ InputMethodService 확장 — 키보드 교체 필요, UX 저하
- ✅ **대체안 A**: 사용자 일일 자기보고 ("오늘 타이핑 많이 했나요?" 1회 체크)
- ✅ **대체안 B**: Android Digital Wellbeing API (집계 통계만, 앱명 제외)

### 구현 방향 (MVP)
사용자 일일 체크(optional, 기본 OFF):
```typescript
type TypingDailySelfReport = {
  pid: string
  date: string
  typing_level: 'low' | 'med' | 'high'  // 사용자 선택
  edit_level: 'low' | 'med' | 'high'
  reported_at: string
}
```

### (f) UI
- SKU 카탈로그: "정책상 자동 수집 불가. 일일 자기보고(선택)만 수집합니다." 배지
- 일일 1회 팝업: 슬라이더 2개 (타이핑/편집 수준)

---

## SKU 7: U-M04 — Touch/Gesture Metadata

> **정책 리스크: HIGH** — 화면 내용 접근 금지

### 가능한 방식
- ❌ 접근성 서비스 — 금지
- ❌ 화면 캡처 — 금지
- ✅ **대체안**: Android 통계 API (집계된 화면 시간만, Digital Wellbeing)

### 구현 방향 (MVP)
MVP에서는 수집 제외. 로드맵 12주 이후 Digital Wellbeing API 연동 검토.

---

## SKU 8: U-M05 — Device/Context Buckets

### (a) 수집 이벤트
| 필드 | 타입 | 설명 |
|------|------|------|
| connectivity_bucket | string | 'wifi'|'cell_4g'|'cell_5g'|'offline' |
| battery_bucket | string | 'low'(<20%)|'mid'(20~50%)|'high'(50~80%)|'full'(80%+) |
| time_bucket | string | 2시간 버킷 |
| is_charging | boolean | 충전 중 여부 |
| device_bucket | string | 'android_low'|'android_mid'|'android_high' (RAM 기준) |

**절대 금지:** GPS/네트워크 위치, 와이파이 SSID

### (b) 권한
| | Android | iOS |
|--|---------|-----|
| ACCESS_NETWORK_STATE | ✅ Normal | ✅ |
| BATTERY_STATS | ✅ Normal | ✅ |
| 위치 | ❌ 금지 | ❌ 금지 |

### (c) 스키마
```typescript
type DeviceContextRecord = {
  pid: string
  connectivityBucket: string
  batteryBucket: string
  timeBucket: string
  isCharging: boolean
  deviceBucket: string
  date: string
}
```

### (d) JSONL
```jsonl
{"sku":"U-M05","pid":"a1b2-...","connectivity_bucket":"wifi","battery_bucket":"high","time_bucket":"2025-02-23_10h","is_charging":false,"device_bucket":"android_mid","date":"2025-02-23"}
{"sku":"U-M05","pid":"a1b2-...","connectivity_bucket":"cell_4g","battery_bucket":"mid","time_bucket":"2025-02-23_18h","is_charging":false,"device_bucket":"android_mid","date":"2025-02-23"}
```

---

## 품질/신뢰 리포트 스키마

### 음성 품질 리포트
```typescript
type VoiceQualityReport = {
  sessionId: string
  qualityScore: number          // 0~100
  qualityGrade: 'A' | 'B' | 'C'
  validSpeechRatio: number
  noiseLevelScore: number
  clippingRate: number
  duplicateFlag: boolean
  audioHash: string
  privacyRiskLevel: 'Low' | 'Med' | 'High'  // 규칙 기반
  privacyRiskReasons: string[]
}

// privacyRiskLevel 규칙:
// High: duration > 60min OR 특정 시간대(0~6h) 집중
// Med: duration > 20min
// Low: 그 외
```

### 라벨 신뢰도 리포트
```typescript
type LabelTrustReport = {
  sessionId: string
  rawScore: number              // 0~1
  adjustedScore: number         // tier 적용 후
  inputLatencyMs: number
  editCount: number
  repeatDecayFactor: number
  validationFlag: 'ok' | 'fast_click' | 'same_label_spam' | 'over_quota'
  userReliabilityTier: 'A' | 'B' | 'C'
}
```

### 라벨 신뢰도 산식 (의사코드)
```
latency_penalty:
  < 600ms  → -0.35
  600~1000 → -0.20
  1000~1500 → -0.10
  >= 1500  → 0

repeat_decay (연속 동일 라벨):
  1~3  → 1.0
  4~6  → 0.8
  7~10 → 0.5
  11~20 → 0.3
  21+  → 0.15

daily_quota = 200
over_quota_flag = todayCount >= 200

raw_score = max(0, 1.0 + latency_penalty) * repeat_decay
tier_multiplier: A=1.1, B=1.0, C=0.3
adjusted_score = min(1, raw_score * tier_multiplier)
```

---

## 가치화 엔진 (과대 기대 방지 필수)

### 핵심 원칙
> "단일 확정값 표시 금지. 항상 범위 + 조건 표시."

### 가치 범위 산식
```
예상_가치_범위 = usable_hours * (base_low~base_high) * quality_mult * label_mult * compliance_mult

usable_hours = sum(duration_sec * valid_speech_ratio) / 3600

base_low = ₩15,000/h  (보수적: 낮은 수요, 일반 품질)
base_high = ₩45,000/h (낙관적: 높은 수요, 프리미엄 세그먼트)

quality_mult: A=1.2, B=1.0, C=0.6

label_mult(min~max):
  라벨 없음 → 1.0~1.0
  라벨 있음 + trust<0.8 → 1.05~1.10
  라벨 있음 + trust≥0.8 → 1.10~1.30

compliance_mult:
  동의 완료 + 익명화 = 1.0
  동의 미완료 = 0.7
  PII 리스크 = 0.5
```

### UI 표시 규칙
```
큰 숫자 카드:
  ❌ "예상 월 배당금: ₩9,000,000"
  ✅ "예상 가치 범위 (조건부): ₩X ~ ₩Y"
  + 서브텍스트: "이는 확정 수익이 아닌, 데이터 상태 기반의 추정 범위입니다."

품질 표시:
  "판매 적합도: B (개선하면 A 가능)"
  "무음/중복 제거 + 라벨 신뢰도 향상 시 가치가 올라갑니다."

방지 문구:
  "현재 금액은 확정 수익이 아닌, 데이터 상태 기반의 추정 범위입니다."
```

---

## 정책 리스크 평가표

| SKU | 수집 방식 | 리스크 | 이유 | 권고 |
|-----|----------|--------|------|------|
| U-A01 | READ_MEDIA_AUDIO | **Low** | 표준 권한, 음성만 | MVP 포함 |
| U-A02 | 사용자 라벨 입력 | **Low** | 자발적 입력 | MVP 포함 |
| U-A03 | 사용자 라벨 입력 | **Low** | 자발적 입력 | MVP 포함 |
| U-M01 | READ_CALL_LOG | **Low-Med** | Dangerous permission, 내용 없음 | MVP 포함, 명확한 동의 필요 |
| U-M02 | PACKAGE_USAGE_STATS | **Med** | 특수권한, 앱명 미저장 조건부 OK | v2 포함 |
| U-M03 | 접근성 서비스 | **High** | Play 정책 위반 위험 | 자기보고로 대체 |
| U-M04 | 접근성 서비스 | **High** | Play 정책 위반 위험 | MVP 제외, 로드맵 검토 |
| U-M05 | 네트워크/배터리 상태 | **Low** | Normal permission | MVP 포함 |

---

## MVP 로드맵

### 4주 (긴급 MVP)
| 주차 | 작업 | 산출물 |
|------|------|--------|
| 1 | 음성 스캔 확장 (VAD/hash/quality_grade) | AudioMetrics v2 |
| 1 | 가치 범위 UI 전환 (단일값 → 범위 표시) | ValueRangeCard |
| 2 | U-A02 라벨 바텀시트 + 신뢰도 스코어링 | LabelTrustEngine |
| 2 | U-M01 통화 메타 수집 (READ_CALL_LOG) | CallMetaPipeline |
| 3 | U-M05 기기/환경 버킷 수집 | DeviceContextCollector |
| 3 | SKU 카탈로그 UI (8개 카드 + 토글) | SkuCatalogPage |
| 4 | 업로드 큐 + 오프라인 재시도 | UploadQueue |
| 4 | 빌드 안정화 + 예창패 심사 준비 | - |

### 8주 (성장 MVP)
| 주차 | 작업 |
|------|------|
| 5~6 | U-M02 앱 카테고리 시퀀스 (PACKAGE_USAGE_STATS) |
| 5~6 | 구매자 리포트 스키마 + 필터 API |
| 7 | PII 탐지 최소 구현 (전화번호 패턴 마스킹) |
| 7 | U-A03 대화행위 라벨 |
| 8 | 삭제/철회 정책 구현 (서버 삭제 큐) |
| 8 | iOS Capacitor 포팅 검토 |

### 우선순위 (U-A02 → U-M02 → U-M05 → 가치 UI)

---

## UI 문구 가이드

### 가치 카드 (범위 표시)
```
헤더: "예상 가치 범위 (조건부)"
메인: "₩X ~ ₩Y"
서브: "실제 판매가는 구매자 요구 스펙/검수 결과에 따라 달라집니다."
베타 배지: [베타 추정]
```

### 품질/적합도
```
"판매 적합도: B — 개선하면 A 가능"
"무음/중복 제거 + 라벨 신뢰도 향상 시 가치가 올라갑니다."
"사용 가능 시간: {usable}h / 총 {total}h"
```

### 과대 기대 방지 문구
```
1. "현재 금액은 확정 수익이 아닌, 데이터 상태 기반의 추정 범위입니다."
2. "데이터가 '판매 가능한 형태'로 가공되면 약 ₩X~₩Y 범위의 가치가 될 수 있습니다."
3. "이는 실제 구매자 요구 스펙/검수 결과에 따라 달라집니다."
```

### 라벨 신뢰도
```
"내 라벨 신뢰도: A (최고 등급)"
"빠른 클릭 감지 — 충분히 생각하고 라벨을 선택해주세요"
"오늘 라벨링 한도(200개)에 도달했습니다"
```

---

*문서 버전: v2.0 | 다음 검토: 4주 MVP 완료 후*
