-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Migration 076 — 정산 발화 수 freeze trigger (DRAFT)                          ║
-- ╠══════════════════════════════════════════════════════════════════════════════╣
-- ║  Status   : DRAFT — 적용 금지                                                  ║
-- ║  Phase    : P1                                                                ║
-- ║  Gate     : CBO 회의 안건 #2 (Option A 합의) 후 적용                           ║
-- ║  Spec     : docs/design_review_panel_redesign_20260603.md §2.1                ║
-- ║                                                                                ║
-- ║  목적:                                                                          ║
-- ║    BM v10 정산 단위 = utterance.                                                ║
-- ║    검수자 정정으로 발화 수 변경 시 정산 분쟁 위험.                              ║
-- ║    → review_status 가 'in_review' (또는 'in_progress') 로 첫 진입 시            ║
-- ║      현재 utterance_count 를 sessions.billing_utterance_count 로 freeze.       ║
-- ║                                                                                ║
-- ║  Option A (권장):                                                              ║
-- ║    - freeze 이후 utterance_count 변경되어도 billing_utterance_count 불변.       ║
-- ║    - 정산은 billing_utterance_count 기준.                                       ║
-- ║                                                                                ║
-- ║  안전망:                                                                       ║
-- ║    - 트리거는 NEW.billing_utterance_count IS NULL 일 때만 freeze (재진입 차단).║
-- ║    - 수동 강제 freeze 또는 unfreeze 는 admin RPC 별도 (본 trigger 범위 외).    ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 1. freeze 함수
-- ─────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.freeze_billing_utterance_count()
RETURNS TRIGGER AS $$
DECLARE
  v_utt_count int;
BEGIN
  -- 다음 조건 모두 만족 시 freeze:
  --   1. status 가 'in_review' (또는 'in_progress') 로 전환됨
  --   2. billing_utterance_count 가 아직 null (= 최초 freeze)
  IF (NEW.review_status IS NOT NULL
      AND OLD.review_status IS DISTINCT FROM NEW.review_status
      AND NEW.review_status IN ('in_review', 'in_progress')
      AND NEW.billing_utterance_count IS NULL) THEN

    -- 실 발화 수 카운트 (utterances 테이블)
    SELECT COUNT(*) INTO v_utt_count
    FROM public.utterances
    WHERE session_id = NEW.id;

    NEW.billing_utterance_count := v_utt_count;
    NEW.billing_frozen_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.freeze_billing_utterance_count() IS
  'review_status 가 in_review/in_progress 로 전환되면 billing_utterance_count freeze. Option A (정본 §2.1).';


-- ─────────────────────────────────────────────────────────────────────────────────
-- 2. sessions UPDATE trigger
-- ─────────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS sessions_billing_freeze_on_review ON public.sessions;

CREATE TRIGGER sessions_billing_freeze_on_review
  BEFORE UPDATE OF review_status ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_billing_utterance_count();

COMMENT ON TRIGGER sessions_billing_freeze_on_review ON public.sessions IS
  '검수 시작 시 정산 발화 수 freeze. 검수자 정정이 정산 금액에 영향 X.';


-- ─────────────────────────────────────────────────────────────────────────────────
-- 3. 기존 sessions backfill (옵션) — 합의 후 별도 실행
-- ─────────────────────────────────────────────────────────────────────────────────
-- 이미 in_review 또는 그 이후 상태인 세션에 대해 backfill:
--   billing_utterance_count := utterance_count (현재 값) OR COUNT(utterances)
--
-- 본 trigger 는 이후 신규 전환분만 freeze 하므로 기존 데이터는 별도 처리.
-- ─────────────────────────────────────────────────────────────────────────────────

-- 본 backfill 은 CBO 합의 후 별도 게이트에서 실행.
-- 예시 SQL (실행 X — COMMENT):
/*
UPDATE public.sessions s
SET
  billing_utterance_count = COALESCE(s.utterance_count, (
    SELECT COUNT(*) FROM public.utterances u WHERE u.session_id = s.id
  )),
  billing_frozen_at = COALESCE(s.updated_at, now())
WHERE billing_utterance_count IS NULL
  AND review_status IN ('in_review', 'in_progress', 'approved', 'needs_revision', 'rejected');
*/


-- ─────────────────────────────────────────────────────────────────────────────────
-- 4. 검증
-- ─────────────────────────────────────────────────────────────────────────────────

-- trigger 존재 확인:
SELECT tgname, tgrelid::regclass, tgenabled
FROM pg_trigger
WHERE tgname = 'sessions_billing_freeze_on_review';

-- 함수 존재 확인:
SELECT proname, pronargs
FROM pg_proc
WHERE proname = 'freeze_billing_utterance_count';

-- 현재 freeze 상태 카운트:
SELECT
  COUNT(*) FILTER (WHERE billing_utterance_count IS NOT NULL)  AS frozen,
  COUNT(*) FILTER (WHERE billing_utterance_count IS NULL)       AS not_frozen,
  COUNT(*)                                                       AS total
FROM public.sessions;


-- ─────────────────────────────────────────────────────────────────────────────────
-- 5. 결정
-- ─────────────────────────────────────────────────────────────────────────────────
-- 트리거 작동 검증 (테스트 환경 또는 dry-run):
--   UPDATE sessions SET review_status='in_review' WHERE id='<test-sid>' AND review_status='pending';
--   → billing_utterance_count 자동 채워짐 + billing_frozen_at = now()
-- 검증 OK 시:
--   COMMIT;
-- 부적합 시:
--   ROLLBACK;
-- ─────────────────────────────────────────────────────────────────────────────────

-- COMMIT;
-- ROLLBACK;


-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  보류 사항 (Phase 후순위)                                                       ║
-- ╠══════════════════════════════════════════════════════════════════════════════╣
-- ║  • Option C (혼합) 도입 시: billing_utterance_count + gt_utterance_count 별도   ║
-- ║    컬럼 + buyer 메타 양쪽 표기                                                  ║
-- ║  • 강제 unfreeze admin RPC (디렉터 권한)                                       ║
-- ║  • billing_frozen_at 이후 utterance 수 변경 감사 로그 (별도 audit 테이블)      ║
-- ║  • merge/split/insert 도입 시 freeze 정책 재검토 필수                          ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝
