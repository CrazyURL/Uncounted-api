// ── S3 Compatible Storage Client (iwinv) ──────────────────────────────
// AWS SDK v3 기반 S3 호환 스토리지 클라이언트
// S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY 환경변수 필수

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { Agent as HttpsAgent } from 'https'
import { Agent as HttpAgent } from 'http'

const endpoint = process.env.S3_ENDPOINT
const region = process.env.S3_REGION ?? 'kr-standard'
const accessKeyId = process.env.S3_ACCESS_KEY
const secretAccessKey = process.env.S3_SECRET_KEY

if (!endpoint || !accessKeyId || !secretAccessKey) {
  throw new Error(
    'Missing S3 environment variables:\n' +
    '- S3_ENDPOINT\n' +
    '- S3_ACCESS_KEY\n' +
    '- S3_SECRET_KEY\n' +
    'Please configure .env file'
  )
}

// iwinv S3 호환 엔드포인트는 idle 연결을 빠르게 끊기 때문에
// 명시적인 keep-alive 풀과 충분한 timeout이 필요하다.
// 기본 핸들러는 socket pooling 없이 매 요청마다 새 TCP 연결을 만들고
// idle 시 서버측에서 끊어 socket hang up이 자주 발생한다.
const httpsAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
})
const httpAgent = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
  maxFreeSockets: 16,
})

const requestHandler = new NodeHttpHandler({
  connectionTimeout: 10_000,   // TCP 연결 수립 한도
  requestTimeout: 300_000,     // 5분 — 대용량 multipart part 1개 업로드 여유
  httpsAgent,
  httpAgent,
})

export const s3Client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
  requestHandler,
  // SDK 레벨 자동 재시도 (지수 backoff). socket hang up은 retryable로 분류됨.
  maxAttempts: 5,
})

console.log('[s3] client initialized', {
  endpoint,
  region,
  forcePathStyle: true,
  accessKeyIdPrefix: accessKeyId.slice(0, 4),
  keepAlive: true,
  maxSockets: 64,
  requestTimeoutMs: 300_000,
  maxAttempts: 5,
})

export const S3_AUDIO_BUCKET = process.env.S3_AUDIO_BUCKET ?? 'sanitized-audio'
export const S3_META_BUCKET = process.env.S3_META_BUCKET ?? 'meta-jsonl'
export const EXPORTS_PREFIX = 'exports/'

function describeS3Error(err: unknown): Record<string, unknown> {
  const e = err as {
    name?: string
    message?: string
    Code?: string
    $metadata?: { httpStatusCode?: number; requestId?: string }
    $response?: { statusCode?: number }
  }
  return {
    name: e?.name,
    code: e?.Code,
    message: e?.message,
    httpStatus: e?.$metadata?.httpStatusCode ?? e?.$response?.statusCode,
    requestId: e?.$metadata?.requestId,
  }
}

/** 파일 업로드 (upsert 동작: 동일 키 덮어쓰기) */
export async function uploadObject(
  bucket: string,
  key: string,
  body: Uint8Array | string,
  contentType: string,
): Promise<void> {
  const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
  const startedAt = Date.now()
  console.log('[s3] uploadObject:start', { bucket, key, contentType, bytes: size })
  try {
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    )
    console.log('[s3] uploadObject:ok', {
      bucket,
      key,
      bytes: size,
      ms: Date.now() - startedAt,
    })
  } catch (err) {
    console.error('[s3] uploadObject:fail', {
      bucket,
      key,
      bytes: size,
      ms: Date.now() - startedAt,
      ...describeS3Error(err),
    })
    throw err
  }
}

/** 파일 다건 삭제 */
export async function deleteObjects(bucket: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return

  // DeleteObjects 최대 1000개 제한
  const BATCH = 1000
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH)
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    )
  }
}

/** prefix 기준 오브젝트 목록 조회 */
export async function listObjects(
  bucket: string,
  prefix: string,
  maxKeys = 10000,
): Promise<{ key: string; size: number }[]> {
  const result: { key: string; size: number }[] = []
  let continuationToken: string | undefined

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: Math.min(maxKeys - result.length, 1000),
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of response.Contents ?? []) {
      if (obj.Key) {
        result.push({ key: obj.Key, size: obj.Size ?? 0 })
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken && result.length < maxKeys)

  return result
}

/**
 * prefix 기준 "폴더" 목록 조회 (CommonPrefixes)
 * Supabase .list('') 의 대체: delimiter='/' 로 최상위 폴더만 반환
 */
export async function listFolders(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: 1000,
    }),
  )

  return (response.CommonPrefixes ?? [])
    .map((p) => p.Prefix ?? '')
    .filter(Boolean)
}

/** 단일 presigned URL 생성 */
export async function getSignedUrl(
  bucket: string,
  key: string,
  expiresIn: number,
  filename?: string,
): Promise<string> {
  return awsGetSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename}"` } : {}),
    }),
    { expiresIn },
  )
}

/** 내보내기 패키지 ZIP 업로드 */
export async function uploadExportPackage(
  requestId: string,
  zipBuffer: Uint8Array,
): Promise<string> {
  const key = `${EXPORTS_PREFIX}${requestId}.zip`
  console.log('[s3] uploadExportPackage', { requestId, key, bytes: zipBuffer.byteLength })
  await uploadObject(S3_AUDIO_BUCKET, key, zipBuffer, 'application/zip')
  return key
}

/** 내보내기 패키지 다운로드 presigned URL 생성 */
export async function getExportDownloadUrl(
  requestId: string,
  expiresIn = 3600,
): Promise<string> {
  const key = `${EXPORTS_PREFIX}${requestId}.zip`
  return getSignedUrl(S3_AUDIO_BUCKET, key, expiresIn)
}

/** 배치 presigned URL 생성 */
export async function getSignedUrls(
  bucket: string,
  keys: string[],
  expiresIn: number,
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>()

  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        const url = await getSignedUrl(bucket, key, expiresIn)
        return { key, url }
      } catch {
        return { key, url: null }
      }
    }),
  )

  for (const { key, url } of results) {
    if (url) urlMap.set(key, url)
  }

  return urlMap
}
