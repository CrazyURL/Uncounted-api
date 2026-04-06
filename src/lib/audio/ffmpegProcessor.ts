import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string)

export interface ProcessAudioOptions {
  noiseReduction?: number   // afftdn nr value, default 20
  silenceThreshold?: string // default '-50dB'
  targetLoudness?: number   // LUFS, default -23
}

export interface AudioStats {
  durationSec: number
  rmsDb: number
  peakDb: number
  silenceRatio: number
}

export interface SilenceBoundary {
  start: number
  end: number
}

/**
 * Process audio: noise reduction + silence trimming + loudness normalization + 16kHz mono
 */
export async function processAudio(
  inputPath: string,
  outputPath: string,
  options?: ProcessAudioOptions,
): Promise<void> {
  const nr = options?.noiseReduction ?? 20
  const threshold = options?.silenceThreshold ?? '-50dB'
  const loudness = options?.targetLoudness ?? -23

  const filters = [
    `afftdn=nr=${nr}:nt=w`,
    `silenceremove=start_periods=1:start_duration=0:start_threshold=${threshold}:detection=peak`,
    `loudnorm=I=${loudness}:TP=-1:LRA=11`,
  ]

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(filters)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`processAudio failed: ${err.message}`)))
      .run()
  })
}

/**
 * Get audio duration in seconds
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`getAudioDuration failed: ${err.message}`))
        return
      }
      resolve(metadata.format.duration ?? 0)
    })
  })
}

/**
 * Analyze audio and return quality stats (SNR, RMS, etc)
 */
export async function getAudioStats(filePath: string): Promise<AudioStats> {
  const duration = await getAudioDuration(filePath)

  const astatsOutput = await runFfmpegFilter(filePath, 'astats=metadata=1:reset=0', 'null')

  const rmsMatch = astatsOutput.match(/RMS level dB:\s*([-\d.]+)/)
  const peakMatch = astatsOutput.match(/Peak level dB:\s*([-\d.]+)/)

  const rmsDb = rmsMatch ? parseFloat(rmsMatch[1]) : -Infinity
  const peakDb = peakMatch ? parseFloat(peakMatch[1]) : -Infinity

  // Detect silence to calculate ratio
  const silenceOutput = await runFfmpegFilter(
    filePath,
    'silencedetect=noise=-40dB:d=0.3',
    'null',
  )

  let totalSilence = 0
  const silenceStartRegex = /silence_start:\s*([\d.]+)/g
  const silenceEndRegex = /silence_end:\s*([\d.]+)/g

  const starts: number[] = []
  const ends: number[] = []

  let match: RegExpExecArray | null
  while ((match = silenceStartRegex.exec(silenceOutput)) !== null) {
    starts.push(parseFloat(match[1]))
  }
  while ((match = silenceEndRegex.exec(silenceOutput)) !== null) {
    ends.push(parseFloat(match[1]))
  }

  for (let i = 0; i < starts.length; i++) {
    const end = i < ends.length ? ends[i] : duration
    totalSilence += end - starts[i]
  }

  const silenceRatio = duration > 0 ? totalSilence / duration : 0

  return { durationSec: duration, rmsDb, peakDb, silenceRatio }
}

/**
 * Split audio at silence boundaries into utterances (5-30s segments)
 */
export async function detectSilenceBoundaries(
  filePath: string,
  options?: {
    silenceThreshold?: string // default '-40dB'
    minSilenceDuration?: number // default 0.5 seconds
  },
): Promise<SilenceBoundary[]> {
  const threshold = options?.silenceThreshold ?? '-40dB'
  const minDuration = options?.minSilenceDuration ?? 0.5

  const output = await runFfmpegFilter(
    filePath,
    `silencedetect=noise=${threshold}:d=${minDuration}`,
    'null',
  )

  const duration = await getAudioDuration(filePath)
  const boundaries: SilenceBoundary[] = []

  const silenceEndRegex = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g

  let lastEnd = 0
  let match: RegExpExecArray | null
  while ((match = silenceEndRegex.exec(output)) !== null) {
    const silenceEnd = parseFloat(match[1])
    const silenceDur = parseFloat(match[2])
    const silenceStart = silenceEnd - silenceDur

    if (silenceStart > lastEnd) {
      boundaries.push({ start: lastEnd, end: silenceStart })
    }
    lastEnd = silenceEnd
  }

  // Add final segment if there's remaining audio
  if (lastEnd < duration) {
    boundaries.push({ start: lastEnd, end: duration })
  }

  return boundaries
}

/**
 * Extract a segment from audio file
 */
export async function extractSegment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .setDuration(endSec - startSec)
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(new Error(`extractSegment failed: ${err.message}`)))
      .run()
  })
}

/** Internal: run ffmpeg with a filter and capture stderr output */
function runFfmpegFilter(
  inputPath: string,
  filter: string,
  outputFormat: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = ''

    ffmpeg(inputPath)
      .audioFilters(filter)
      .format(outputFormat)
      .output('/dev/null')
      .on('stderr', (line: string) => {
        stderr += line + '\n'
      })
      .on('end', () => resolve(stderr))
      .on('error', (err: Error) => {
        // ffmpeg often exits with error for null output but still produces useful stderr
        if (stderr.length > 0) {
          resolve(stderr)
        } else {
          reject(new Error(`ffmpeg filter failed: ${err.message}`))
        }
      })
      .run()
  })
}
