-- session_chunks에 labels JSONB 컬럼 추가
-- 라벨링 완료 후 청크 단위로 labels를 저장하기 위함

ALTER TABLE session_chunks
  ADD COLUMN IF NOT EXISTS labels JSONB;

CREATE INDEX IF NOT EXISTS idx_session_chunks_labels
  ON session_chunks USING GIN (labels);


create table public.transcripts (
  session_id text not null,
  user_id uuid not null,
  text text not null,
  created_at timestamp with time zone null default now(),
  summary text null,
  words jsonb null,
  constraint transcripts_pkey primary key (session_id)
) TABLESPACE pg_default;

create index IF not exists idx_transcripts_user on public.transcripts using btree (user_id) TABLESPACE pg_default;

create table public.funnel_events (
  id text not null,
  step text not null,
  timestamp timestamp with time zone not null,
  date_bucket text null,
  user_id text null,
  meta jsonb null,
  constraint funnel_events_pkey primary key (id)
) TABLESPACE pg_default;