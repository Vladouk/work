import { Bot, Context, session } from 'grammy';
import { config } from '../config';
import { logger } from '../infrastructure/logger';
import { prisma } from '../infrastructure/database';

// Handlers
import { handleStart } from './handlers/start.handler';
import { handleJobs, handleSearch, handleJobsPage } from './handlers/jobs.handler';
import { handleSettings, handleSettingsCallback, handleSettingsInput } from './handlers/settings.handler';
import { handleCv, handleCvUpload, handleCvMatchJobs, handleCoverLetterCallback, handleOutreachCallback } from './handlers/cv.handler';
import { handleStats } from './handlers/stats.handler';
import { handleProfile, startProfileWizard, handleProfileInput, clearProfile } from './handlers/profile.handler';
import { handleAutoApplyPrompt, handleAutoApplyConfirm } from './handlers/autoapply.handler';
import { handleBulkApplyCommand, handleUrlsInMessage, handleBulkUrlCallback, handleBulkStartCallback, handleBulkStop } from './handlers/bulkapply.handler';
import { handleAdmin, handleAdminUsers, handleAdminJobs, handleAdminParsers, handleAdminRunParsers, handleAdminLogs } from './handlers/admin.handler';

import { UserRepository } from '../repositories/UserRepository';

interface SessionData { step?: string }
// BotContext kept for future typed middleware use
// type BotContext = Context & SessionFlavor<SessionData>;

const userRepo = new UserRepository();

