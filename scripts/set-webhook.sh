#!/usr/bin/env bash
# Registra o webhook do Telegram. Uso: ./scripts/set-webhook.sh "https://<api-id>.execute-api.<região>.amazonaws.com/telegram/webhook"
# Sem argumento de URL: --info mostra o estado, --delete remove (rollback).
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  --info) exec npm run --silent telegram -- info ;;
  --delete) exec npm run --silent telegram -- delete-webhook ;;
  "") echo 'Uso: ./scripts/set-webhook.sh <URL> | --info | --delete' >&2; exit 2 ;;
  *) exec npm run --silent telegram -- set-webhook "$1" ;;
esac
