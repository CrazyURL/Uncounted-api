-- 090_age_unify.sql — 연령 단일화 (목소리/말투연령 폐기 → 연락처 단위 age_band 1개)
--
-- 배경: 목소리연령(음향)·말투연령(텍스트) 둘 다 degenerate(쓰레기). 449명이 한 버킷으로 붕괴,
--   오너 프로필 30대인데 말투모델 40대로 오답 = 모델 출력이 쓰레기(배선은 정상).
-- 설계: 연령 = 연락처(peer) 단위 단일 필드. self=users_profile.age_band(온보딩 자기신고),
--   peer=peers.age_band(동의페이지 자가신고). 음향/텍스트 추론 전면 폐기.
--
-- ⚠️ 배포 순서 (필수):
--   1) GPU voice-api 코드(commit 25bd45e, feature/peer-attr-engine-self-skip) 가 **배포된 뒤** 본 마이그 적용.
--      현 live worker 는 구 코드라 session_speakers age 컬럼에 write 중 → drop 먼저 하면 insert 깨짐.
--      (현재 업로드 파이프라인 정지로 live 처리 0건이라 실위험은 낮으나 순서 준수.)
--   2) 본 마이그 적용 후 api/admin 코드(age_band 단일 읽기) 배포.
--   역순 금지.

BEGIN;

-- ── 1) session_speakers: per-call 추론 age 컬럼 전면 제거 ──────────────────────
--   GPU 코드가 더 이상 이 컬럼들에 write 하지 않음(25bd45e). per-speaker 연령 노출 폐기.
ALTER TABLE session_speakers DROP COLUMN IF EXISTS speaker_voice_age_range;
ALTER TABLE session_speakers DROP COLUMN IF EXISTS speaker_speech_age_range;
ALTER TABLE session_speakers DROP COLUMN IF EXISTS speaker_speech_age_model_version;
ALTER TABLE session_speakers DROP COLUMN IF EXISTS speaker_age_group_estimate;

-- ── 2) peers: 자가신고 연령을 단일 age_band 로 통일 ───────────────────────────
--   088 에서 자가신고 연령을 voice_age_range 슬롯에 적재해 왔음 → age_band 로 RENAME(기존값 보존).
--   speech_age_range 는 폐기.
ALTER TABLE peers RENAME COLUMN voice_age_range TO age_band;
ALTER TABLE peers DROP COLUMN IF EXISTS speech_age_range;

-- age_band 버킷 = 앱 AgeBand(userProfile.ts) · peerConfirm.AGE_RANGE_VALUES · users_profile.age_band 동일.
-- 기존 행에 버킷 외 값이 있으면 CHECK 추가가 실패하므로, 안전하게 NOT VALID 로 추가(신규 write 부터 강제).
ALTER TABLE peers
  ADD CONSTRAINT peers_age_band_check
  CHECK (age_band IS NULL OR age_band IN ('10대','20대','30대','40대','50대','60대이상'))
  NOT VALID;

-- users_profile.age_band 는 self 연령 정본 — 변경 없음.

COMMIT;

-- 적용 후 검증:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='session_speakers' AND column_name LIKE '%age%';   -- → 0행
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='peers' AND column_name IN ('age_band','voice_age_range','speech_age_range'); -- → age_band 만
