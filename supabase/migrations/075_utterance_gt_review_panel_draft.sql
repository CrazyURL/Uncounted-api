-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Migration 075 — 검수 패널 재설계 P1 데이터 모델 (DRAFT)                       ║
-- ╠══════════════════════════════════════════════════════════════════════════════╣
-- ║  Status        : DRAFT — 적용 금지                                              ║
-- ║  Phase         : P1                                                            ║
-- ║  Gate          : CBO 회의 안건 #1·#2·#3 합의 후 적용                            ║
-- ║  Spec          : docs/design_review_panel_redesign_20260603.md §3              ║
-- ║  Briefing      : docs/cbo_briefing_tier_spotcheck_20260603.md                  ║
-- ║                                                                                ║
-- ║  Tables created (4):                                                           ║
-- ║    1. utterance_gt          — 납품 정본 (GT 진실층, applied 개념 없음)         ║
-- ║    2. reprocess_signal      — 재처리 후보 (휘발성, approved_by 게이트)         ║
-- ║    3. utterance_revisions   — 발화 정정 audit 이력 (4종)                       ║
-- ║    4. session_reprocess_runs— 통화 재처리 실행 이력                            ║
-- ║                                                                                ║
-- ║  Design principles:                                                            ║
-- ║    • GT 진실층 ≠ 재처리 신호 (분리 — 의견 3 의 근본 결함 지적 반영)            ║
-- ║    • 정산 발화 수 = sessions.utterance_count freeze (Option A)                 ║
-- ║      → 본 마이그레이션은 utterance_count 변경 X, freeze 정책은 application     ║
-- ║        layer 에서 보장                                                          ║
-- ║    • WER 측정 = hold-out 세트만 (session_reprocess_runs.metrics_source 명시)   ║
-- ║    • Provenance = reviewer_user_id + review_method 명시값                       ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ─────────────────────────────────────────────────────────────────────────────────
-- 1. utterance_gt — 납품 정본 (GT 진실층)
-- ─────────────────────────────────────────────────────────────────────────────────
-- 한 utterance 에 한 reviewer 는 한 row (UNIQUE).
-- 다중 검수자 도입 시 (P3+) consensus_required 컬럼 추가 가능.
-- ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.utterance_gt (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id          text NOT NULL REFERENCES public.utterances(id) ON DELETE CASCADE,
  session_id            text NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,

  -- GT 본문
  gt_transcript         text NOT NULL,
  gt_speaker            text CHECK (gt_speaker IN ('본인', '상대', 'unknown') OR gt_speaker IS NULL),
  gt_pii_intervals      jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- [{start_char, end_char, pii_type, source: 'human'|'auto', confidence?}]

  -- 메타
  reviewer_user_id      text NOT NULL,
  -- uuid 또는 특수값:
  --   'system_auto'         → 자동승인 (사람 검수 없음)
  --   'spot_check_human'    → 자동승인 중 spot-check 표본 → 사람 재검증
  review_method         text NOT NULL CHECK (review_method IN (
    'human',
    'auto_approve',
    'spot_check_passed'
  )),
  reviewer_comment      text,

  -- 상태
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',
    'approved',
    'rejected',
    'deferred_split'   -- mixed segment, P3 분할 UI 도입 시 복구 대기
  )),

  -- 제외 사유 (status='rejected' 또는 'deferred_split' 시)
  exclude_reason        text CHECK (exclude_reason IN (
    '잡음',
    '화자혼재',
    '동의불완전',
    'PII우려',
    '기타'
  ) OR exclude_reason IS NULL),
  exclude_reason_note   text,

  -- 자동승인 / spot-check 메타
  auto_approve_run_id   uuid,                   -- system_auto 일괄 batch 식별
  spot_checked          boolean DEFAULT false,
  spot_check_result     text CHECK (spot_check_result IN ('pass', 'fail') OR spot_check_result IS NULL),
  spot_check_run_id     uuid,

  -- 타임스탬프
  created_at            timestamptz DEFAULT now() NOT NULL,
  approved_at           timestamptz,
  updated_at            timestamptz DEFAULT now() NOT NULL,

  CONSTRAINT utterance_gt_unique UNIQUE (utterance_id, reviewer_user_id)
);

COMMENT ON TABLE public.utterance_gt IS '검수 GT 납품 정본. applied 개념 없음. utterances 와 N:1 (reviewer 별).';
COMMENT ON COLUMN public.utterance_gt.reviewer_user_id IS 'uuid (사람) OR ''system_auto''/''spot_check_human'' (특수값).';
COMMENT ON COLUMN public.utterance_gt.review_method IS '''human'' | ''auto_approve'' | ''spot_check_passed''. buyer 메타 input.';
COMMENT ON COLUMN public.utterance_gt.status IS '''deferred_split'' = mixed segment, P3 복구 대기.';
COMMENT ON COLUMN public.utterance_gt.gt_pii_intervals IS 'jsonb [{start_char, end_char, pii_type, source}]. PII 위치 드래그 UI 산출물.';

