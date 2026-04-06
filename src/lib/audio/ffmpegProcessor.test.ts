import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  processAudio,
  getAudioDuration,
  getAudioStats,
  detectSilenceBoundaries,
  extractSegment,
} from './ffmpegProcessor.js'

/** Create a minimal valid WAV file (16kHz, mono, 16-bit PCM) */
function createTestWav(durationSec: number): Buffer {
  const sampleRate = 16000
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const numSamples = Math.floor(sampleRate * durationSec)
  const dataSize = numSamples * numChannels * bytesPerSample
  const headerSize = 44

  const buffer = Buffer.alloc(headerSize + dataSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)

  // fmt chunk
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)       // chunk size
  buffer.writeUInt16LE(1, 20)        // PCM format
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28) // byte rate
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32)              // block align
  buffer.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  // Generate a 440Hz sine wave
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const value = Math.sin(2 * Math.PI * 440 * t) * 16000
    buffer.writeInt16LE(Math.round(value), headerSize + i * bytesPerSample)
  }

  return buffer
}

/** Create WAV with silence + tone segments for boundary detection */
function createToneSilenceWav(): Buffer {
  const sampleRate = 16000
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8

  // 1s tone + 1s silence + 1s tone = 3s total
  const numSamples = sampleRate * 3
  const dataSize = numSamples * numChannels * bytesPerSample
  const headerSize = 44

  const buffer = Buffer.alloc(headerSize + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28)
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    let value = 0

    if (t < 1.0 || t >= 2.0) {
      // tone segments
      value = Math.sin(2 * Math.PI * 440 * t) * 16000
    }
    // silence segment: value stays 0

    buffer.writeInt16LE(Math.round(value), headerSize + i * bytesPerSample)
  }

  return buffer
}

const testDir = tmpdir()
const inputWav = join(testDir, 'ffmpeg_test_input.wav')
const outputWav = join(testDir, 'ffmpeg_test_output.wav')
const segmentWav = join(testDir, 'ffmpeg_test_segment.wav')
const silenceWav = join(testDir, 'ffmpeg_test_silence.wav')

beforeAll(() => {
  writeFileSync(inputWav, createTestWav(2))
  writeFileSync(silenceWav, createToneSilenceWav())
})

afterAll(() => {
  for (const f of [inputWav, outputWav, segmentWav, silenceWav]) {
    if (existsSync(f)) unlinkSync(f)
  }
})

describe('ffmpegProcessor', () => {
  it('getAudioDuration returns correct duration', async () => {
    const duration = await getAudioDuration(inputWav)
    expect(duration).toBeCloseTo(2, 0)
  })

  it('processAudio produces output file', async () => {
    await processAudio(inputWav, outputWav)
    expect(existsSync(outputWav)).toBe(true)

    const duration = await getAudioDuration(outputWav)
    expect(duration).toBeGreaterThan(0)
  })

  it('getAudioStats returns valid stats', async () => {
    const stats = await getAudioStats(inputWav)
    expect(stats.durationSec).toBeCloseTo(2, 0)
    expect(stats.rmsDb).toBeLessThan(0)
    expect(stats.peakDb).toBeLessThan(0)
    expect(stats.silenceRatio).toBeGreaterThanOrEqual(0)
    expect(stats.silenceRatio).toBeLessThanOrEqual(1)
  })

  it('detectSilenceBoundaries finds boundaries in tone-silence-tone', async () => {
    const boundaries = await detectSilenceBoundaries(silenceWav, {
      silenceThreshold: '-40dB',
      minSilenceDuration: 0.5,
    })
    // Should detect at least 2 segments (before and after silence)
    expect(boundaries.length).toBeGreaterThanOrEqual(2)
  })

  it('extractSegment creates a valid segment', async () => {
    await extractSegment(inputWav, segmentWav, 0, 1)
    expect(existsSync(segmentWav)).toBe(true)

    const duration = await getAudioDuration(segmentWav)
    expect(duration).toBeCloseTo(1, 0)
  })
})
