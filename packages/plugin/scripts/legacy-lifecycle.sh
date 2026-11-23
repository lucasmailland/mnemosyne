#!/bin/bash
# Reconcile before compact; only SessionEnd requests collapse after queue ACK.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/_helpers.sh"
INPUT=$(cat)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
init_workspace "${CWD:-$PWD}"
legacy_capture_hook "${1:-}" "$INPUT"
printf '{}\n'
