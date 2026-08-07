#!/bin/bash
# Restaure la conversation Codex sur CE PC pour pouvoir la reprendre.
# Usage : ./restore.sh   (depuis le dossier codex-session/)
set -e

NAME="rollout-2026-07-20T09-36-43-019f7e74-ac4e-7b52-b15b-9e0e3647a19e.jsonl"
DEST="$HOME/.codex/sessions/2026/07/20"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "Restauration de la session Codex..."
mkdir -p "$DEST"
gunzip -c "$HERE/$NAME.gz" > "$DEST/$NAME"

echo "OK -> $DEST/$NAME"
echo
echo "Pour reprendre la conversation :"
echo "   cd ~/Documents/fabi-IDE   # (ou l'emplacement de ton repo fabi-IDE)"
echo "   codex resume              # puis choisis la session du 20/07"
echo
echo "Ou directement :"
echo "   codex -c experimental_resume=\"$DEST/$NAME\""
