-- 087_peers_attribute_lock.sql
-- peers 속성 잠금 레이어 — 자동 초벌(pre-fill) + 사람 확정(authoritative lock).
--
-- 배경:
--   GPU `peer_attribute_scorer.py`(텍스트+메타 4층, 음향=폐기)가 성별/관계/연령/카테고리를
--   peer 단위로 자동 추론한다. 그 출력을 저장하고, 사람이 확정하면 잠가서(override_locked)
--   어떤 재처리·자동 배치도 못 덮게 한다 — "재처리 때마다 또 관계문제" 무한루프 차단.
--   철학: 자동=초벌, 사람=확정+잠금. 잠긴 값은 authoritative.
--
-- 불변식 (헷갈림 방지):
--   override_locked=true  → 워커/스코어러/배치 절대 미덮음(GPU 스코어러가 false 행만 적재).
--                           실 enforcement 는 GPU writer 측(본 마이그는 플래그·스키마만).
--   attr_state            → 자동 신뢰도 상태(PEER_STRONG/WEAK/CONFLICT/UNKNOWN) 또는 HUMAN_LOCKED.
--   gender_source         → 'stated'(peer 가 사용자=users_profile 자기신고) / 'relation_derived'
--                           (텍스트·관계 파생 — ⚠음향 성별학습엔 순환오염, export 가 저신뢰 표기)
--                           / 'human_locked'(admin 확정).
--   기존 relationship/rel_confidence/rel_source 는 보존(불변) — 본 마이그가 안 건드림.
--
-- 이 마이그는 schema only(additive). 적재=GPU 스코어러, 잠금=admin confirm endpoint.

ALTER TABLE peers ADD COLUMN IF NOT EXISTS attr_category    TEXT;          -- '가족' | '업무'
ALTER TABLE peers ADD COLUMN IF NOT EXISTS attr_state       TEXT DEFAULT 'UNKNOWN';
ALTER TABLE peers ADD COLUMN IF NOT EXISTS gender           TEXT;          -- male | female | non_binary
ALTER TABLE peers ADD COLUMN IF NOT EXISTS gender_source    TEXT;          -- stated | relation_derived | human_locked
ALTER TABLE peers ADD COLUMN IF NOT EXISTS voice_age_range  TEXT;          -- 20대|30대|40대|50대+
ALTER TABLE peers ADD COLUMN IF NOT EXISTS speech_age_range TEXT;
ALTER TABLE peers ADD COLUMN IF NOT EXISTS override_locked  BOOLEAN DEFAULT false;
ALTER TABLE peers ADD COLUMN IF NOT EXISTS locked_by        TEXT;          -- admin user id
ALTER TABLE peers ADD COLUMN IF NOT EXISTS locked_at        TIMESTAMPTZ;

-- enum 가드(정본 외 값 차단 → 조용한 오염 방지, NULL 허용). GPU 스코어러·admin 모두 정본값만.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peers_attr_category_check') THEN
    ALTER TABLE peers ADD CONSTRAINT peers_attr_category_check
      CHECK (attr_category IS NULL OR attr_category IN ('가족', '업무'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peers_attr_state_check') THEN
    ALTER TABLE peers ADD CONSTRAINT peers_attr_state_check
      CHECK (attr_state IS NULL OR attr_state IN ('PEER_STRONG', 'WEAK', 'CONFLICT', 'UNKNOWN', 'HUMAN_LOCKED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peers_gender_check') THEN
    ALTER TABLE peers ADD CONSTRAINT peers_gender_check
      CHECK (gender IS NULL OR gender IN ('male', 'female', 'non_binary'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peers_gender_source_check') THEN
    ALTER TABLE peers ADD CONSTRAINT peers_gender_source_check
      CHECK (gender_source IS NULL OR gender_source IN ('stated', 'relation_derived', 'human_locked'));
  END IF;
END $$;

COMMENT ON COLUMN peers.attr_category    IS '가족|업무 — coarse 2분류(상위). 자동=스코어러, 확정=admin.';
COMMENT ON COLUMN peers.attr_state       IS 'PEER_STRONG|WEAK|CONFLICT|UNKNOWN(자동 신뢰도) | HUMAN_LOCKED(사람 확정).';
COMMENT ON COLUMN peers.gender           IS 'male|female|non_binary — peer 성별(자동 초벌 또는 사람 확정).';
COMMENT ON COLUMN peers.gender_source    IS 'stated(프로필 자기신고)|relation_derived(텍스트파생·음향학습 순환오염 주의)|human_locked(admin 확정).';
COMMENT ON COLUMN peers.voice_age_range  IS '목소리 기반 연령대(20대|30대|40대|50대+).';
COMMENT ON COLUMN peers.speech_age_range IS '말투 기반 연령대.';
COMMENT ON COLUMN peers.override_locked  IS 'true=사람 확정 잠금. 워커/스코어러/배치 절대 미덮음(GPU writer 측 enforcement).';
COMMENT ON COLUMN peers.locked_by        IS '확정한 admin user id.';
COMMENT ON COLUMN peers.locked_at        IS '확정 시각.';

-- active-learning 큐: 미확정(override_locked=false) peer 를 전파가치(call_count) 내림차순.
CREATE INDEX IF NOT EXISTS idx_peers_unlocked   ON peers(override_locked, call_count DESC);
CREATE INDEX IF NOT EXISTS idx_peers_attr_state ON peers(attr_state);