CREATE INDEX IF NOT EXISTS utterance_gt_session_idx     ON public.utterance_gt(session_id);
CREATE INDEX IF NOT EXISTS utterance_gt_utterance_idx   ON public.utterance_gt(utterance_id);
CREATE INDEX IF NOT EXISTS utterance_gt_reviewer_idx    ON public.utterance_gt(reviewer_user_id);
CREATE INDEX IF NOT EXISTS utterance_gt_status_idx      ON public.utterance_gt(status);
CREATE INDEX IF NOT EXISTS utterance_gt_method_idx      ON public.utterance_gt(review_method);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER utterance_gt_set_updated_at
  BEFORE UPDATE ON public.utterance_gt
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS — admin only
ALTER TABLE public.utterance_gt ENABLE ROW LEVEL SECURITY;

CREATE POLICY utterance_gt_admin_all ON public.utterance_gt
  FOR ALL
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin'
  );


-- ─────────────────────────────────────────────────────────────────────────────────
-- 2. reprocess_signal — 재처리 후보 (휘발성)
-- ─────────────────────────────────────────────────────────────────────────────────
-- GT diff 또는 manual_input 에서 추출된 재처리 힌트 (HOTWORDS / speaker swap 등).
-- approved_by 사람 게이트 통과 시에만 session_reprocess_runs 에 input 으로 사용.
-- ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reprocess_signal (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            text NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,

  -- 신호 원천
  source_type           text NOT NULL CHECK (source_type IN ('gt_diff', 'manual_input')),
  origin_revision_id    uuid,                   -- utterance_revisions(id) 참조만, FK X (cascade 위험)

  -- 신호 종류
  signal_type           text NOT NULL CHECK (signal_type IN (
    'hotword_candidate',
    'speaker_swap_observed',
    'pii_missed',
    'profile_mismatch'
  )),

  -- 페이로드
  payload               jsonb NOT NULL,
  -- hotword_candidate:        {token, frequency, kiwi_pos, sample_contexts}
  -- speaker_swap_observed:    {utterance_id, auto_speaker, gt_speaker}
  -- pii_missed:               {start_char, end_char, pii_type}
  -- profile_mismatch:         {expected, observed, evidence}

  -- 사람 승인 게이트
  approved_by           uuid REFERENCES auth.users(id),
  approved_at           timestamptz,
  rejected_at           timestamptz,
  rejection_reason      text,

  -- 재처리 반영
  applied_run_id        uuid,                   -- session_reprocess_runs(id) 참조만

  created_at            timestamptz DEFAULT now() NOT NULL,

  CHECK (
    (approved_at IS NULL AND rejected_at IS NULL)
    OR (approved_at IS NOT NULL AND rejected_at IS NULL)
    OR (approved_at IS NULL AND rejected_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.reprocess_signal IS '재처리 입력 후보. 사람 게이트 (approved_by) 통과 시에만 적용. 휘발성.';
COMMENT ON COLUMN public.reprocess_signal.signal_type IS 'hotword_candidate / speaker_swap_observed / pii_missed / profile_mismatch';

CREATE INDEX IF NOT EXISTS reprocess_signal_session_idx  ON public.reprocess_signal(session_id);
CREATE INDEX IF NOT EXISTS reprocess_signal_type_idx     ON public.reprocess_signal(signal_type);
CREATE INDEX IF NOT EXISTS reprocess_signal_pending_idx  ON public.reprocess_signal(session_id)
  WHERE approved_at IS NULL AND rejected_at IS NULL;

ALTER TABLE public.reprocess_signal ENABLE ROW LEVEL SECURITY;

CREATE POLICY reprocess_signal_admin_all ON public.reprocess_signal
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin');


-- ─────────────────────────────────────────────────────────────────────────────────
-- 3. utterance_revisions — 발화 정정 audit 이력 (4종)
-- ─────────────────────────────────────────────────────────────────────────────────
-- 발화 단위 변경 1건 = 1 row. revision_type 4종 (P1):
--   text_correction / speaker_relabel / pii_addition / pii_removal / exclude
-- merge/split/insert 는 Phase 후순위 (BM v10 정산 충돌 해결 후).
-- ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.utterance_revisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id          text REFERENCES public.utterances(id) ON DELETE CASCADE,
  session_id            text NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  reviewer_user_id      uuid NOT NULL REFERENCES auth.users(id),

  revision_type         text NOT NULL CHECK (revision_type IN (
    'text_correction',
    'speaker_relabel',
    'pii_addition',
    'pii_removal',
    'exclude'
  )),

  -- 차원별 페이로드
  payload               jsonb NOT NULL,
  -- text_correction:    {before_text, after_text, diff_tokens}
  -- speaker_relabel:    {before_speaker, after_speaker}
  -- pii_addition:       {start_char, end_char, pii_type, source: 'human'}
  -- pii_removal:        {start_char, end_char, original_pii_type, reason}
  -- exclude:            {reason, reason_note}

  reason                text,

  created_at            timestamptz DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.utterance_revisions IS '발화 정정 audit 이력 4종 (P1). merge/split/insert 보류.';

CREATE INDEX IF NOT EXISTS utterance_revisions_session_idx   ON public.utterance_revisions(session_id);
CREATE INDEX IF NOT EXISTS utterance_revisions_utterance_idx ON public.utterance_revisions(utterance_id);
CREATE INDEX IF NOT EXISTS utterance_revisions_type_idx      ON public.utterance_revisions(revision_type);

ALTER TABLE public.utterance_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY utterance_revisions_admin_all ON public.utterance_revisions
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin');


-- ─────────────────────────────────────────────────────────────────────────────────
-- 4. session_reprocess_runs — 통화 재처리 실행 이력
-- ─────────────────────────────────────────────────────────────────────────────────
-- 통화 단위 재처리 1회 = 1 row. before/after 메트릭으로 정직한 WER 측정.
-- 메트릭은 반드시 hold-out 세트 기준 (metrics_source 명시).
-- ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.session_reprocess_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               text NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  requested_by             uuid NOT NULL REFERENCES auth.users(id),

  -- 재처리 입력
  before_revision_count    int DEFAULT 0,
  hotwords_added           text[],
  voice_profile_updated    boolean DEFAULT false,
  model_used               text,                 -- 'large-v3-int8' | 'large-v3' | 'turbo'
  pii_detector_rerun       boolean DEFAULT false,
  initial_prompt_changed   text,
  request_reason           text NOT NULL,        -- 필수

  -- 결과
  status                   text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued',
    'running',
    'done',
    'failed'
  )),
  voice_api_job_id         text,
  error_message            text,

  -- 메트릭 (hold-out 세트 기준만 채움)
  before_metrics           jsonb,
  -- {wer, utterance_count, avg_quality, errors_marked}
  after_metrics            jsonb,
  metrics_source           text,
  -- 'holdout_set_v1' | 'session_only' (session_only 는 참고용, buyer 보고 X)
  diff_summary             jsonb,

  created_at               timestamptz DEFAULT now() NOT NULL,
  started_at               timestamptz,
  completed_at             timestamptz
);

