#!/usr/bin/env bash
# 로컬 sample_data/Call에서 길이 기준 벤치마크 샘플 선별
# 사용법: ./scripts/pick-local-samples.sh <min_sec> <max_sec> <count> <src_dir> <out_dir>

set -euo pipefail

MIN_SEC=${1:-600}
MAX_SEC=${2:-1800}
COUNT=${3:-4}
SRC=${4:-/Users/gdash/project/uncounted-project/sample_data/Call}
OUT=${5:-./benchmark-samples/long}

mkdir -p "$OUT"

echo "소스: $SRC"
echo "버킷: ${MIN_SEC}~${MAX_SEC}s, 개수: $COUNT"
echo "출력: $OUT"
echo

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# duration\tpath 로 모든 m4a 스캔
find "$SRC" -maxdepth 1 -type f -name "*.m4a" -print0 | while IFS= read -r -d '' f; do
  dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null || echo "0")
  dur_int=$(printf "%.0f" "$dur" 2>/dev/null || echo "0")
  if [[ "$dur_int" -ge "$MIN_SEC" && "$dur_int" -le "$MAX_SEC" ]]; then
    printf "%d\t%s\n" "$dur_int" "$f" >> "$TMP"
  fi
done

TOTAL=$(wc -l < "$TMP" | tr -d ' ')
echo "버킷 일치: ${TOTAL}개"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "조건에 맞는 파일 없음."
  exit 0
fi

# 최신 파일명(YYMMDD_HHMMSS) 기준 역순 정렬 → 상위 COUNT개 선택
# 파일명에 timestamp가 _260404_064642 형식으로 포함됨 — lexical sort로 최신순
sort -t$'\t' -k2,2 -r "$TMP" | head -n "$COUNT" > "${TMP}.picked"

MANIFEST="$OUT/../samples.json"
mkdir -p "$(dirname "$MANIFEST")"
echo '{"generated_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","bucket":"long","duration_range_sec":['"$MIN_SEC"','"$MAX_SEC"'],"samples":[' > "$MANIFEST"

FIRST=1
while IFS=$'\t' read -r dur path; do
  HASH=$(echo -n "$path" | shasum -a 256 | cut -c1-8)
  DEST="$OUT/${HASH}.m4a"
  cp "$path" "$DEST"
  SIZE=$(stat -f%z "$DEST")
  SIZE_MB=$(echo "scale=1; $SIZE/1048576" | bc)
  echo "  ✓ $HASH | ${dur}s | ${SIZE_MB} MB"

  if [[ $FIRST -eq 0 ]]; then echo "," >> "$MANIFEST"; fi
  printf '  {"hash":"%s","duration":%d,"size_bytes":%d,"file":"long/%s.m4a"}' "$HASH" "$dur" "$SIZE" "$HASH" >> "$MANIFEST"
  FIRST=0
done < "${TMP}.picked"

echo "" >> "$MANIFEST"
echo "]}" >> "$MANIFEST"
rm -f "${TMP}.picked"

echo
echo "완료: $MANIFEST"
