// ── 개발 S3 스토리지 전체 삭제 스크립트 ──────────────────────────────
// npx tsx src/scripts/purgeDevStorage.ts           (확인 프롬프트)
// npx tsx src/scripts/purgeDevStorage.ts --dry-run  (목록만 출력)
// npx tsx src/scripts/purgeDevStorage.ts --force    (확인 없이 삭제)
//
// 안전장치:
//  1. .env.development만 로드 (운영 환경변수 로드 방지)
//  2. 버킷명 dev. 접두사 필수 — 아니면 즉시 중단
//  3. --dry-run 시 삭제 안 함
//  4. 삭제 전 수동 확인 (y/N)

import { config } from 'dotenv'
import { resolve } from 'path'
import { createInterface } from 'readline'

// .env.development만 로드 (운영 .env 로드 방지)
config({ path: resolve(import.meta.dirname, '../../.env.development') })

// s3 모듈은 환경변수 로드 후 import (모듈 로드 시 env 검증)
const { listObjects, deleteObjects, S3_AUDIO_BUCKET, S3_META_BUCKET } = await import('../lib/s3.js')

const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const isForce = args.includes('--force')

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function assertDevBucket(bucket: string, label: string): void {
  if (!bucket.startsWith('dev.')) {
    console.error(`[ABORT] ${label} 버킷이 dev. 접두사가 아닙니다: ${bucket}`)
    console.error('운영 버킷 삭제를 방지하기 위해 중단합니다.')
    process.exit(1)
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

async function purgeBucket(bucket: string, label: string): Promise<void> {
  console.log(`\n── ${label}: ${bucket} ──`)

  // 전체 오브젝트 목록 조회 (maxKeys 제한 없이)
  const objects = await listObjects(bucket, '', 1_000_000)

  if (objects.length === 0) {
    console.log('  오브젝트 없음 — 건너뜀')
    return
  }

  const totalSize = objects.reduce((sum, o) => sum + o.size, 0)
  console.log(`  오브젝트: ${objects.length.toLocaleString()}개`)
  console.log(`  총 용량: ${formatBytes(totalSize)}`)

  if (isDryRun) {
    // 상위 10개 샘플 출력
    const sample = objects.slice(0, 10)
    for (const obj of sample) {
      console.log(`    ${obj.key} (${formatBytes(obj.size)})`)
    }
    if (objects.length > 10) {
      console.log(`    ... 외 ${objects.length - 10}개`)
    }
    return
  }

  // 배치 삭제
  const keys = objects.map((o) => o.key)
  const BATCH = 1000
  let deleted = 0

  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH)
    await deleteObjects(bucket, batch)
    deleted += batch.length
    console.log(`  삭제 진행: ${deleted.toLocaleString()} / ${keys.length.toLocaleString()}`)
  }

  // 검증: 재조회
  const remaining = await listObjects(bucket, '', 10)
  if (remaining.length === 0) {
    console.log(`  완료 — ${deleted.toLocaleString()}개 삭제됨`)
  } else {
    console.warn(`  [경고] 삭제 후에도 ${remaining.length}개 오브젝트가 남아있습니다`)
  }
}

async function main(): Promise<void> {
  console.log('=== 개발 S3 스토리지 전체 삭제 ===')
  console.log(`모드: ${isDryRun ? 'DRY-RUN (삭제 안 함)' : isForce ? 'FORCE (확인 없이 삭제)' : '대화형'}`)

  // 안전장치: dev 버킷인지 확인
  assertDevBucket(S3_AUDIO_BUCKET, 'AUDIO')
  assertDevBucket(S3_META_BUCKET, 'META')

  console.log(`\nAUDIO 버킷: ${S3_AUDIO_BUCKET}`)
  console.log(`META 버킷:  ${S3_META_BUCKET}`)

  // 동일 버킷이면 한 번만 처리
  const buckets = S3_AUDIO_BUCKET === S3_META_BUCKET
    ? [{ bucket: S3_AUDIO_BUCKET, label: 'AUDIO+META (동일 버킷)' }]
    : [
        { bucket: S3_AUDIO_BUCKET, label: 'AUDIO' },
        { bucket: S3_META_BUCKET, label: 'META' },
      ]

  if (!isDryRun && !isForce) {
    const ok = await confirm(`\n위 개발 버킷의 모든 데이터를 삭제하시겠습니까?`)
    if (!ok) {
      console.log('취소됨.')
      process.exit(0)
    }
  }

  for (const { bucket, label } of buckets) {
    await purgeBucket(bucket, label)
  }

  console.log('\n=== 완료 ===')
}

main().catch((err) => {
  console.error('스크립트 실행 중 오류:', err)
  process.exit(1)
})
