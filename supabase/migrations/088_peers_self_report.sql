-- 088_peers_self_report.sql
-- peer 자가신고(동의 시) demographics 저장 + 교차검증 상태 확장.
--
-- 배경:
--   peer 성별/연령 추론은 0.8 한계(모르는 번호=신호0), 음향=8kHz 실패. 해결 = 상대가
--   동의 요청 시 직접 신고(owner 가입 수준). 자가신고 = ground truth(추론보다 정확,
--   바이어 음향학습에 valid). 추론엔진(peer_attribute_scorer)은 cross-check 검증기로 재활용.
--
-- 087(잠금 레이어) 위에 추가:
--   - region_group/accent_group/primary_language 컬럼(087 엔 gender/age 만 있었음. owner 와 대칭).
--   - gender_source 에 'peer_stated'(상대 자가신고) 추가.
--   - attr_state 에 교차검증 3상태 추가: peer_stated_verified(자가신고+추론 일치=최고신뢰) /
--     peer_stated_unverified(검증신호 없음=수용) / peer_stated_flagged(충돌=검토·저신뢰).
--
-- 불변식: 자가신고 = override_locked=true 로 잠금(추론·재처리 미덮음). 연령은 기존
--   voice_age_range 슬롯 재사용(source=peer_stated 가 음향추정 아닌 자가신고임을 표기).
--   기존 relationship/rel_* 및 087 컬럼 보존. schema only(additive).

ALTER TABLE peers ADD COLUMN IF NOT EXISTS region_group     TEXT;  -- 수도권|영남|호남|충청|강원|제주|해외
ALTER TABLE peers ADD COLUMN IF NOT EXISTS accent_group     TEXT;  -- 표준|경상도|전라도|충청도|강원도|제주도|혼합
ALTER TABLE peers ADD COLUMN IF NOT EXISTS primary_language TEXT;  -- 한국어(ko-KR)|영어(en-US)|...

-- gender_source: 'peer_stated' 추가(상대 자가신고). DROP + re-ADD(087 제약 확장).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peers_gender_source_check') THEN
    ALTER TABLE peers DROP CONSTRAINT peers_gender_source_check;
  END IF;
  ALTER TABLE peers ADD CONSTRAINT peers_gender_source_check
    CHECK (gender_source IS NULL OR gender_source IN ('stated', 'relation_derived', 'human_locked', 'peer_stated'));

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peers_attr_state_check') THEN
    ALTER TABLE peers DROP CONSTRAINT peers_attr_state_check;
  END IF;
  ALTER TABLE peers ADD CONSTRAINT peers_attr_state_check
    CHECK (attr_state IS NULL OR attr_state IN (
      'PEER_STRONG', 'WEAK', 'CONFLICT', 'UNKNOWN', 'HUMAN_LOCKED',
      'peer_stated_verified', 'peer_stated_unverified', 'peer_stated_flagged'
    ));
END $$;

COMMENT ON COLUMN peers.region_group     IS '상대 자가신고 거주지역(owner enum 한국어 카테고리).';
COMMENT ON COLUMN peers.accent_group     IS '상대 자가신고 방언권역(owner enum 한국어 카테고리).';
COMMENT ON COLUMN peers.primary_language IS '상대 자가신고 주 언어.';
COMMENT ON CONSTRAINT peers_gender_source_check ON peers IS
  'stated(프로필)|relation_derived(텍스트파생·음향순환오염)|human_locked(admin확정)|peer_stated(상대 동의시 자가신고).';
COMMENT ON CONSTRAINT peers_attr_state_check ON peers IS
  '087 5상태 + peer_stated_verified(자가신고+추론 일치)|peer_stated_unverified(검증불가·수용)|peer_stated_flagged(충돌·검토).';