COMMENT ON TABLE public.session_reprocess_runs IS '통화 단위 재처리 실행 이력. WER = hold-out 세트만 (metrics_source 명시).';
COMMENT ON COLUMN public.session_reprocess_runs.metrics_source IS 'holdout_set_v1 = buyer 보고 가능. session_only = 내부 참고 (자기기만 가능성).';

CREATE INDEX IF NOT EXISTS reprocess_runs_session_idx ON public.session_reprocess_runs(session_id);
CREATE INDEX IF NOT EXISTS reprocess_runs_status_idx  ON public.session_reprocess_runs(status);

ALTER TABLE public.session_reprocess_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_reprocess_runs_admin_all ON public.session_reprocess_runs
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin');


-- ─────────────────────────────────────────────────────────────────────────────────
-- 5. utterances 확장 — 검수 점수 / Tier 라우팅
-- ─────────────────────────────────────────────────────────────────────────────────
-- 기존 utterances 테이블에 검수 점수 / Tier 컬럼 추가.
-- review_priority_score = trigger 또는 application 에서 산정 (튜닝 가능 휴리스틱).
-- ─────────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.utterances
  ADD COLUMN IF NOT EXISTS review_priority_score    int,
  ADD COLUMN IF NOT EXISTS review_priority_tier     text CHECK (review_priority_tier IN ('red', 'yellow', 'green') OR review_priority_tier IS NULL),
  ADD COLUMN IF NOT EXISTS dataset_tier             text CHECK (dataset_tier IN ('premium', 'standard', 'excluded') OR dataset_tier IS NULL),
  ADD COLUMN IF NOT EXISTS dataset_tier_decided_at  timestamptz;

COMMENT ON COLUMN public.utterances.review_priority_score IS '검수 점수 (0-100). 튜닝 가능 휴리스틱. 산정 로직은 application layer.';
COMMENT ON COLUMN public.utterances.review_priority_tier IS 'red (≥60) / yellow (30-60) / green (<30). 큐 표시 input.';
COMMENT ON COLUMN public.utterances.dataset_tier IS 'CBO 합의 후 Tier 정책 적용. premium / standard / excluded.';

