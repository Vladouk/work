import { Context } from 'grammy';
import { prisma } from '../../infrastructure/database';
import { UserRepository } from '../../repositories/UserRepository';
import { CvRepository } from '../../repositories/CvRepository';
import { linkedInApplyService } from '../../services/linkedin.apply.service';
import { openaiService } from '../../services/openai.service';
import { config } from '../../config';
import { logger } from '../../infrastructure/logger';
import { linkedinMenuKeyboard } from '../keyboards';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const userRepo = new UserRepository();
const cvRepo = new CvRepository();
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// Stop flag per user
const stopFlags = new Map<number, boolean>();
// Waiting for keywords input per user
const awaitingKeywords = new Map<number, boolean>();

// ── LinkedIn Menu (кнопка в головному меню) ──────────────────────────────────
export async function handleLinkedInMenu(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery?.().catch(() => undefined);
  await ctx.reply(
    `💼 *LinkedIn Easy Apply*\n\n` +
    `Бот відкриє браузер, знайде вакансії з *Easy Apply* і автоматично подасть відгуки\\.\n\n` +
    `*Що потрібно:*\n` +
    `• Залогінитись в LinkedIn у браузері \\(один раз\\)\n` +
    `• Заповнений /profile з email та телефоном\n` +
    `• Завантажений /cv\n\n` +
    `Обери дію:`,
    { parse_mode: 'MarkdownV2', reply_markup: linkedinMenuKeyboard },
  );
}

// ── Кнопка "Запустити Easy Apply" → просимо ввести ключові слова ─────────────
export async function handleLinkedInStartPrompt(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery?.().catch(() => undefined);
  const from = ctx.from;
  if (!from) return;

  awaitingKeywords.set(from.id, true);

  await ctx.reply(
    `🔍 *Введи ключові слова для пошуку:*\n\n` +
    `Приклади:\n` +
    `• \`junior node\\.js\`\n` +
    `• \`qa tester remote\`\n` +
    `• \`junior react wroclaw\`\n\n` +
    `_Або натисни /cancel для скасування_`,
    { parse_mode: 'MarkdownV2' },
  );
}

// Перехоплення введення ключових слів (викликати з handleProfileInput у bot.ts)
export async function handleLinkedInKeywordsInput(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  if (!from) return false;
  if (!awaitingKeywords.get(from.id)) return false;

  awaitingKeywords.delete(from.id);

  const text = ctx.message?.text ?? '';
  if (text.startsWith('/')) return false;

  await startLinkedInApply(ctx, from.id, text.trim());
  return true;
}

// ── /linkedin_apply (команда) ────────────────────────────────────────────────
export async function handleLinkedInApplyCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const text = ctx.message?.text ?? '';
  const keywords = text.replace('/linkedin_apply', '').trim();

  if (!keywords) {
    await ctx.reply(
      `💼 *LinkedIn Easy Apply*\n\nВведи ключові слова після команди:\n\`/linkedin\\_apply junior node\\.js\``,
      { parse_mode: 'MarkdownV2', reply_markup: linkedinMenuKeyboard },
    );
    return;
  }

  await startLinkedInApply(ctx, from.id, keywords);
}

// ── /linkedin_status — перевірка логіну ─────────────────────────────────────
export async function handleLinkedInStatus(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  await ctx.answerCallbackQuery?.().catch(() => undefined);
  const msg = await ctx.reply('⏳ Перевіряю статус LinkedIn...');

  try {
    const { loggedIn, name } = await linkedInApplyService.checkLogin();

    if (loggedIn) {
      await ctx.api.editMessageText(
        from.id,
        msg.message_id,
        `✅ *LinkedIn підключено*\n\n👤 ${escMd(name ?? 'LinkedIn User')}\n\nEasy Apply готовий до роботи\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: linkedinMenuKeyboard },
      );
    } else {
      await ctx.api.editMessageText(
        from.id,
        msg.message_id,
        `❌ *Не залогінений в LinkedIn*\n\nЯк залогінитись:\n1\\. Запусти бота локально\n2\\. Відкрий браузер вручну через browser\\-profile\n3\\. Залогінься на linkedin\\.com — сесія збережеться автоматично\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: linkedinMenuKeyboard },
      );
    }
  } catch (err) {
    await ctx.api.editMessageText(
      from.id,
      msg.message_id,
      `❌ Помилка перевірки\\: ${escMd((err as Error).message.slice(0, 100))}`,
      { parse_mode: 'MarkdownV2', reply_markup: linkedinMenuKeyboard },
    ).catch(() => undefined);
  }
}

