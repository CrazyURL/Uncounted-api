-- ════════════════════════════════════════════════════════════════════
-- Migration 057 — BM v10 전면 리셋
-- ════════════════════════════════════════════════════════════════════
--
-- WHY
--   사용자 결정으로 BM v10 전면 개편 — 기존 919 양측동의 sessions 는
--   휴대폰 로컬 audio_url + 서버 raw audio 부재 = GPU 처리 불가능한
--   메타데이터 only 시드 데이터. BM v10 raw audio 업로드 흐름 신규
--   구축 전에 모든 sessions + 부속 데이터 wipe.
--
-- 삭제 순서 (FK 의존성 기준)
--   1. deliveries          — sessions FK 가 ON DELETE RESTRICT (명시 삭제 필수)
--   2. orphan 테이블 (FK 없는 session_id 컬럼들):
--        consent_invitations, consent_withdrawals, bu_quality_metrics,
--        export_package_items, upload_block_logs, user_asset_ledger
--   3. sessions            — CASCADE 로 다음 child 자동 삭제:
--        score_components, labels, campaign_matches, session_labels,
--        billable_units, session_chunks, transcript_chunks, utterances
--        (utterances 의 child 인 045_bm_v10_versions_rewards 도 CASCADE)
--
-- 호환성
--   각 DELETE 전에 to_regclass() 로 테이블 존재 확인 — dev DB 에
--   일부 마이그레이션 미적용 시 silent skip (RAISE NOTICE 기록).
--
-- 검증
--   COMMIT 후 SELECT COUNT(*) FROM sessions  -> 0
--                SELECT COUNT(*) FROM utterances -> 0
--                SELECT COUNT(*) FROM deliveries -> 0
--
-- 주의
--   사용자 계정 (auth.users) 은 보존. 919 의 owner cbee40db 도 그대로.
--   Storage bucket 'sanitized-audio' (Supabase 측) + iwinv S3 측 청소는
--   별도 스크립트 / 수동 처리 필요.
-- ════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'deliveries',              -- 1. RESTRICT FK
    'consent_invitations',     -- 2. orphan
    'consent_withdrawals',
    'bu_quality_metrics',
    'export_package_items',
    'upload_block_logs',
    'user_asset_ledger',
    'sessions'                 -- 3. CASCADE 자동 처리 마지막
  ];
  row_count BIGINT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I', t);
      GET DIAGNOSTICS row_count = ROW_COUNT;
      RAISE NOTICE '[057] DELETE %: % rows', t, row_count;
    ELSE
      RAISE NOTICE '[057] SKIP % (table not present in this DB)', t;
    END IF;
  END LOOP;
END $$;