CREATE INDEX IF NOT EXISTS utterances_priority_tier_idx ON public.utterances(review_priority_tier);
CREATE INDEX IF NOT EXISTS utterances_dataset_tier_idx  ON public.utterances(dataset_tier);


-- ─────────────────────────────────────────────────────────────────────────────────
-- 6. sessions 확장 — 통화 단위 검수 점수 + 정산 freeze 메타
-- ─────────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS call_review_score          int,
  ADD COLUMN IF NOT EXISTS call_review_tier           text CHECK (call_review_tier IN ('red', 'yellow', 'green') OR call_review_tier IS NULL),
  ADD COLUMN IF NOT EXISTS billing_utterance_count   int,                  -- STT 시점 freeze (Option A)
  ADD COLUMN IF NOT EXISTS billing_frozen_at         timestamptz;

COMMENT ON COLUMN public.sessions.call_review_score IS '통화 점수 = 빨강비율×100 + utt평균×0.3 (튜닝 가능 휴리스틱).';
COMMENT ON COLUMN public.sessions.billing_utterance_count IS '정산용 발화 수 = STT 시점 freeze (Option A). 검수 후에도 불변.';
COMMENT ON COLUMN public.sessions.billing_frozen_at IS 'review_status=in_review 진입 시 freeze 타임스탬프.';


-- ─────────────────────────────────────────────────────────────────────────────────
-- 7. holdout_sets — WER 측정용 hold-out 세트 정의 (P0.5 합의 후 채움)
-- ─────────────────────────────────────────────────────────────────────────────────
-- CBO 회의 안건 #3 결정 후 표본 통화 선정 + 본 테이블 populate.
-- ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.holdout_sets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_name            text NOT NULL UNIQUE,        -- 'holdout_v1' 등
  description         text,
  created_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz DEFAULT now() NOT NULL,
  retired_at          timestamptz                  -- 사용 종료 시
);

CREATE TABLE IF NOT EXISTS public.holdout_set_sessions (
  holdout_set_id      uuid NOT NULL REFERENCES public.holdout_sets(id) ON DELETE CASCADE,
  session_id          text NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  added_at            timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (holdout_set_id, session_id)
);

COMMENT ON TABLE public.holdout_sets IS 'WER 측정용 격리 세트. HOTWORDS 추출 입력 절대 금지. buyer 정직 보고용.';
COMMENT ON TABLE public.holdout_set_sessions IS 'hold-out 세트 ↔ session N:M 매핑. 한 세션이 여러 hold-out 세트에 속할 수 있음 (변경 이력 보존).';

CREATE INDEX IF NOT EXISTS holdout_set_sessions_session_idx ON public.holdout_set_sessions(session_id);

ALTER TABLE public.holdout_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holdout_set_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY holdout_sets_admin_all ON public.holdout_sets
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin');

CREATE POLICY holdout_set_sessions_admin_all ON public.holdout_set_sessions
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role')::text = 'admin');


-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  DRAFT 적용 보류 사항                                                          ║
-- ╠══════════════════════════════════════════════════════════════════════════════╣
-- ║  • billing_utterance_count freeze trigger 추가 필요                            ║
-- ║    (sessions UPDATE 시 review_status='in_review' 전환되면 자동 freeze)        ║
-- ║  • Tier 정책 (Premium/Standard/Excluded) 임계값 = CBO 안건 #1 결정 후 추가     ║
-- ║  • Spot-check Logic (P1 초기 5%, P2 강화 2%) = application layer (별도 PR)     ║
-- ║  • HOTWORDS Kiwi NNP 필터 = application layer (별도 PR — P2)                   ║
-- ║  • merge/split/insert revision_type = 보류 (BM v10 정산 충돌 해결 후)          ║
-- ║  • multi-reviewer consensus_required = P3 (buyer 요구 시)                      ║
-- ╠══════════════════════════════════════════════════════════════════════════════╣
-- ║  Migration 적용 절차:                                                          ║
-- ║    1. CBO 회의 안건 #1·#2·#3 합의 → 정본 문서 락                                ║
-- ║    2. dev DB apply (--dry-run 후 실 apply)                                     ║
-- ║    3. application code 배선 (utterance_gt insert / status freeze trigger)      ║
-- ║    4. admin UI 배선 (체크박스 4개 + 정정 4종 + GT 저장)                        ║
-- ║    5. backfill 미실시 — 기존 utterances 그대로 유지, 신규 검수만 GT 생성       ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝
