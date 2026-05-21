-- 076_pii_candidates.sql
-- PII-1A: PII 후보 스테이징 테이블.
--
-- 목적:
--   voice-api detect_pii_spans(단일 소스) + confidence tier 합성 결과를 발화 단위 후보로 적재한다.
--   관리자 검수 큐("AI 판단 애매 PII")는 이 테이블의 needs_human_decision + pending 후보만 노출한다.
--
-- 안전 계약 (강제):
--   - 원문 PII / matched_text / original_text 를 저장하지 않는다. char_start/char_end 포인터만.
--   - char_start/char_end 는 internal review 전용. 외부 export/납품 ZIP 에 포함 금지.
--   - 본 테이블은 스테이징(제안)일 뿐, 최종 마스킹 구간은 PII-3/4 가 기존 utterances.pii_intervals 에 쓴다.
--
-- 번호: 075_export_embedded_jobs_v2.sql 가 Export v2 PR(feat/export-v2-async-jobs)에서 선점 → 076 사용.

CREATE TABLE IF NOT EXISTS pii_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id)   ON DELETE CASCADE,

  -- AI 예측 (detect_pii_spans + pii_confidence tier 합성)
  predicted_type TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  confidence_tier TEXT NOT NULL
    CHECK (confidence_tier IN ('auto_confirmed','needs_human_decision','auto_rejected')),
  high_precision_pattern BOOLEAN NOT NULL DEFAULT false,
  char_start INTEGER, char_end INTEGER,        -- internal review 포인터. 매칭 원문 미저장. export 금지.
  source TEXT NOT NULL DEFAULT 'voice_api_detect_spans',
  model_version TEXT,

  -- 관리자 결정 (PII-1B/PII-2 에서 사용 — 이번 PII-1A 에서는 컬럼만 예약, 미기록)
  admin_selected_type TEXT,
  admin_decision TEXT CHECK (admin_decision IN ('confirmed','corrected','rejected','skipped')),
  reviewed_by TEXT,
  decided_at TIMESTAMPTZ,

  -- 후속(PII-3/4) 예약 컬럼 — 이번엔 미사용
  ai_reprocess_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (ai_reprocess_status IN ('not_started','pending','success','failed')),
  final_pii_type TEXT,
  final_audio_action TEXT,
  final_mask_token TEXT,

  -- PII-1A 에서는 모든 후보가 'pending'. 'decided' 는 PII-1B 관리자 판정 저장 시.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','decided')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- dedup: char_start/char_end 가 NULL 이어도 중복 삽입되지 않도록 COALESCE 기반.
-- (detect-batch 는 offset 을 항상 반환하지만 방어적으로 처리)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pii_candidates_dedup
  ON pii_candidates(utterance_id, predicted_type, COALESCE(char_start, -1), COALESCE(char_end, -1));

-- 관리자 큐 조회: (needs_human_decision, pending) 필터에 최적화.
CREATE INDEX IF NOT EXISTS idx_pii_candidates_queue
  ON pii_candidates(confidence_tier, status);

-- 발화 단위 강조(pii_needs_review) 조회.
CREATE INDEX IF NOT EXISTS idx_pii_candidates_utterance
  ON pii_candidates(utterance_id);

-- RLS (migration 060 패턴): service_role bypass(기본) + admin(app_metadata.role='admin') ALL.
ALTER TABLE pii_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pii_candidates_admin_all" ON pii_candidates;
CREATE POLICY "pii_candidates_admin_all" ON pii_candidates
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

COMMENT ON TABLE pii_candidates IS
  'PII 후보 스테이징 (PII-1A). detect_pii_spans + tier 합성 결과. 원문 미저장. 최종 마스킹 구간은 utterances.pii_intervals(PII-3/4).';
COMMENT ON COLUMN pii_candidates.char_start IS
  'transcript_text 내 PII 시작 오프셋 (internal review 전용 포인터). 외부 export 금지.';
COMMENT ON COLUMN pii_candidates.char_end IS
  'transcript_text 내 PII 끝 오프셋 (internal review 전용 포인터). 외부 export 금지.';
COMMENT ON COLUMN pii_candidates.confidence IS
  '부트스트랩 휴리스틱 confidence (ML 확률 아님). PII-5 에서 실제 모델 confidence 로 대체.';
COMMENT ON COLUMN pii_candidates.status IS
  'pending = 후보 생성됨(PII-1A 전부 이 값). decided = 관리자 판정 저장됨(PII-1B).';
