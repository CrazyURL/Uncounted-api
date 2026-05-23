/**
 * Export safety scan — ZIP staging dir 콘텐츠 검사.
 *
 * 안전선 적용:
 *   #1: speaker role JSON value 가 self/other/owner/counterparty 확정값이면 violation
 *       (owner_candidate / counterparty_candidate / unknown 만 허용)
 *   #3: pii_labels[].original 키 노출 차단
 *   #4: numeric_patterns[].surface_text / normalized 키 노출 차단
 *   #6: 내부 모델명 / 학습 출처 / 내부 리포트 키워드 노출 차단 (Hard Block)
 *
 * 호출 시점: archiver 로 zip 생성 직전, staging dir 전체 파일 scan.
 * violations.length > 0 → 빌더가 throw, ZIP 생성 중단.
 */

import { promises as fs } from 'fs'
import path from 'path'
import { sanitizeExternalMethod } from '../../lib/export/transforms.js'
import { parseNameDenylist, maskKnownNames } from '../../lib/piiNameMask.js'

// ── 키워드 / 키 / value 화이트리스트 ──────────────────────────────────────

const HARD_BLOCK_KEYWORDS: readonly string[] = [
  'aihub', 'AI Hub', 'AIHUB',
  'KcELECTRA', 'kc-electra', 'kcelectra',
  'WhisperX', 'whisperx',
  'pyannote', 'WeSpeaker', 'wespeaker',
  'HuggingFace', 'HF_TOKEN',
  'snunlp', 'KR-ELECTRA',
  'finetune', 'finetuning_readiness',
  'model_pipeline_report', 'internal_',
  'train_emotion', 'train_speech_age',
  'train_dialog_act', 'train_topic',
]

const FORBIDDEN_JSON_KEYS: readonly string[] = [
  'original', 'surface_text', 'normalized',
  // audio_manifest 하드닝: 내부 S3 키/경로는 외부 ZIP 미노출 (audio_reference_id 만 허용).
  's3_key', 'storage_path',
]

// 내부 S3 URI / signed URL 노출 차단 (bucket·token 누출 벡터).
const FORBIDDEN_CONTENT_PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 's3:// URI', re: /s3:\/\//i },
  { label: 'AWS signed URL param', re: /[?&]X-Amz-(Signature|Credential|Security-Token)=/i },
]

const FORBIDDEN_SPEAKER_ROLE_VALUES: readonly string[] = [
  'self', 'other', 'owner', 'counterparty',
]

// speaker_label 은 익명 diarization 라벨 (예: SPEAKER_00) — 안전선 #1 대상 아님.
// 화자 역할 후보값을 담는 필드만 검사한다.
const SPEAKER_ROLE_FIELDS: readonly string[] = [
  'speaker_role', 'speakerRole', 'speaker_role_candidate', 'role',
]

// 안전선 #6 — 추가 권고 워닝 (외부 노출 금지 아님, 점검 단계).
const WARNING_KEYWORDS: readonly string[] = [
  'train_', 'training-ready', 'train_data',
]

// 스캔 대상 확장자
const TEXT_EXTENSIONS: readonly string[] = ['.json', '.jsonl', '.md', '.txt']
const JSON_LIKE_EXTENSIONS: readonly string[] = ['.json', '.jsonl']

// ── 결과 타입 ─────────────────────────────────────────────────────────────

export interface ExportSafetyResult {
  violations: string[]
  warnings: string[]
}

// ── 메인 검증 ────────────────────────────────────────────────────────────

/**
 * staging dir 전체를 재귀 스캔.
 *
 * @returns violations / warnings 배열. violations 가 비어 있어야 ZIP 생성 가능.
 */
