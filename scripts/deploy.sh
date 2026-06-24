#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Deploying Telegram Job Hunter Bot..."

# Check required env vars
: "${TELEGRAM_BOT_TOKEN:?Need to set TELEGRAM_BOT_TOKEN}"
: "${OPENAI_API_KEY:?Need to set OPENAI_API_KEY}"

# Pull latest changes (if in git repo)
if git rev-parse --git-dir > /dev/null 2>&1; then
  echo "📦 Pulling latest changes..."
  git pull origin main
fi

# Build and start containers
echo "🔨 Building containers..."
docker-compose build --no-cache

echo "⬆️  Starting services..."
docker-compose up -d postgres

echo "⏳ Waiting for PostgreSQL..."
sleep 5

echo "📊 Running database migrations..."
docker-compose run --rm migrate

echo "🤖 Starting bot..."
docker-compose up -d bot

echo "✅ Deployment complete!"
echo ""
echo "📋 Container status:"
docker-compose ps

echo ""
echo "📝 Bot logs (last 20 lines):"
docker-compose logs --tail=20 bot
