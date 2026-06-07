// 납품물(발화 코어 레코드) JSON Schema 계약 + 검증기.
// 목적: ZIP 출하 전 발화 레코드 구조를 기계적으로 보증(하드게이트). 바이어에 발행하는
// 스키마 계약이자 export 내부 검증. delivery-record.schema.json 과 동일 정의(단일 출처는 여기).
import { Ajv, type ErrorObject } from 'ajv'

export const DELIVERY_RECORD_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://uncounted.ai/schemas/utterance-delivery-record-v1.json',
  title: 'Uncounted Utterance Delivery Record v1',
  type: 'object',
  // 미래 호환: 추가 필드 허용(코어 계약은 required 로 고정).
  additionalProperties: true,
  required: [
    'utterance_id', 'session_id', 'sequence_order',
    'start_sec', 'end_sec', 'speaker_label', 'text',
  ],
  properties: {
    utterance_id: { type: 'string', minLength: 1 },
    session_id: { type: 'string', minLength: 1 },
    sequence_order: { type: 'integer', minimum: 0 },
    start_sec: { type: 'number', minimum: 0 },
    end_sec: { type: 'number', minimum: 0 },
    duration_sec: { type: ['number', 'null'], minimum: 0 },
    speaker_label: { type: 'string', minLength: 1 },
    speaker_role_candidate: { type: ['string', 'null'] },
    text: { type: 'string' }, // 빈 문자열 허용(무음 발화)
    is_overlapping: { type: ['boolean', 'null'] },
  },
} as const

const ajv = new Ajv({ allErrors: true })
const _validate = ajv.compile(DELIVERY_RECORD_SCHEMA)

export interface SchemaValidationResult {
  valid: boolean
  recordCount: number
  errorCount: number
  errors: string[] // "record[i]<path> <message>" 최대 50개
}

/** 발화 레코드 배열을 스키마로 검증. 위반 시 valid=false + 위치별 에러. */
export function validateDeliveryRecords(
  records: Record<string, unknown>[],
): SchemaValidationResult {
  const errors: string[] = []
  records.forEach((rec, i) => {
    if (!_validate(rec)) {
      for (const e of (_validate.errors ?? []) as ErrorObject[]) {
        errors.push(`record[${i}]${e.instancePath || '/'} ${e.message}`)
      }
    }
  })
  return {
    valid: errors.length === 0,
    recordCount: records.length,
    errorCount: errors.length,
    errors: errors.slice(0, 50),
  }
}
