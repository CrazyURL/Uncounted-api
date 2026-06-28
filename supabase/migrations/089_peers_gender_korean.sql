-- 089_peers_gender_korean.sql
-- peers.gender 표현을 앱 온보딩 정본(한국어)으로 통일.
--
-- 배경:
--   소유자 자기신고는 users_profile.gender = 한국어(남성|여성|논바이너리, user.ts PUT /user/profile).
--   상대(peer) 자가신고도 동일 enum 이라야 owner/peer demographics 대칭 + export/cross-check 매핑 단일화.
--   087 은 peers.gender 를 영문(male|female|non_binary)-only CHECK 로 잠가 둠 → 한국어 write 거부.
--
-- 전략 (전환기 union):
--   087 영문-only CHECK DROP + 영문∪한국어 union 으로 re-ADD. 외부 GPU 스코어러가 아직 영문으로
--   write 할 수 있어, union(superset)이라야 어느 쪽도 안 깨진다(기존 행 위반 0, 데이터 상태 무관 안전).
--   GPU 스코어러 한국어 정렬 + 기존 영문값 backfill(영문→한국어) 완료 후, *별도 마이그*로 한국어-only 조임.
--
-- 범위:
--   gender 만 CHECK 변경. voice_age_range/region_group/accent_group/primary_language 는 CHECK 없음
--   → 본 마이그 불필요(앱 정본 한국어값 그대로 저장 가능). gender_source(088 'peer_stated')·
--   attr_state(088 peer_stated_*) 도 이미 정합. schema only(제약 교체).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'peers_gender_check') THEN
    ALTER TABLE peers DROP CONSTRAINT peers_gender_check;
  END IF;
  ALTER TABLE peers ADD CONSTRAINT peers_gender_check
    CHECK (gender IS NULL OR gender IN (
      'male', 'female', 'non_binary',   -- 087 영문 (전환기 호환: GPU 스코어러 미정렬분)
      '남성', '여성', '논바이너리'        -- 앱 정본 한국어 (canonical, 신규 write)
    ));
END $$;

COMMENT ON COLUMN peers.gender IS
  '성별 — 앱 정본 한국어(남성|여성|논바이너리) canonical(users_profile 와 대칭). 087 영문값은 전환기 union 허용 — GPU 스코어러 한국어 정렬 + backfill 후 별도 마이그로 한국어-only 조임.';
COMMENT ON CONSTRAINT peers_gender_check ON peers IS
  '영문(male|female|non_binary, 087 전환기)∪한국어(남성|여성|논바이너리, 089 canonical). 정렬+backfill 후 한국어-only 로 조일 예정.';
