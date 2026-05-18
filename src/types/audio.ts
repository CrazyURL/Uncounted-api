// ── 오디오 처리 공유 타입 ─────────────────────────────────────────────────
// STT 단어 타임스탬프, 발화 오디오 매니페스트, 오디오 Export 구조

// ── STT 단어 타임스탬프 ────────────────────────────────────────────────────
// utterances.transcript_words (JSONB), VoiceApiUtterance.words 와 1:1 대응

export interface WordTimestamp {
  word: string
  start: number
  end: number
  score: number
}

// ── 발화 오디오 참조 ──────────────────────────────────────────────────────
// S3 audio/{sessionId}/utterance_{n}.wav — P1 audio_manifest.json 생성에 사용

export interface UtteranceAudioRef {
  utterance_id: string
  sequence_order: number
  speaker_id: string
  start_sec: number
  end_sec: number
  padded_start_sec: number | null
  padded_end_sec: number | null
  duration_sec: number
  storage_path: string
  signed_url?: string
}

// ── 오디오 매니페스트 ─────────────────────────────────────────────────────
// export ZIP 내 metadata/audio_manifest.json 구조

export interface AudioManifest {
  session_id: string
  generated_at: string
  utterance_count: number
  audio_export_mode: 'reference_only' | 'signed_url'
  utterances: UtteranceAudioRef[]
}

// ── 토픽 세그먼트 경계 ────────────────────────────────────────────────────
// session_segments 테이블, P1 topic_segments.json export에 사용

export interface TopicSegmentBoundary {
  segment_index: number
  topic: string | null
  start_ms: number
  end_ms: number
  utterance_count: number
}
