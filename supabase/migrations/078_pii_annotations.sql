-- 078_pii_annotations.sql
-- PR-P2A-1: 확정 PII 라벨 저장소.
--
-- 목적:
--   pii_candidates(탐지기가 올린 후보 큐)와 분리하여, 사람/시스템이 "확정"하거나 직접 등록한
--   PII 라벨을 저장한다. 검수-피드백 학습 루프의 positive 라벨 저장소.
--   설계: scripts/analysis/design_pii_annotation_learning_loop_20260524.md
--
-- 역할 분리 (헷갈림 방지):
--   pii_candidates.admin_decision = 후보 판정(confirmed/corrected/rejected/skipped) — "제안에 대한 verdict"
--   pii_annotations.action_status  = 확정 라벨의 처리 상태(pending_mask/masked/excluded/revoked) — "이미 확정된 라벨"
--   → annotations 에는 decision 컬럼을 두지 않는다(중복 금지). 확정된 것만 들어온다.
--
-- 적재 규칙:
--   - confirmed/corrected(candidate 승격) 또는 admin_manual(수동 발견)만 들어온다.
--   - rejected 후보는 여기로 승격하지 않고 pii_candidates 에 hard negative 로 남는다.
--   - (이번 PR-P2A-1 API 는 admin_manual 등록만 구현. candidate 승격은 PR-P2A-2.)
--
-- 안전 계약 (강제, migration 076 과 동일):
--   - 원문 PII / matched_text / snippet 을 저장하지 않는다. char_start/char_end 포인터 + 단방향 hash 만.
--   - char_start/char_end 는 internal review 전용. 외부 export/납품 ZIP 에 포함 금지.
--   - 최종 마스킹 구간은 PII-3(PR-P3)이 기존 utterances.pii_intervals 에 쓴다. 본 테이블은 라벨일 뿐.
--
-- 번호: 075(export v2)/076(pii_candidates)/077(quality_review) 선점 → 078 사용.

CREATE TABLE IF NOT EXISTS pii_annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id)   ON DELETE CASCADE,

  -- 라벨 출처. detector_candidate 는 candidate_id 로 원후보를 가리킨다.
  source TEXT NOT NULL
    CHECK (source IN ('detector_candidate','admin_manual','denylist','regex')),
  -- 승격된 후보 링크(admin_manual/denylist/regex 는 NULL). 후보 직접 삭제 시 라벨은 보존(SET NULL).
  candidate_id UUID REFERENCES pii_candidates(id) ON DELETE SET NULL,

  -- 확정 PII 유형. resident_id(주민등록번호)는 1급 타입(other 로 보내지 않음).
  pii_type TEXT NOT NULL
    CHECK (pii_type IN ('name','phone','account','address','ip','email','organization','resident_id','other')),

  -- transcript_text 내 위치 포인터(internal review 전용). 매칭 원문 미저장. export 금지.
  char_start INTEGER, char_end INTEGER,
  -- NFC 정규화 후 단방향 hash(중복 판정/denylist 매칭용). 원문 복원 불가. 원문 자체는 미저장.
  normalized_text_hash TEXT,

  -- 확정 라벨의 처리 상태. revoked = 잘못 등록된 라벨을 삭제 없이 무효화(감사 추적 보존).
  action_status TEXT NOT NULL DEFAULT 'pending_mask'
    CHECK (action_status IN ('pending_mask','masked','excluded','revoked')),

  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  -- 관리자 자유 메모(선택). ⚠ 자유 입력이라 원문 PII 가 섞일 수 있음 → 외부 export 안전검사가 반드시 스크럽.
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- dedup: 같은 발화의 같은 유형·같은 구간은 출처 무관 동일 PII → 1행. (source 는 키에서 제외)
-- char offset 이 NULL 이어도 중복 삽입되지 않도록 COALESCE 기반(076 패턴).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pii_annotations_dedup
  ON pii_annotations(utterance_id, pii_type, COALESCE(char_start, -1), COALESCE(char_end, -1));

-- 처리 큐 조회: (action_status, created_at) 필터.
CREATE INDEX IF NOT EXISTS idx_pii_annotations_status
  ON pii_annotations(action_status, created_at);

-- 세션 단위 학습 export(train/val split) 조회.
CREATE INDEX IF NOT EXISTS idx_pii_annotations_session
  ON pii_annotations(session_id);

-- 후보 승격 역추적(PR-P2A-2).
CREATE INDEX IF NOT EXISTS idx_pii_annotations_candidate
  ON pii_annotations(candidate_id);

-- RLS (migration 060/076 패턴): service_role bypass(기본) + admin(app_metadata.role='admin') ALL.
ALTER TABLE pii_annotations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pii_annotations_admin_all" ON pii_annotations;
CREATE POLICY "pii_annotations_admin_all" ON pii_annotations
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

COMMENT ON TABLE pii_annotations IS
  '확정 PII 라벨 저장소(PR-P2A). candidate(후보)와 분리. 원문 미저장(offset+hash). 처리상태=action_status, verdict 는 pii_candidates.admin_decision. 최종 마스킹 구간은 utterances.pii_intervals(PR-P3).';
COMMENT ON COLUMN pii_annotations.char_start IS
  'transcript_text 내 PII 시작 오프셋(internal review 전용 포인터). 외부 export 금지.';
COMMENT ON COLUMN pii_annotations.char_end IS
  'transcript_text 내 PII 끝 오프셋(internal review 전용 포인터). 외부 export 금지.';
COMMENT ON COLUMN pii_annotations.normalized_text_hash IS
  'NFC 정규화 후 sha256 hex. 단방향(원문 복원 불가). 짧은 한글 이름은 사전공격으로 enumerate 가능하나 RLS-admin 한정 + export offset 비노출 전제하에 수용. salt 는 배포설정 사안(P2A-1 미도입).';
COMMENT ON COLUMN pii_annotations.action_status IS
  'pending_mask=마스킹 대기 / masked=처리됨 / excluded=마스킹 제외 / revoked=잘못 등록 무효화(삭제 대신).';
COMMENT ON COLUMN pii_annotations.note IS
  '관리자 자유 메모. ⚠ 원문 PII 가 섞일 수 있는 유일한 컬럼 → 외부 export 안전검사(safety-checks)가 반드시 스크럽/차단.';
