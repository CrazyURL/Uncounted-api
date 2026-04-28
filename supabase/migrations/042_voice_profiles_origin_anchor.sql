-- voice_profiles Origin Anchor 보존 (Option A 게이트 C+, 2026-04-29)
--
-- v1.3 Speaker Identity System Design 채택 부분:
--   - Origin Anchor: 최초 등록된 reference embedding을 영구 보존 (수정 불가)
--   - Drift Detection: live ↔ origin 유사도가 임계값(0.65) 미만이면 갱신 중단
--   - Anchor Quality: owner_score (spread + diversity + regularity 가중)
--
-- 시나리오 방어:
--   - 친구가 폰을 빌려 장시간 통화 → 시스템이 친구를 owner로 오판 →
--     앵커가 친구 쪽으로 이동 → 본인이 OTHER로 분류 → 복구 불가능 ("앵커 오염 피드백 루프")
--   - Origin Anchor 보존 + drift 차단으로 복구 가능 상태 유지
--
-- 본 마이그레이션은 스키마 확장만 수행. 실제 anchor 매칭 알고리즘은 voice-api
-- STT/diarization 통합 시점에 적용 예정 (deferred).

ALTER TABLE voice_profiles
  ADD COLUMN IF NOT EXISTS origin_reference_embedding JSONB,
  -- 최초 확정된 reference. 절대 수정 불가 (이탈 감지의 기준선).
  ADD COLUMN IF NOT EXISTS origin_confirmed_at TIMESTAMPTZ,
  -- Origin Anchor 확정 시각 (drift_limit 시간 완화 계산의 기준).
  ADD COLUMN IF NOT EXISTS anchor_quality NUMERIC,
  -- 0.0 ~ 1.0. owner_score = spread*0.4 + diversity*0.4 + regularity*0.2.
  ADD COLUMN IF NOT EXISTS drift_from_origin NUMERIC,
  -- 현재 reference ↔ origin 코사인 유사도 (0.65 미만 = drift 차단).
  ADD COLUMN IF NOT EXISTS drift_event_count INTEGER NOT NULL DEFAULT 0,
  -- drift 차단 누적 횟수 (3회 이상이면 anchor 재구축 검토).
  ADD COLUMN IF NOT EXISTS clean_calls INTEGER NOT NULL DEFAULT 0,
  -- SNR 15dB 이상 깨끗한 통화 건수 (앵커 후보 자격 게이트).
  ADD COLUMN IF NOT EXISTS processed_calls INTEGER NOT NULL DEFAULT 0;
  -- 처리 누적 통화 수 (점진적 확신 모델 단계 판정용).

-- 부분 인덱스: drift 이벤트 발생한 프로필만 (모니터링용)
CREATE INDEX IF NOT EXISTS idx_voice_profiles_drift_events
  ON voice_profiles(drift_event_count)
  WHERE drift_event_count > 0;

COMMENT ON COLUMN voice_profiles.origin_reference_embedding IS
  '최초 확정된 reference embedding. 절대 수정 불가. Drift 감지 기준선.';

COMMENT ON COLUMN voice_profiles.drift_from_origin IS
  '현재 reference ↔ origin 코사인 유사도. 0.65 미만 시 reference 갱신 차단.';
