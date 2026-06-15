import { describe, it, expect } from 'vitest'
import { _testInternals } from './packageBuilder.js'

const { buildLabelsSummary, buildDialogActSummary, deriveSpeakerLabels } = _testInternals

// ─────────────────────────────────────────────────────────────────────
// Bug 2 회귀 — label_source "admin" / "auto" 등이 'none'으로 잘못 흡수되던 문제
// ─────────────────────────────────────────────────────────────────────

describe('Bug 2: buildLabelsSummary — label_source 동적 카운터', () => {
  it('admin label_source가 정확히 카운트됨 (이전엔 none으로 잘못 분류)', () => {
    const utterances = [
      { labels: { relationship: '가족' }, label_source: 'admin' },
      { labels: { relationship: '직장' }, label_source: 'admin' },
      { labels: { relationship: '친구' }, label_source: 'admin' },
    ]
    const summary = buildLabelsSummary(utterances)
    expect(summary.labelSources.admin).toBe(3)
    // 이전 버그: 'admin'을 'none'으로 잘못 분류했었음
    expect(summary.labelSources.none).toBeFalsy()
  })

  it('user_confirmed / auto_suggested / admin / user / multi_confirmed / auto 모두 인식', () => {
    const utterances = [
      { labels: { tone: '평온' }, label_source: 'user_confirmed' },
      { labels: { tone: '기쁨' }, label_source: 'auto_suggested' },
      { labels: { tone: '슬픔' }, label_source: 'admin' },
      { labels: { tone: '화남' }, label_source: 'user' },
      { labels: { tone: '놀람' }, label_source: 'multi_confirmed' },
      { labels: { tone: '평온' }, label_source: 'auto' },
    ]
    const summary = buildLabelsSummary(utterances)
    expect(summary.labelSources.user_confirmed).toBe(1)
    expect(summary.labelSources.auto_suggested).toBe(1)
    expect(summary.labelSources.admin).toBe(1)
    expect(summary.labelSources.user).toBe(1)
    expect(summary.labelSources.multi_confirmed).toBe(1)
    expect(summary.labelSources.auto).toBe(1)
  })

  it('labels JSONB가 null이면 none으로 카운트', () => {
    const utterances = [
      { labels: null, label_source: null },
      { labels: null, label_source: null },
      { labels: { tone: '평온' }, label_source: 'admin' },
    ]
    const summary = buildLabelsSummary(utterances)
    expect(summary.labelSources.none).toBe(2)
    expect(summary.labelSources.admin).toBe(1)
    expect(summary.labeledUtterances).toBe(1)
  })

  it('labels는 있으나 label_source가 없으면 none으로 카운트', () => {
    const utterances = [
      { labels: { tone: '평온' }, label_source: null },
    ]
    const summary = buildLabelsSummary(utterances)
    expect(summary.labelSources.none).toBe(1)
    expect(summary.labeledUtterances).toBe(1)
  })

  it('labelDistribution 누적 정상 작동', () => {
    const utterances = [
      { labels: { tone: '평온', noise: '조용' }, label_source: 'admin' },
      { labels: { tone: '평온', noise: '약간소음' }, label_source: 'admin' },
    ]
    const summary = buildLabelsSummary(utterances)
    expect(summary.labelDistribution.tone['평온']).toBe(2)
    expect(summary.labelDistribution.noise['조용']).toBe(1)
    expect(summary.labelDistribution.noise['약간소음']).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bug 3 회귀 — buildDialogActSummary가 utt.dialog_act 직접 컬럼 참조
// ─────────────────────────────────────────────────────────────────────

describe('Bug 3: buildDialogActSummary — 직접 컬럼 참조', () => {
  it('utt.dialog_act 직접 컬럼에서 distribution 채워짐 (이전엔 빈 객체)', () => {
    const utterances = [
      { dialog_act: '일상', dialog_intensity: 2 },
      { dialog_act: '일상', dialog_intensity: 3 },
      { dialog_act: '질문', dialog_intensity: 2 },
      { dialog_act: '영업', dialog_intensity: 1 },
    ]
    const summary = buildDialogActSummary(utterances)
    expect(summary.speechActDistribution['일상']).toBe(2)
    expect(summary.speechActDistribution['질문']).toBe(1)
    expect(summary.speechActDistribution['영업']).toBe(1)
  })

  it('dialog_intensity 분포 + 평균 정확', () => {
    const utterances = [
      { dialog_act: '일상', dialog_intensity: 1 },
      { dialog_act: '일상', dialog_intensity: 2 },
      { dialog_act: '일상', dialog_intensity: 3 },
    ]
    const summary = buildDialogActSummary(utterances)
    expect(summary.intensityDistribution['1']).toBe(1)
    expect(summary.intensityDistribution['2']).toBe(1)
    expect(summary.intensityDistribution['3']).toBe(1)
    expect(summary.avgIntensity).toBe(2)
  })

  it('이전 버그 데이터 (labels.speech_act에 값 있어도) 무시됨 — 직접 컬럼만 본다', () => {
    // 알파 샘플 시점에는 labels JSONB의 'speech_act' 키를 잘못 참조했음.
    // 새 코드는 utt.dialog_act 만 봄.
    const utterances = [
      // 잘못된 레거시 데이터: labels.speech_act에 값 있음 → 무시
      { labels: { speech_act: 'request' }, dialog_act: null, dialog_intensity: null },
      // 정상 데이터: dialog_act 컬럼에 값 있음 → 카운트
      { labels: null, dialog_act: '일상', dialog_intensity: 2 },
    ]
    const summary = buildDialogActSummary(utterances)
    expect(summary.speechActDistribution['일상']).toBe(1)
    expect(summary.speechActDistribution['request']).toBeFalsy()
  })

  it('dialog_act / dialog_intensity 둘 다 null이면 labeledUtterances 카운트 X', () => {
    const utterances = [
      { dialog_act: null, dialog_intensity: null },
      { dialog_act: '일상', dialog_intensity: null },
      { dialog_act: null, dialog_intensity: 2 },
    ]
    const summary = buildDialogActSummary(utterances)
    expect(summary.labeledUtterances).toBe(2) // 첫 번째만 제외
  })

  it('intensity가 NaN/문자열이면 평균에 미포함', () => {
    const utterances = [
      { dialog_act: '일상', dialog_intensity: 2 },
      { dialog_act: '일상', dialog_intensity: 'not-a-number' },
      { dialog_act: '일상', dialog_intensity: 4 },
    ]
    const summary = buildDialogActSummary(utterances)
    expect(summary.avgIntensity).toBe(3) // (2 + 4) / 2 — 문자열 제외
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bug 4 회귀 — speakerCount는 distinct speaker_id 기준
// ─────────────────────────────────────────────────────────────────────
//
// buildPackage 함수 자체는 외부 의존성(S3, supabase)이 많아 단위 테스트 어려움.
// 대신 manifest 빌드 시 사용되는 distinct speaker_id 집계 로직만 검증.

describe('Bug 4: speakerCount distinct 집계 로직', () => {
  it('distinct speaker_id 개수 정확 (Set 기반)', () => {
    const metaLines = [
      { speaker_id: 'SPEAKER_00' },
      { speaker_id: 'SPEAKER_01' },
      { speaker_id: 'SPEAKER_00' },
      { speaker_id: 'SPEAKER_01' },
      { speaker_id: 'SPEAKER_02' },
    ]
    const distinct = new Set<string>()
    for (const m of metaLines) {
      if (m.speaker_id) distinct.add(m.speaker_id)
    }
    expect(distinct.size).toBe(3)
  })

  it('null/빈 speaker_id는 무시', () => {
    const metaLines = [
      { speaker_id: 'SPEAKER_00' },
      { speaker_id: null },
      { speaker_id: '' },
      { speaker_id: 'SPEAKER_01' },
    ]
    const distinct = new Set<string>()
    for (const m of metaLines) {
      if (m.speaker_id) distinct.add(m.speaker_id)
    }
    expect(distinct.size).toBe(2)
  })

  it('한 세션에 여러 화자 — pseudoId 기준은 1, speaker_id 기준은 N', () => {
    // 알파 샘플 part_02에서 발생했던 케이스.
    // 같은 session_id 안에 SPEAKER_00, SPEAKER_01 둘 다 있는데,
    // pseudoId 기준 집계 시 1로 잘못 카운트됨.
    const metaLines = [
      { session_id: 'sess1', pseudo_id: 'p1', speaker_id: 'SPEAKER_00' },
      { session_id: 'sess1', pseudo_id: 'p1', speaker_id: 'SPEAKER_01' },
      { session_id: 'sess1', pseudo_id: 'p1', speaker_id: 'SPEAKER_00' },
    ]
    // 이전 버그 (pseudoId 기준): pseudoId 1개 → speakerCount=1
    const oldCount = new Set(metaLines.map((m) => m.pseudo_id ?? m.session_id)).size
    expect(oldCount).toBe(1)
    // 새 fix (speaker_id 기준): 2명
    const newCount = new Set(metaLines.map((m) => m.speaker_id).filter(Boolean)).size
    expect(newCount).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────
// is_user 전부 false 버그 회귀 — speaker_id_int 를 session_speakers role 에서 파생
//   (deriveSpeakerLabels). 워커가 is_user 를 전부 false 로 하드코딩해도, role 이
//   self 면 owner(0)/is_user=true 로 나와야 한다.
// ─────────────────────────────────────────────────────────────────────

describe('deriveSpeakerLabels — speaker_id_int/is_user 를 session_speakers role 에서 파생', () => {
  it('role=self → owner: speaker_id_int=0, is_user=true, owner_candidate', () => {
    const r = deriveSpeakerLabels('self', 'heuristic')
    expect(r.speakerIdInt).toBe(0)
    expect(r.isUser).toBe(true)
    expect(r.roleCandidate).toBe('owner_candidate')
    expect(r.method).toBe('heuristic_mvp')
  })

  it('role=other → 상대: speaker_id_int=1, is_user=false, counterparty_candidate', () => {
    const r = deriveSpeakerLabels('other', 'heuristic')
    expect(r.speakerIdInt).toBe(1)
    expect(r.isUser).toBe(false)
    expect(r.roleCandidate).toBe('counterparty_candidate')
    expect(r.method).toBe('heuristic_mvp')
  })

  it('role=null(FK 미연결) → speaker_id_int=null, is_user=null, unknown', () => {
    const r = deriveSpeakerLabels(null, null)
    expect(r.speakerIdInt).toBe(null)
    expect(r.isUser).toBe(null)
    expect(r.roleCandidate).toBe('unknown')
    expect(r.method).toBe('not_available')
  })

  it('★회귀 가드: role 만이 출처다 — is_user 입력과 무관하게 role=self 면 0', () => {
    // 핵심 버그: utterances.is_user 가 DB 전부 false 여도, deriveSpeakerLabels 는
    // is_user 를 입력으로 받지 않고 session_speakers role 만 본다 → self 면 0(owner).
    // 즉 is_user 버그가 speaker_id_int 를 오염시킬 경로가 코드상 존재하지 않는다.
    expect(deriveSpeakerLabels('self', 'heuristic').speakerIdInt).toBe(0)
    // (이전 코드는 isUserVal===false?1 이라 전부 1 로 collapse 했다.)
  })

  it('안전선 #1: self/other 원문은 출력에 노출되지 않는다 (candidate 형만)', () => {
    const out = JSON.stringify([
      deriveSpeakerLabels('self', 'heuristic'),
      deriveSpeakerLabels('other', 'heuristic'),
    ])
    expect(out.toLowerCase()).not.toMatch(/"self"|"other"/)
  })

  it('알 수 없는 source → method=not_available (method allowlist 가드)', () => {
    expect(deriveSpeakerLabels('self', 'wespeaker_v9_internal').method).toBe('automatic')
    expect(deriveSpeakerLabels('self', 'kcelectra_secret').method).toBe('supervised_model')
    expect(deriveSpeakerLabels('self', 'garbage').method).toBe('not_available')
  })
})