// ── Основна логіка ───────────────────────────────────────────────────────────
async function startLinkedInApply(
  ctx: Context,
  telegramId: number,
  keywords: string,
): Promise<void> {
  const user = await userRepo.findByTelegramId(BigInt(telegramId));
  if (!user) return;

  const [profile, cv] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId: user.id } }),
    cvRepo.findActiveByUser(user.id),
  ]);

  if (!profile?.email || !profile?.fullName) {
    await ctx.reply(
      '❌ *Профіль не заповнено*\n\nДля LinkedIn Easy Apply потрібні контактні дані\\.\n\n/profile',
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  if (!cv?.extractedText) {
    await ctx.reply('❌ *CV не завантажено*\n\n/cv', { parse_mode: 'MarkdownV2' });
    return;
  }

  // Завантажуємо CV файл
  let cvLocalPath: string | undefined;
  try {
    const file = await ctx.api.getFile(cv.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    cvLocalPath = path.join(UPLOADS_DIR, `cv_${user.id}_linkedin.pdf`);
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(cvLocalPath, resp.data as Buffer);
  } catch (err) {
    logger.warn(`[LinkedIn] CV download: ${(err as Error).message}`);
  }

  // Генеруємо cover letter
  let coverLetter = profile.coverNote ?? '';
  if (!coverLetter) {
    try {
      coverLetter = await openaiService.generateCoverLetter(
        cv.extractedText,
        `${keywords} position`,
        'LinkedIn',
      );
    } catch {
      coverLetter = `Dear Hiring Team, I am applying for the ${keywords} position. Best regards, ${profile.fullName}`;
    }
  }

  const nameParts = (profile.fullName ?? '').split(' ');
  const location = profile.location || 'Poland';
  const applyProfile = {
    firstName: nameParts[0] ?? '',
    lastName: nameParts.slice(1).join(' ') || '-',
    email: profile.email ?? '',
    phone: profile.phone ?? '',
    linkedin: profile.linkedin,
    github: profile.github,
    position: profile.position ?? keywords,
    experienceMonths: profile.experienceMonths ?? 0,
    skills: profile.skills ?? '',
    location,
    coverLetter,
    cvLocalPath,
  };

  stopFlags.set(telegramId, false);

  const statusMsg = await ctx.reply(
    `💼 *LinkedIn Easy Apply*\n\n` +
    `🔍 Ключові слова: *${escMd(keywords)}*\n` +
    `📍 Локація: ${escMd(location)}\n\n` +
    `⏳ Запускаю браузер\\.\\.\\.`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[{ text: '⏹ Зупинити', callback_data: 'linkedin_stop' }]],
      },
    },
  );

  try {
    const results = await linkedInApplyService.searchAndApply(
      keywords,
      location,
      10,
      applyProfile,
      async (msg) => {
        if (stopFlags.get(telegramId)) throw new Error('STOPPED_BY_USER');
        await ctx.api.editMessageText(
          telegramId,
          statusMsg.message_id,
          `💼 *LinkedIn Easy Apply*\n\n${escMd(msg)}`,
          { parse_mode: 'MarkdownV2' },
        ).catch(() => undefined);
      },
    );

    // Зберігаємо результати в БД
    for (const r of results) {
      if (!r.success) continue;
      try {
        const vacancy = await prisma.vacancy.upsert({
          where: { url: r.url.split('?')[0] },
          create: {
            title: r.title,
            company: r.company,
            url: r.url.split('?')[0],
            source: 'LINKEDIN',
            country: 'Poland',
          },
          update: {},
        });
        await prisma.application.upsert({
          where: { userId_vacancyId: { userId: user.id, vacancyId: vacancy.id } },
          create: { userId: user.id, vacancyId: vacancy.id, status: 'APPLIED', appliedAt: new Date() },
          update: { status: 'APPLIED', appliedAt: new Date() },
        });
      } catch { /* ignore */ }
    }

    // Чистимо CV
    if (cvLocalPath && fs.existsSync(cvLocalPath)) fs.unlinkSync(cvLocalPath);

    const successful = results.filter(r => r.success).length;
    const skipped = results.filter(r => r.method === 'skip').length;
    const failed = results.filter(r => !r.success && r.method !== 'skip').length;

    await ctx.api.editMessageText(
      telegramId,
      statusMsg.message_id,
      `💼 *LinkedIn Easy Apply завершено\\!*\n\n` +
      `📊 Результат:\n` +
      `✅ Подано: *${successful}*\n` +
      `⏭ Пропущено \\(нема Easy Apply\\): *${skipped}*\n` +
      `❌ Помилки: *${failed}*`,
      { parse_mode: 'MarkdownV2' },
    ).catch(() => undefined);

    logger.info(`[LinkedIn] Done. ${successful} applied, ${skipped} skipped, ${failed} failed`);

  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'STOPPED_BY_USER') {
      await ctx.api.editMessageText(
        telegramId,
        statusMsg.message_id,
        `⏹ *LinkedIn Easy Apply зупинено*`,
        { parse_mode: 'MarkdownV2' },
      ).catch(() => undefined);
    } else if (msg === 'NOT_LOGGED_IN') {
      await ctx.api.editMessageText(
        telegramId,
        statusMsg.message_id,
        `🔐 *Не залогінений в LinkedIn*\n\nВідкрий браузер і залогінься на linkedin\\.com\\.\nПотім спробуй ще раз\\.`,
        { parse_mode: 'MarkdownV2' },
      ).catch(() => undefined);
    } else {
      await ctx.api.editMessageText(
        telegramId,
        statusMsg.message_id,
        `❌ Помилка: ${escMd(msg.slice(0, 200))}`,
        { parse_mode: 'MarkdownV2' },
      ).catch(() => undefined);
    }
  } finally {
    stopFlags.delete(telegramId);
  }
}

