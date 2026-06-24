# 🤖 Telegram Junior IT Job Hunter Bot — Poland

A production-ready Telegram bot that hunts Junior IT positions in Poland, matches them against your CV using AI, and sends instant notifications.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Job Sources** | LinkedIn, NoFluffJobs, JustJoinIT, Pracuj.pl, BulldogJob |
| **Auto-scraping** | Runs every 30 minutes via cron |
| **Smart Filtering** | Junior / Intern / Trainee · Backend / Fullstack / Node.js / JS / TS / React / QA / IT Support |
| **CV Matching** | Upload PDF → OpenAI compares against every vacancy → 0–100% score |
| **AI Features** | Cover letter · CV summary rewrite · Recruiter outreach · Missing skills |
| **Notifications** | Instant Telegram messages when a matching vacancy appears |
| **Dashboard** | Jobs today / matching / saved / applied |
| **Admin Panel** | User management · Job viewer · Parser status · Log viewer |

---

## 🛠 Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **Bot Framework:** grammY
- **Database:** PostgreSQL 16 + Prisma ORM
- **AI:** OpenAI GPT-4 Turbo
- **PDF Parsing:** pdf-parse
- **Scraping:** Axios + Cheerio
- **Scheduler:** node-cron
- **Container:** Docker + Docker Compose
- **Architecture:** Clean Architecture + Repository Pattern

---

## 🚀 Quick Start

### 1. Clone & configure

```bash
git clone <your-repo>
cd telegram-job-hunter-bot
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=your_token_from_@BotFather
TELEGRAM_ADMIN_IDS=your_telegram_id
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/jobhunter
```

### 2. Get your Telegram Bot Token

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`
3. Follow instructions to get your token
4. Set bot commands:

```
start - Start the bot
jobs - Browse matching jobs
search - Search by keyword
settings - Configure your preferences
cv - Manage your CV
stats - View dashboard
```

### 3. Get your Telegram ID

Open [@userinfobot](https://t.me/userinfobot) and send `/start`. Your ID appears in the response.

---

## 🐳 Docker Deployment (Recommended)

```bash
# Build and start everything
docker-compose up -d

# View logs
docker-compose logs -f bot

# Stop
docker-compose down
```

The stack starts:
1. **PostgreSQL** — persists data in a named volume
2. **migrate** — runs Prisma migrations automatically
3. **bot** — the Telegram bot + cron scheduler

---

## 💻 Local Development

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run prisma:generate

# Start local PostgreSQL (or use Docker)
docker-compose up -d postgres

# Run migrations
npm run prisma:migrate:dev

# Start dev server with hot reload
npm run dev
```

---

## 📁 Project Structure

```
src/
├── config/           # Environment & app config
├── domain/
│   ├── types.ts      # Shared domain types
│   └── interfaces/   # Repository interfaces (Clean Architecture)
├── infrastructure/
│   ├── database.ts   # Prisma client singleton
│   └── logger.ts     # Winston logger
├── repositories/     # Prisma-backed implementations
│   ├── UserRepository.ts
│   ├── VacancyRepository.ts
│   └── CvRepository.ts
├── parsers/          # Job scrapers
│   ├── base.parser.ts
│   ├── nofluffjobs.parser.ts
│   ├── justjoinit.parser.ts
│   ├── pracujpl.parser.ts
│   ├── bulldogjob.parser.ts
│   ├── linkedin.parser.ts
│   └── parser.manager.ts
├── services/
│   ├── openai.service.ts     # OpenAI integration
│   ├── cv.service.ts         # PDF processing + CV matching
│   └── notification.service.ts
├── bot/
│   ├── bot.ts                # Bot setup + middleware + routing
│   ├── keyboards.ts          # Inline keyboard helpers
│   └── handlers/
│       ├── start.handler.ts
│       ├── jobs.handler.ts
│       ├── settings.handler.ts
│       ├── cv.handler.ts
│       ├── stats.handler.ts
│       └── admin.handler.ts
├── jobs/
│   └── scheduler.ts          # Cron job manager
└── index.ts                  # Entry point
prisma/
├── schema.prisma             # Database models
└── migrations/               # SQL migrations
```

---

## 🗄 Database Schema

| Table | Purpose |
|---|---|
| `users` | Telegram users |
| `user_settings` | Per-user filter preferences |
| `cv_files` | Uploaded CVs + extracted text |
| `vacancies` | Scraped job listings |
| `cv_matches` | AI match scores (cached) |
| `applications` | Saved / applied tracking |
| `notifications` | Sent notification log |
| `parser_logs` | Scraper run history |
| `app_logs` | Error / warning log |

---

## 🤖 Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome + main menu |
| `/jobs` | Browse jobs matching your settings |
| `/search <query>` | Search by keyword |
| `/settings` | Configure filters |
| `/cv` | Upload / manage CV |
| `/stats` | Dashboard |

**Admin only:**

| Command | Description |
|---|---|
| `/admin` | Admin overview |
| `/admin_users` | List all users |
| `/admin_jobs` | Recent scraped jobs |
| `/admin_parsers` | Parser status |
| `/admin_run` | Trigger parser run now |
| `/admin_logs` | View error logs |

---

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | From @BotFather |
| `TELEGRAM_ADMIN_IDS` | ✅ | — | Comma-separated Telegram IDs |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `OPENAI_API_KEY` | ✅ | — | OpenAI API key |
| `OPENAI_MODEL` | — | `gpt-4-turbo-preview` | OpenAI model |
| `NODE_ENV` | — | `development` | `development` or `production` |
| `LOG_LEVEL` | — | `info` | `debug`, `info`, `warn`, `error` |
| `CRON_SCHEDULE` | — | `*/30 * * * *` | Cron expression for parser |
| `PARSER_TIMEOUT` | — | `30000` | HTTP timeout in ms |
| `PARSER_MAX_RETRIES` | — | `3` | Retry count per parser |

---

## 🔧 Production Tips

1. **Reverse proxy**: Put Nginx in front if you add a webhook endpoint
2. **Log rotation**: Logs rotate automatically (5MB/file, 5 files max)
3. **Parser notes**: LinkedIn and Pracuj.pl may require periodic selector updates as they change their HTML structure
4. **Rate limits**: OpenAI calls are cached per vacancy+CV pair to avoid redundant API calls
5. **Scaling**: For high user counts, consider running the notification service separately from the parser
6. **Backups**: Mount `postgres_data` volume to an external drive or use `pg_dump` in a cron job

---

## 📝 License

MIT
