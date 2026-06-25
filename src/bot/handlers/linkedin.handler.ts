import { Context } from 'grammy';
import { prisma } from '../../infrastructure/database';
import { UserRepository } from '../../repositories/UserRepository';
import { CvRepository } from '../../repositories/CvRepository';
import { linkedInApplyService } from '../../services/linkedin.apply.service';
import { openaiService } from '../../services/openai.service';
import { config } from '../../config';
import { logger } from '../../infrastructure/logger';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const userRepo = new UserRepository();
const cvRepo = new CvRepository();
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// Stop flag per user
const stopFlags = new Map<number, boolean>();

// ── /linkedin_apply ──────────────────────────────────────────────────────────
export async function handleLinkedInApplyCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const text = ctx.message?.text ?? '';
  const keywords = text.replace('/linkedin_apply', '').trim();

  if (!keywords) {
    await ctx.reply(
      `💼 *LinkedIn Easy Apply*\n\n` +
      `Бот знайде вакансії на LinkedIn і автоматично подасть відгук через Easy Apply\\.\n\n` +
      `*Формат:*\n` +
      `\`/linkedin\\_apply junior node\\.js\`\n` +
      `\`/linkedin\\_apply qa tester wroclaw\`\n` +
      `\`/linkedin\\_apply junior react remote\`\n\n` +
      `_Потрібно бути залогіненим в браузері\\._`,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  await startLinkedInApply(ctx, from.id, keywords);
}

// ── /linkedin_status — перевірка логіну ─────────────────────────────────────
export async function handleLinkedInStatus(ctx: Context): Promise<void> {
  const msg = await ctx.reply('⏳ Перевіряю статус LinkedIn...');

  try {
    const { loggedIn, name } = await linkedInApplyService.checkLogin();

    await ctx.api.editMessageText(
      ctx.from!.id,
      msg.message_id,
      loggedIn
        ? `✅ *LinkedIn підключено*\n\n👤 ${name ?? 'LinkedIn User'}\n\nЕasy Apply готовий до роботи\\.`
        : `❌ *Не залогінений в LinkedIn*\n\nВідкрий браузер вручну і залогінься на linkedin\\.com\\.\nСесія збережеться автоматично\\.`,
      { parse_mode: 'MarkdownV2' },
    );
  } catch (err) {
    await ctx.api.editMessageText(
      ctx.from!.id,
      msg.message_id,
      `❌ Помилка перевірки\\: ${(err as Error).message.slice(0, 100)}`,
      { parse_mode: 'MarkdownV2' },
    );
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
