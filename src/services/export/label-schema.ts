/**
 * Label schema — 외부 ZIP `labels/label_schema.json` 정적 정의.
 *
 * SPEC §5 외부 노출 필드만. 안전선:
 *   - pii_labels: `original` 키 X (#3, additionalProperties: false)
 *   - numeric_patterns: `surface_masked` / `normalized_masked` 만 (#4)
 *   - speaker_label: `owner_candidate` / `counterparty_candidate` / `unknown` 만 (#1)
 *   - method/label_origin: 외부 5종 allowlist (#6, #12)
 */

export const ALLOWED_METHODS = [
  'automatic',
  'supervised_model',
  'rule_based_mvp',
  'heuristic_mvp',
  'not_available',
] as const

/**
 * speaker_label 은 SPEAKER_00 같은 익명 diarization 라벨 (자유 문자열).
 * 화자 역할 후보는 speaker_role_candidate 에 별도로 둔다 (안전선 #1).
 */
export const ALLOWED_SPEAKER_ROLE_CANDIDATES = [
  'owner_candidate',
  'counterparty_candidate',
  'unknown',
] as const

export const ALLOWED_CONFIDENCE_TIERS = [
  'high',
  'medium',
  'needs_review',
  null,
] as const

/**
 * label_schema.json — ZIP `labels/label_schema.json` 으로 직렬화.
 *
 * draft-07 JSON Schema. additionalProperties: false 로 외부 비허용 필드 차단.
 */
export const LABEL_SCHEMA_JSON = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://uncounted.cloud/schemas/labels-v2.json',
  title: 'Uncounted Export v2 — labels schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'utterance_id',
    'session_id',
    'sequence_order',
    'start_sec',
    'end_sec',
    'speaker_label',
    'speaker_role_candidate',
    'label_origin',
    'audio_export_mode',
  ],
  properties: {
    utterance_id: { type: 'string' },
    session_id: { type: 'string' },
    sequence_order: { type: 'integer', minimum: 0 },
    start_sec: { type: 'number' },
    end_sec: { type: 'number' },
    text: { type: ['string', 'null'] },

    // 익명 diarization 라벨 (자유 문자열, 예: SPEAKER_00)
    speaker_label: { type: 'string' },

    // 화자 역할 후보 (안전선 #1: 확정값 X)
    speaker_role_candidate: { type: 'string', enum: [...ALLOWED_SPEAKER_ROLE_CANDIDATES] },

    label_origin: { type: 'string', enum: [...ALLOWED_METHODS] },
    label_version: { type: 'string', enum: [...ALLOWED_METHODS] },
    confidence_tier: {
      oneOf: [{ type: 'string', enum: ['high', 'medium', 'needs_review'] }, { type: 'null' }],
    },
    label_confidence: {
      oneOf: [{ type: 'number', minimum: 0, maximum: 1 }, { type: 'null' }],
    },

    audio_export_mode: {
      type: 'string',
      enum: ['reference_only', 'embedded'],
    },
    audio_metadata_ref: { type: ['string', 'null'] },

    auto_labels: {
      type: 'object',
      additionalProperties: false,
      properties: {
        emotion: { type: ['object', 'null'] },
        speech_act: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            value: { type: ['string', 'null'] },
            confidence: { type: ['number', 'null'] },
            method: { type: 'string', enum: [...ALLOWED_METHODS] },
          },
        },
      },
    },

    utterance_form: {
      type: ['object', 'null'],
      additionalProperties: true,
    },

    numeric_patterns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'surface_masked', 'normalized_masked', 'pii_related'],
        properties: {
          type: { type: 'string' },
          surface_masked: { type: 'string' },
          normalized_masked: { type: 'string' },
          pii_related: { type: 'boolean' },
        },
      },
    },

    conversation_context: { type: ['object', 'null'] },
    emotion_detail: { type: ['object', 'null'] },

    pii_labels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['startSec', 'endSec', 'maskType', 'piiType'],
        properties: {
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          maskType: { type: 'string' },
          piiType: { type: 'string' },
        },
      },
    },
  },
} as const
