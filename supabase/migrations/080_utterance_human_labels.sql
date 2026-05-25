-- 080_utterance_human_labels.sql
-- PR-H1a: 사람/자동파생 emotion 라벨 저장소 (Human Emotion Label Loop).
--
-- 목적:
--   utterances.emotion(모델 출력)과 분리하여, 사람이 확정했거나 안전맵으로 자동 파생한
--   emotion 라벨을 저장한다. emotion-only 재학습의 gold 라벨 저장소.
--   설계: scripts/analysis/design_human_emotion_label_loop_20260524.md
--
-- 핵심 불변식 (헷갈림 방지):
--   utterances.emotion          = 모델 출력 전용 (본 테이블/루프가 절대 쓰지 않음).
--   utterance_human_labels      = 사람/자동파생 라벨. 모델값과 같은 컬럼에 섞지 않는다.
--
-- 2단 구조:
--   fine_label(7종)        = 기쁨/놀람/슬픔/분노/불안/당황/중립 (보존). 판단불가 시 NULL 허용.
--   emotion_category(3종)  = 긍정/중립/부정 (학습·납품용 상위 category). 보류 시 NULL.
--   category_decision      = resolved(학습 적격) / pending_context(놀람·당황 보류) / undecidable(판단불가, 학습 제외).
--   category_source        = derived(안전맵 자동) / manual(사람 확정). resolved 일 때만 필수.
--
-- ⚠ 판단불가는 emotion_category 4번째 값이 아니라 category_decision='undecidable' 이다.
-- ⚠ 놀람/당황은 무조건 부정으로 굳히지 않는다 → pending_context(검수 큐).
--
-- 번호: origin/main 074/075(export v2)/076(pii_candidates)/077(quality_review)/078(pii_annotations)/079(promote) 선점 → 080 사용.

CREATE TABLE IF NOT EXISTS utterance_human_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- utterances.id 는 TEXT (UUID 아님). session_id 는 세션 단위 학습 split(누수 방지) 조회용 비정규화.
  utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id)   ON DELETE CASCADE,

  label_type TEXT NOT NULL DEFAULT 'emotion'
    CHECK (label_type IN ('emotion')),               -- 향후 label_type 확장 여지

  -- 7종 세부 감정. 판단불가(undecidable) 시 NULL 허용 — 억지 '중립' 으로 오염시키지 않는다.
  fine_label TEXT
    CHECK (fine_label IS NULL OR fine_label IN ('기쁨','놀람','슬픔','분노','불안','당황','중립')),

  -- 3종 상위 category. 보류(pending_context)/판단불가(undecidable) 시 NULL.
  emotion_category TEXT
    CHECK (emotion_category IS NULL OR emotion_category IN ('긍정','중립','부정')),

  category_decision TEXT NOT NULL DEFAULT 'pending_context'
    CHECK (category_decision IN ('resolved','pending_context','undecidable')),

  category_source TEXT
    CHECK (category_source IS NULL OR category_source IN ('derived','manual')),

  label_confidence TEXT
    CHECK (label_confidence IS NULL OR label_confidence IN ('high','medium','low')),

  note TEXT,

  -- labeler 식별: Supabase auth UUID (pii_masked_by 패턴). 백필 시 'system:backfill-admin_confirmed'.
  labeler_id    TEXT NOT NULL,
  labeler_email TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 조건부 정합 1: resolved ⇒ fine_label·emotion_category 둘 다 NOT NULL.
  CONSTRAINT uhl_resolved_requires_fine_and_category
    CHECK (category_decision <> 'resolved' OR (fine_label IS NOT NULL AND emotion_category IS NOT NULL)),
  -- 조건부 정합 2: resolved ⇒ category_source 필수 (derived|manual). pending/undecidable 은 NULL 허용.
  CONSTRAINT uhl_resolved_requires_source
    CHECK (category_decision <> 'resolved' OR category_source IN ('derived','manual'))
);

-- 검수자 1인당 발화·타입당 1행(다중 라벨러 일치도 분석 가능). upsert 충돌 키.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_uhl_labeler
  ON utterance_human_labels(utterance_id, label_type, labeler_id);

CREATE INDEX IF NOT EXISTS idx_uhl_utterance
  ON utterance_human_labels(utterance_id);
CREATE INDEX IF NOT EXISTS idx_uhl_labeler
  ON utterance_human_labels(labeler_id);
CREATE INDEX IF NOT EXISTS idx_uhl_session
  ON utterance_human_labels(session_id);
-- 학습 pool 조회(resolved 만) — export(PR-H3) 및 stats.
CREATE INDEX IF NOT EXISTS idx_uhl_training_pool
  ON utterance_human_labels(label_type, category_decision)
  WHERE category_decision = 'resolved';
-- 검수 큐 조회(pending_context/undecidable).
CREATE INDEX IF NOT EXISTS idx_uhl_review_queue
  ON utterance_human_labels(label_type, category_decision)
  WHERE category_decision IN ('pending_context','undecidable');

-- RLS (migration 060/076/078 패턴): service_role bypass(기본) + admin(app_metadata.role='admin') ALL.
ALTER TABLE utterance_human_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "utterance_human_labels_admin_all" ON utterance_human_labels;
CREATE POLICY "utterance_human_labels_admin_all" ON utterance_human_labels
  FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

COMMENT ON TABLE utterance_human_labels IS
  '사람/자동파생 emotion 라벨 저장소(PR-H1a). utterances.emotion(모델 출력)과 분리. 2단: fine_label(7종)+emotion_category(3종). 판단불가=category_decision=undecidable. 학습 gold 는 decision=resolved 만.';
COMMENT ON COLUMN utterance_human_labels.fine_label IS
  '7종 세부 감정(기쁨/놀람/슬픔/분노/불안/당황/중립). 판단불가(undecidable) 시 NULL 허용.';
COMMENT ON COLUMN utterance_human_labels.emotion_category IS
  '3종 상위 category(긍정/중립/부정). 안전맵 자동파생(derived) 또는 사람확정(manual). 보류 시 NULL.';
COMMENT ON COLUMN utterance_human_labels.category_decision IS
  'resolved=학습 적격 / pending_context=놀람·당황 등 category 보류(검수 큐) / undecidable=판단불가(학습 제외).';
COMMENT ON COLUMN utterance_human_labels.category_source IS
  'derived=안전맵 자동파생 / manual=관리자 문맥 확정. resolved 일 때만 필수, pending/undecidable 은 NULL.';
COMMENT ON COLUMN utterance_human_labels.labeler_id IS
  'Supabase auth.users.id (pii_masked_by 패턴). admin_confirmed 역마이그분은 reviewed_by 또는 system:backfill-admin_confirmed.';
