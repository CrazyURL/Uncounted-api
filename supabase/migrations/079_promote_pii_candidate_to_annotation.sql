-- 079_promote_pii_candidate_to_annotation.sql
-- PR-P2A-2: 후보 confirmed/corrected 판정 → 확정 라벨(pii_annotations) 원자적 승격.
--
-- 목적:
--   pii_candidates 의 verdict 업데이트와 pii_annotations 삽입을 "하나의 트랜잭션"으로 처리한다.
--   둘 중 하나만 성공하는 상태(후보는 decided 인데 라벨이 없거나, 라벨은 있는데 후보가 pending)를 금지한다.
--   설계: scripts/analysis/design_pii_annotation_learning_loop_20260524.md §2
--
-- 적재 규칙 (헷갈림 방지):
--   - confirmed / corrected 만 승격한다. rejected / skipped 는 본 RPC 를 거치지 않고
--     기존 POST /pii-candidates/:id/decision 으로 후보에만 verdict 를 남긴다(hard negative 보존).
--   - predicted_type 은 절대 덮어쓰지 않는다(정정 신호 복구용). corrected 의 정정 유형은
--     admin_selected_type(후보) + pii_annotations.pii_type(라벨, 호출부가 enum 으로 매핑) 에만 반영.
--   - 한글 라벨 → annotation pii_type(enum) 매핑은 API(annotationReview.ts)에서 수행하고,
--     본 RPC 는 이미 매핑된 enum 값(p_annotation_pii_type)만 받는다.
--
-- 멱등성:
--   - 같은 후보를 재승격해도 dedup 키(utterance_id, pii_type, char offset)로 1행만 유지된다.
--   - ON CONFLICT DO UPDATE 는 source / action_status 를 건드리지 않는다
--     (수동 등록 provenance 와 revoked/masked 처리상태를 보존).
--
-- 안전 계약 (강제, migration 076/078 과 동일):
--   - 원문 PII / matched_text / snippet 미저장. char offset 포인터 + 단방향 hash 만.
--   - char offset 은 후보 행에서 그대로 가져온다(단일 진실원). hash 는 호출부가 전사 span 에서 산출.
--
-- 번호: 078_pii_annotations.sql 다음 → 079 사용.

CREATE OR REPLACE FUNCTION promote_pii_candidate_to_annotation(
  p_candidate_id        UUID,
  p_decision            TEXT,          -- 'confirmed' | 'corrected'
  p_admin_selected_type TEXT,          -- 후보에 기록할 정정 유형(한글 라벨, nullable)
  p_annotation_pii_type TEXT,          -- 라벨 enum (name/phone/.../other) — 호출부가 매핑
  p_normalized_text_hash TEXT,         -- NFC+sha256 hex (nullable)
  p_reviewed_by         TEXT,
  p_reviewed_at         TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_utterance_id  TEXT;
  v_session_id    TEXT;
  v_char_start    INTEGER;
  v_char_end      INTEGER;
  v_annotation_id UUID;
BEGIN
  -- 입력 검증 (방어 — 호출부에서도 검증하지만 RPC 단독 호출 대비).
  IF p_decision NOT IN ('confirmed', 'corrected') THEN
    RAISE EXCEPTION 'invalid decision for promotion: %', p_decision
      USING ERRCODE = '22023';  -- invalid_parameter_value
  END IF;

  IF p_annotation_pii_type NOT IN
       ('name','phone','account','address','ip','email','organization','resident_id','other') THEN
    RAISE EXCEPTION 'invalid annotation pii_type: %', p_annotation_pii_type
      USING ERRCODE = '22023';
  END IF;

  -- 후보 행 잠금 + 위치(offset) 확보. char offset 은 후보가 단일 진실원이다.
  SELECT utterance_id, session_id, char_start, char_end
    INTO v_utterance_id, v_session_id, v_char_start, v_char_end
    FROM pii_candidates
    WHERE id = p_candidate_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pii_candidate not found: %', p_candidate_id
      USING ERRCODE = 'P0002';  -- no_data_found
  END IF;

  -- (1) 후보 verdict 업데이트. predicted_type 은 건드리지 않는다(정정 복구 신호 보존).
  UPDATE pii_candidates
     SET admin_decision     = p_decision,
         admin_selected_type = p_admin_selected_type,
         reviewed_by         = p_reviewed_by,
         decided_at          = p_reviewed_at,
         status              = 'decided',
         updated_at          = now()
   WHERE id = p_candidate_id;

  -- (2) 확정 라벨 삽입(멱등). 같은 발화·유형·구간이면 dedup 키로 1행 유지.
  INSERT INTO pii_annotations (
    utterance_id, session_id, source, candidate_id, pii_type,
    char_start, char_end, normalized_text_hash, action_status,
    reviewed_by, reviewed_at
  ) VALUES (
    v_utterance_id, v_session_id, 'detector_candidate', p_candidate_id, p_annotation_pii_type,
    v_char_start, v_char_end, p_normalized_text_hash, 'pending_mask',
    p_reviewed_by, p_reviewed_at
  )
  ON CONFLICT (utterance_id, pii_type, COALESCE(char_start, -1), COALESCE(char_end, -1))
  DO UPDATE SET
    -- source 는 갱신하지 않는다(수동 등록 admin_manual provenance 보존).
    -- action_status 도 갱신하지 않는다(revoked/masked/excluded 처리상태 보존).
    candidate_id         = COALESCE(pii_annotations.candidate_id, EXCLUDED.candidate_id),
    normalized_text_hash = COALESCE(EXCLUDED.normalized_text_hash, pii_annotations.normalized_text_hash),
    reviewed_by          = EXCLUDED.reviewed_by,
    reviewed_at          = EXCLUDED.reviewed_at,
    updated_at           = now()
  RETURNING id INTO v_annotation_id;

  RETURN v_annotation_id;
END;
$$;

-- 권한: service_role 만 실행. anon/authenticated/public 차단(API service_role 경유 호출 전제).
REVOKE ALL ON FUNCTION promote_pii_candidate_to_annotation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION promote_pii_candidate_to_annotation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION promote_pii_candidate_to_annotation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION promote_pii_candidate_to_annotation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION promote_pii_candidate_to_annotation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) IS
  'PR-P2A-2: 후보 confirmed/corrected 를 pii_candidates verdict 업데이트 + pii_annotations 삽입으로 원자 승격. 멱등(dedup 키). source/action_status 보존. predicted_type 불변. rejected/skipped 는 대상 아님.';
