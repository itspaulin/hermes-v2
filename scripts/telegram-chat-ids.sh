#!/usr/bin/env bash
# Lista o chat_id de quem escreveu ao bot. Use ANTES de ativar o webhook:
# mande /start ao bot e rode este script.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npm run --silent telegram -- chat-ids
