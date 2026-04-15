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

export const s3Client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
})

export const S3_AUDIO_BUCKET = process.env.S3_AUDIO_BUCKET ?? 'sanitized-audio'
export const S3_META_BUCKET = process.env.S3_META_BUCKET ?? 'meta-jsonl'
export const EXPORTS_PREFIX = 'exports/'

/** 파일 업로드 (upsert 동작: 동일 키 덮어쓰기) */
export async function uploadObject(
  bucket: string,
  key: string,
  body: Uint8Array | string,
  contentType: string,
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  )
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