function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

// ── /linkedin_stop callback ──────────────────────────────────────────────────
export async function handleLinkedInStop(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery('⏹ Зупиняю...').catch(() => undefined);
  const from = ctx.from;
  if (!from) return;
  stopFlags.set(from.id, true);
  logger.info(`[LinkedIn] Stop requested by user ${from.id}`);
}

// ── Запуск apply з готовими keywords (через callback linkedin_go_*) ───────────
export async function handleLinkedInApplyWithKeywords(ctx: Context, keywords: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  await startLinkedInApply(ctx, from.id, keywords);
}

// ── Запуск парсера (кнопка "Авто-пошук вакансій") ────────────────────────────
export async function handleLinkedInRunParser(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery('🤖 Запускаю...').catch(() => undefined);
  const from = ctx.from;
  if (!from) return;

  const msg = await ctx.reply(
    '⏳ *Запускаю LinkedIn парсер\\.\\.\\.* Це може зайняти 2\\-5 хвилин\\.',
    { parse_mode: 'MarkdownV2' },
  );

  try {
    const { ParserManager } = await import('../../parsers/parser.manager');
    const manager = new ParserManager();
    const { jobsFound, jobsNew } = await manager.runLinkedIn();

    await ctx.api.editMessageText(
      from.id, msg.message_id,
      `✅ *LinkedIn парсер завершено\\!*\n\n` +
      `📋 Знайдено: *${jobsFound}*\n` +
      `🆕 Нових: *${jobsNew}*\n\n` +
      `Переглянути: /jobs`,
      { parse_mode: 'MarkdownV2', reply_markup: linkedinMenuKeyboard },
    ).catch(() => undefined);
  } catch (err) {
    await ctx.api.editMessageText(
      from.id, msg.message_id,
      `❌ Помилка: ${escMd((err as Error).message.slice(0, 150))}`,
      { parse_mode: 'MarkdownV2', reply_markup: linkedinMenuKeyboard },
    ).catch(() => undefined);
  }
}
