-- 069: 비동의 세션 정리
-- both_agreed 가 아닌 세션은 판매 대상이 아니므로 DB에서 삭제.
-- deliveries는 ON DELETE RESTRICT FK → 먼저 삭제해야 함.
-- 나머지 자식 테이블(session_chunks, transcript_chunks, utterances 등)은
-- ON DELETE CASCADE 이므로 sessions 삭제 시 자동 제거됨.

DELETE FROM deliveries
WHERE session_id IN (
  SELECT id FROM sessions WHERE consent_status != 'both_agreed'
);

DELETE FROM sessions
WHERE consent_status != 'both_agreed';
