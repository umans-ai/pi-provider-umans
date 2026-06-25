#!/usr/bin/env bash
# Test the umans-provider extension against every supported Umans model.
#
# Runs headless pi sessions (`pi -p`) in parallel, one per model, and checks
# each returns the expected deterministic reply. Uses --thinking to exercise
# the adaptive-thinking code path (the default after the forceAdaptiveThinking fix).
#
# Usage:
#   ./test-umans.sh [thinking-level] [parallel] [prompt] [expect]
#   ./test-umans.sh                  # medium, 4 parallel, code-trace prompt (expect 133)
#   ./test-umans.sh high 2
#   ./test-umans.sh medium 4 'Reply with exactly: PONG' PONG
#   UMANS_API_KEY=uk-... ./test-umans.sh
set -u

THINKING="${1:-medium}"
PARALLEL="${2:-4}"
# Default prompt forces reading a code snippet + multi-step reasoning (loop,
# conditional, modulo, square, add/subtract) to reach a distinctive answer. This
# exercises the adaptive-thinking path with real work, not a canned echo.
PROMPT="${3:-Read this code carefully and trace its execution step by step in your thinking, then reply with ONLY the final number printed (no explanation, no code, no punctuation):

total = 0
for n in [3, 7, 2, 9, 4]:
    if n % 2 == 1:
        total += n * n
    else:
        total -= n
print(total)

Reply with just that number.}"
EXPECT="${4:-133}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$HERE/index.ts"

# pi resolves $UMANS_API_KEY or the key stored in ~/.pi/agent/auth.json.
export UMANS_API_KEY="${UMANS_API_KEY:-}"

# pi binary; rebuilt in run_one since arrays don't export across xargs.
PI_BIN=pi

# Enumerate models from the live provider registration.
mapfile -t MODELS < <("$PI_BIN" -e "$EXT" --no-extensions --list-models umans 2>/dev/null | awk '$1 == "umans" { print $2 }')
if [ "${#MODELS[@]}" -eq 0 ]; then
  echo "FATAL: no umans models registered (extension failed to load?)" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "umans-provider test: ${#MODELS[@]} models, thinking=$THINKING, parallel=$PARALLEL"
echo "prompt: \"$PROMPT\" (expect: \"$EXPECT\")"
echo

run_one() {
  local model="$1" out="$TMP/$model.out" err="$TMP/$model.err"
  local attempt rc body t0 t1 secs status
  for attempt in 1 2 3; do
    t0=$(date +%s.%N)
    timeout 90 "$PI_BIN" -e "$EXT" --no-extensions --no-session --no-tools \
      --model "umans/$model" --thinking "$THINKING" -p "$PROMPT" >"$out" 2>"$err"
    rc=$?
    t1=$(date +%s.%N)
    if [ "$rc" -eq 0 ] && grep -qwi "$EXPECT" "$out"; then
      status="PASS"; break; fi
    # Retry on transient failure (empty body, non-zero exit, or wrong reply).
    status="FAIL(exit=$rc,try=$attempt)"
    sleep 1
  done
  secs=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')
  printf '%-26s %-20s %ss\n' "$model" "$status" "$secs" >"$TMP/$model.res"
  [ "$status" = PASS ] || tail -n 3 "$err" >"$TMP/$model.tail"
}
export -f run_one
export PI_BIN EXT TMP THINKING PROMPT EXPECT

# Parallel fan-out.
printf '%s\n' "${MODELS[@]}" | xargs -I{} -P "$PARALLEL" bash -c 'run_one "$@"' _ {}

# Ordered summary.
pass=0; fail=0
echo "----------------------------------------"
for m in "${MODELS[@]}"; do
  cat "$TMP/$m.res"
  if grep -q ' PASS ' "$TMP/$m.res"; then pass=$((pass+1)); else fail=$((fail+1)); fi
done
echo "----------------------------------------"
echo "PASS=$pass FAIL=$fail  (thinking=$THINKING)"

if [ "$fail" -gt 0 ]; then
  echo
  echo "Failures:"
  for m in "${MODELS[@]}"; do
    grep -q ' PASS ' "$TMP/$m.res" || { echo "[$m]"; [ -f "$TMP/$m.tail" ] && cat "$TMP/$m.tail"; echo; }
  done
  exit 1
fi