export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  bot.use(session({ initial: (): SessionData => ({}) }) as Parameters<typeof bot.use>[0]);

  // Logging middleware
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from) {
      logger.debug(`[Bot] ${from.id} @${from.username ?? '-'}: ${ctx.message?.text ?? '[callback]'}`);
    }
    await next();
  });

  // ── Commands ───────────────────────────────────────────────────────────────
  bot.command('start', handleStart);
  bot.command('jobs', handleJobs);
  bot.command('search', handleSearch);
  bot.command('settings', handleSettings);
  bot.command('cv', handleCv);
  bot.command('stats', handleStats);
  bot.command('profile', handleProfile);
  bot.command('apply_bulk', handleBulkApplyCommand);
  bot.command('stop_apply', async (ctx) => { await handleBulkStop(ctx); });
  // Admin
  bot.command('admin', handleAdmin);
  bot.command('admin_users', handleAdminUsers);
  bot.command('admin_jobs', handleAdminJobs);
  bot.command('admin_parsers', handleAdminParsers);
  bot.command('admin_run', handleAdminRunParsers);
  bot.command('admin_logs', handleAdminLogs);

  // ── Menu callbacks ─────────────────────────────────────────────────────────
  bot.callbackQuery('menu_main', async (ctx) => { await ctx.answerCallbackQuery(); await handleStart(ctx); });
  bot.callbackQuery('menu_jobs', async (ctx) => { await ctx.answerCallbackQuery(); await handleJobs(ctx); });
  bot.callbackQuery('menu_search', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('🔍 Використовуй /search <запит>\n\nПриклад: `/search node.js remote`', { parse_mode: 'Markdown' });
  });
  bot.callbackQuery('menu_settings', async (ctx) => { await ctx.answerCallbackQuery(); await handleSettings(ctx); });
  bot.callbackQuery('menu_cv', async (ctx) => { await ctx.answerCallbackQuery(); await handleCv(ctx); });
  bot.callbackQuery('menu_stats', async (ctx) => { await ctx.answerCallbackQuery(); await handleStats(ctx); });
  bot.callbackQuery('menu_profile', async (ctx) => { await ctx.answerCallbackQuery(); await handleProfile(ctx); });

  // ── Settings callbacks ─────────────────────────────────────────────────────
  bot.callbackQuery(/^settings_(.+)$/, async (ctx) => {
    await handleSettingsCallback(ctx, ctx.match[1]);
  });

  // ── CV callbacks ───────────────────────────────────────────────────────────
  bot.callbackQuery('cv_upload', async (ctx) => { await ctx.answerCallbackQuery(); await handleCvUpload(ctx); });
  bot.callbackQuery('cv_match_jobs', async (ctx) => { await handleCvMatchJobs(ctx); });
  bot.callbackQuery('cv_info', async (ctx) => { await ctx.answerCallbackQuery(); await handleCv(ctx); });

  // ── Profile callbacks ──────────────────────────────────────────────────────
  bot.callbackQuery('profile_fill', async (ctx) => { await startProfileWizard(ctx); });
  bot.callbackQuery('profile_view', async (ctx) => { await ctx.answerCallbackQuery(); await handleProfile(ctx); });
  bot.callbackQuery('profile_clear', async (ctx) => { await clearProfile(ctx); });

  // ── Job action callbacks ───────────────────────────────────────────────────
  bot.callbackQuery(/^save_job_(\d+)$/, async (ctx) => {
    const vacancyId = parseInt(ctx.match[1], 10);
    const from = ctx.from;
    if (!from) return;
    await ctx.answerCallbackQuery('Збережено! 💾');
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    if (!user) return;
    await prisma.application.upsert({
      where: { userId_vacancyId: { userId: user.id, vacancyId } },
      create: { userId: user.id, vacancyId, status: 'SAVED' },
      update: { status: 'SAVED' },
    });
  });

  bot.callbackQuery(/^applied_job_(\d+)$/, async (ctx) => {
    const vacancyId = parseInt(ctx.match[1], 10);
    const from = ctx.from;
    if (!from) return;
    await ctx.answerCallbackQuery('Позначено як відправлено ✅');
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    if (!user) return;
    await prisma.application.upsert({
      where: { userId_vacancyId: { userId: user.id, vacancyId } },
      create: { userId: user.id, vacancyId, status: 'APPLIED', appliedAt: new Date() },
      update: { status: 'APPLIED', appliedAt: new Date() },
    });
  });

  bot.callbackQuery(/^hide_job_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery('Приховано');
    await ctx.deleteMessage().catch(() => undefined);
  });

  bot.callbackQuery(/^reject_job_(\d+)$/, async (ctx) => {
    const vacancyId = parseInt(ctx.match[1], 10);
    const from = ctx.from;
    if (!from) return;
    await ctx.answerCallbackQuery('Позначено як не підходить 👎');
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    if (user) {
      await prisma.application.upsert({
        where: { userId_vacancyId: { userId: user.id, vacancyId } },
        create: { userId: user.id, vacancyId, status: 'REJECTED', notes: 'user:rejected' },
        update: { status: 'REJECTED', notes: 'user:rejected' },
      });
    }
    await ctx.deleteMessage().catch(() => undefined);
  });

  bot.callbackQuery(/^cover_letter_(\d+)$/, async (ctx) => {
    await handleCoverLetterCallback(ctx, parseInt(ctx.match[1], 10));
  });

  bot.callbackQuery(/^outreach_(\d+)$/, async (ctx) => {
    await handleOutreachCallback(ctx, parseInt(ctx.match[1], 10));
  });

  // ── Bulk apply callbacks ───────────────────────────────────────────────────
  bot.callbackQuery(/^bulk_url_(.+)$/, async (ctx) => {
    await handleBulkUrlCallback(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^bulk_start_(.+)$/, async (ctx) => {
    await handleBulkStartCallback(ctx, ctx.match[1]);
  });

  bot.callbackQuery('bulk_stop', async (ctx) => {
    await handleBulkStop(ctx);
  });

  // ── Auto-apply callbacks ───────────────────────────────────────────────────
  bot.callbackQuery(/^auto_apply_(\d+)$/, async (ctx) => {
    logger.info(`[Bot] auto_apply callback: ${ctx.match[1]}`);
    await handleAutoApplyPrompt(ctx, parseInt(ctx.match[1], 10));
  });

  bot.callbackQuery(/^confirm_apply_(\d+)$/, async (ctx) => {
    logger.info(`[Bot] confirm_apply callback: ${ctx.match[1]}`);
    await handleAutoApplyConfirm(ctx, parseInt(ctx.match[1], 10));
  });

  // ── Pagination ─────────────────────────────────────────────────────────────
  bot.callbackQuery(/^jobs_page_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleJobsPage(ctx, parseInt(ctx.match[1], 10));
  });

  bot.callbackQuery('noop', async (ctx) => { await ctx.answerCallbackQuery(); });

  // ── Document upload (CV) ───────────────────────────────────────────────────
  bot.on('message:document', async (ctx) => {
    await handleCvUpload(ctx);
  });

  // ── Free text ──────────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    // Profile wizard
    const profileHandled = await handleProfileInput(ctx);
    if (profileHandled) return;

    // Settings input
    const settingsHandled = await handleSettingsInput(ctx);
    if (settingsHandled) return;

    // URLs in message → bulk apply prompt
    const urlsHandled = await handleUrlsInMessage(ctx);
    if (urlsHandled) return;

    // Treat other text as search
    const text = ctx.message.text;
    if (!text.startsWith('/') && text.length > 2) {
      await handleSearch(ctx);
    }
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  bot.catch((err) => {
    // Ignore stale callback query errors (old buttons after bot restart)
    if (err.message.includes('query is too old') || err.message.includes('query ID is invalid')) {
      logger.debug(`[Bot] Стара callback-кнопка — ігноруємо`);
      return;
    }
    logger.error(`[Bot] Необроблена помилка: ${err.message}`, { stack: err.stack });
  });

  return bot;
}
