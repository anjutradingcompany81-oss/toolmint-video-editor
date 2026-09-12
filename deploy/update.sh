#!/usr/bin/env bash
#
# Pull the latest code and bring the stack up, then prove it actually
# works before saying so.
#
# Run from the repo root on the VPS:
#     ./deploy/update.sh
#
# The verification at the end is the point. A deploy that starts every
# container but leaves the voice engine with no usable voices is a
# failure, and this exits non-zero for it rather than printing "done" and
# letting a broken editor sit there until a user finds it.

set -euo pipefail

COMPOSE_FILE="deploy/docker-compose.prod.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

# Colours only when attached to a terminal, so piping to a log stays clean.
if [ -t 1 ]; then
  B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi

step() { printf '%s\n' "${B}$1${N}"; }
ok()   { printf '  %s\n' "${G}$1${N}"; }
warn() { printf '  %s\n' "${Y}$1${N}"; }
die()  { printf '  %s\n' "${R}$1${N}" >&2; exit 1; }

[ -f "$COMPOSE_FILE" ] || die "run this from the repo root - $COMPOSE_FILE not found"
[ -f deploy/.env.prod ] || die "deploy/.env.prod is missing (copy deploy/.env.prod.example and fill it in)"

# ---------------------------------------------------------------- pull

step "Pulling"
before="$(git rev-parse --short HEAD)"
git pull --ff-only
after="$(git rev-parse --short HEAD)"
if [ "$before" = "$after" ]; then
  ok "already at $after"
else
  ok "$before -> $after"
  git --no-pager log --oneline "$before..$after" | sed 's/^/    /'
fi

# --------------------------------------------------------------- build

# Built explicitly rather than relying on `up --build`, because the first
# tts-indic build pulls torch plus ~1.5GB of model weights and can take
# 15-20 minutes. Doing it as its own step means a timeout here is
# obviously a build problem, not a mysterious startup hang.
step "Building"
start=$(date +%s)
"${COMPOSE[@]}" build
ok "built in $(( ($(date +%s) - start) / 60 ))m $(( ($(date +%s) - start) % 60 ))s"

# ----------------------------------------------------------------- up

step "Starting"
"${COMPOSE[@]}" up -d --remove-orphans
ok "containers up"

# -------------------------------------------------------------- verify

step "Verifying"

# Give the API a moment; it runs migrations on boot.
api_ok=false
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T api node -e 'fetch("http://localhost:4000/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    api_ok=true; break
  fi
  sleep 2
done
$api_ok && ok "api responding" || die "api did not come up - check: ${COMPOSE[*]} logs api"

# The sidecar answers /health immediately but loads model weights lazily,
# so this checks that it is up and knows about its voices - not that a
# generation has run. An engine with zero voices is a broken deploy even
# though every container is green.
tts_json=""
for _ in $(seq 1 30); do
  tts_json="$("${COMPOSE[@]}" exec -T tts-indic python -c \
    'import json,urllib.request;print(urllib.request.urlopen("http://localhost:8000/health").read().decode())' 2>/dev/null || true)"
  [ -n "$tts_json" ] && break
  sleep 2
done

if [ -z "$tts_json" ]; then
  die "tts-indic did not respond - Hindi voice over will be unavailable. Check: ${COMPOSE[*]} logs tts-indic"
fi

voices="$(printf '%s' "$tts_json" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("voices",0))' 2>/dev/null || echo 0)"
model="$(printf '%s' "$tts_json" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("model",""))' 2>/dev/null || echo "?")"

if [ "$voices" -gt 0 ] 2>/dev/null; then
  ok "tts-indic: $voices voice(s), model $model"
else
  # Not fatal to the stack, but it is fatal to the feature, and since the
  # built-in MMS Hindi voice was removed there is no fallback.
  die "tts-indic is running but has 0 voices - Hindi voice over will not work.
     Each voice needs a .wav AND a matching .txt transcript in
     services/tts-indic/voices/. Check: ${COMPOSE[*]} logs tts-indic"
fi

# Optional settings: absent is a valid choice, so these inform rather
# than fail. Both are read from the env file, not the running container,
# so an unset value shows up here even before a restart picks it up.
step "Optional settings"
grep -qE '^ANTHROPIC_API_KEY=.+' deploy/.env.prod \
  && ok "ANTHROPIC_API_KEY set - script-from-a-prompt enabled" \
  || warn "ANTHROPIC_API_KEY unset - the 'write a script from a prompt' box stays disabled"
grep -qE '^ELEVENLABS_API_KEY=.+' deploy/.env.prod \
  && ok "ELEVENLABS_API_KEY set - cloud voices and cloning enabled" \
  || warn "ELEVENLABS_API_KEY unset - ElevenLabs voices stay unavailable"

printf '\n%s\n' "${G}${B}Deployed. Hindi voices live.${N}"
printf '%s\n' "${D}Open the AI Voice Over panel and generate one line to confirm end to end -${N}"
printf '%s\n' "${D}the first generation loads the model and takes 30-60s.${N}"