export async function validateExportSafety(
  stagingDir: string,
): Promise<ExportSafetyResult> {
  const violations: string[] = []
  const warnings: string[] = []

  // Track 0 응급 PII — 알려진 실명(PII_NAME_DENYLIST)이 내보내기 결과물에 있으면
  // fail-closed 로 ZIP 차단. 메시지에 이름 자체는 노출하지 않는다(재유출 방지).
  const nameDenylist = parseNameDenylist()

  const files = await collectTextFiles(stagingDir)

  for (const filePath of files) {
    const rel = path.relative(stagingDir, filePath)
    const ext = path.extname(filePath).toLowerCase()
    const content = await fs.readFile(filePath, 'utf-8')

    // 안전선 #6 — Hard Block 키워드 (case-insensitive substring)
    const lowered = content.toLowerCase()
    for (const kw of HARD_BLOCK_KEYWORDS) {
      if (lowered.includes(kw.toLowerCase())) {
        violations.push(`${rel}: hard-block keyword "${kw}"`)
      }
    }

    // 워닝 키워드
    for (const kw of WARNING_KEYWORDS) {
      if (lowered.includes(kw.toLowerCase())) {
        warnings.push(`${rel}: warning keyword "${kw}"`)
      }
    }

    // 내부 S3 URI / signed URL 패턴 (안전선: bucket·token 누출 차단)
    for (const { label, re } of FORBIDDEN_CONTENT_PATTERNS) {
      if (re.test(content)) {
        violations.push(`${rel}: forbidden content pattern "${label}"`)
      }
    }

    // Track 0 응급 PII — denylist 실명이 결과물에 있으면 차단 (이름 미노출).
    if (nameDenylist.length > 0 && maskKnownNames(content, nameDenylist) !== content) {
      violations.push(`${rel}: forbidden PII name match (PII_NAME_DENYLIST)`)
    }

    if (JSON_LIKE_EXTENSIONS.includes(ext)) {
      // 안전선 #3, #4 — 금지 키 + 안전선 #1 — speaker role 값 검사 (JSON 파싱 기반)
      checkJsonContent(rel, ext, content, violations)
    }
  }

  return { violations, warnings }
}

// ── 헬퍼: 텍스트 파일 수집 ───────────────────────────────────────────────

async function collectTextFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  await walk(dir, out)
  return out
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, out)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (TEXT_EXTENSIONS.includes(ext)) {
        out.push(full)
      }
    }
  }
}

// ── 헬퍼: JSON 콘텐츠 검사 ───────────────────────────────────────────────

function checkJsonContent(
  rel: string,
  ext: string,
  content: string,
  violations: string[],
): void {
  if (ext === '.jsonl') {
    const lines = content.split(/\r?\n/)
    lines.forEach((line, idx) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      const parsed = safeParse(trimmed)
      if (parsed === undefined) {
        violations.push(`${rel}:${idx + 1}: invalid JSON line`)
        return
      }
      inspectNode(rel, `line ${idx + 1}`, parsed, violations)
    })
    return
  }

  // .json
  const parsed = safeParse(content)
  if (parsed === undefined) {
    violations.push(`${rel}: invalid JSON`)
    return
  }
  inspectNode(rel, 'root', parsed, violations)
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

function inspectNode(
  rel: string,
  pathLabel: string,
  node: unknown,
  violations: string[],
): void {
  if (node === null || node === undefined) return

  if (Array.isArray(node)) {
    node.forEach((item, idx) => {
      inspectNode(rel, `${pathLabel}[${idx}]`, item, violations)
    })
    return
  }

  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      // 금지 키 검사 (#3, #4)
      if (FORBIDDEN_JSON_KEYS.includes(key)) {
        violations.push(
          `${rel}:${pathLabel}: forbidden key "${key}" (안전선 #3/#4)`,
        )
      }

      // speaker role value 검사 (#1) — 정확 일치
      if (SPEAKER_ROLE_FIELDS.includes(key) && typeof value === 'string') {
        const lower = value.toLowerCase().trim()
        if (FORBIDDEN_SPEAKER_ROLE_VALUES.includes(lower)) {
          violations.push(
            `${rel}:${pathLabel}.${key}: forbidden speaker role value "${value}" (안전선 #1)`,
          )
        }
      }

      inspectNode(rel, `${pathLabel}.${key}`, value, violations)
    }
  }
}

// ── re-export: method sanitize (외부에서 단일 import 로 쓰게) ─────────────

/**
 * 모델명 / 메서드 식별자 → 외부 허용값 (5종).
 * `transforms.sanitizeExternalMethod` 의 얇은 wrapper — import 경로 단순화용.
 */
export function sanitizeMethodValue(value: unknown): string {
  return sanitizeExternalMethod(value)
}

export const FORBIDDEN_SPEAKER_ROLES = FORBIDDEN_SPEAKER_ROLE_VALUES
export const ALLOWED_SPEAKER_ROLES = ['owner_candidate', 'counterparty_candidate', 'unknown'] as const
export const HARD_BLOCK_KEYWORD_LIST = HARD_BLOCK_KEYWORDS
