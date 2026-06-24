import { Context, InputFile } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { prisma } from '../../infrastructure/database';
import { UserRepository } from '../../repositories/UserRepository';
import { VacancyRepository } from '../../repositories/VacancyRepository';
import { CvRepository } from '../../repositories/CvRepository';
import { autoApplyService } from '../../services/autoapply.service';
import { autoApplyConfirmKeyboard } from '../keyboards';
import { config } from '../../config';
import { logger } from '../../infrastructure/logger';

const userRepo = new UserRepository();
const vacancyRepo = new VacancyRepository();
const cvRepo = new CvRepository();

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

export async function handleAutoApplyPrompt(ctx: Context, vacancyId: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  await ctx.answerCallbackQuery();

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return;

  const profile = await prisma.userProfile.findUnique({ where: { userId: user.id } });
  if (!profile) {
    await ctx.reply(
      '❌ *Профіль не заповнено*\n\nДля авто-відгуку потрібні контактні дані.\n\nЗаповни: /profile',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const cv = await cvRepo.findActiveByUser(user.id);
  if (!cv?.extractedText) {
    await ctx.reply(
      '❌ *CV не завантажено*\n\nЗавантаж PDF: /cv',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const vacancy = await vacancyRepo.findById(vacancyId);
  if (!vacancy) { await ctx.reply('❌ Вакансію не знайдено.'); return; }

  // Detect platform for info message
  const platform = detectPlatform(vacancy.url);

  await ctx.reply(
    `📨 *Авто-відгук*\n\n` +
      `Вакансія: *${vacancy.title}*\n` +
      `Компанія: ${vacancy.company}\n` +
      `Платформа: ${platform}\n\n` +
      `Бот автоматично:\n` +
      `• Відкриє сторінку вакансії у браузері\n` +
      `• Знайде форму відгуку\n` +
      `• Заповнить усі поля твоїми даними\n` +
      `• Завантажить CV\n` +
      `• Вставить AI супровідний лист\n\n` +
      `_Після заповнення покажу скріншот для підтвердження_\n\n` +
      `Підтверджуєш?`,
    { parse_mode: 'Markdown', reply_markup: autoApplyConfirmKeyboard(vacancyId) },
  );
}

export async function handleAutoApplyConfirm(ctx: Context, vacancyId: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  await ctx.answerCallbackQuery('⏳ Запускаю браузер...');

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return;

  const [profile, cv, vacancy] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId: user.id } }),
    cvRepo.findActiveByUser(user.id),
    vacancyRepo.findById(vacancyId),
  ]);

  if (!profile || !cv?.extractedText || !vacancy) {
    await ctx.reply('❌ Не вистачає даних. Перевір /cv та /profile');
    return;
  }

  const msg = await ctx.reply('🌐 Відкриваю браузер і заповнюю форму...\n\n_Це може зайняти 15-30 секунд_', {
    parse_mode: 'Markdown',
  });

  try {
    // Download CV to local temp file for upload
    let cvLocalPath: string | undefined;
    try {
      const file = await ctx.api.getFile(cv.fileId);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      cvLocalPath = path.join(UPLOADS_DIR, `cv_${user.id}_temp.pdf`);
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      fs.writeFileSync(cvLocalPath, resp.data as Buffer);
    } catch (err) {
      logger.warn(`[AutoApply] Не вдалось завантажити CV: ${(err as Error).message}`);
    }

    const result = await autoApplyService.applyToVacancy(
      user.id,
      vacancy,
      cv.extractedText,
      cv.fileId,
      {
        fullName: profile.fullName ?? '',
        email: profile.email ?? '',
        phone: profile.phone ?? '',
        linkedin: profile.linkedin,
        github: profile.github,
        position: profile.position ?? '',
        experienceMonths: profile.experienceMonths ?? 0,
        skills: profile.skills ?? '',
        languages: profile.languages ?? '',
        location: profile.location ?? '',
        salaryExpectation: profile.salaryExpectation,
        coverNote: profile.coverNote,
      },
      cvLocalPath,
    );

    // Clean up temp CV
    if (cvLocalPath && fs.existsSync(cvLocalPath)) {
      fs.unlinkSync(cvLocalPath);
    }

    await autoApplyService.recordAutoApply(user.id, vacancyId, result.success);

    // Edit status message
    const icon = result.success ? '✅' : '📋';
    await ctx.api.editMessageText(
      from.id,
      msg.message_id,
      `${icon} *${result.method}*\n\n${result.message}`,
      { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
    ).catch(() => undefined);

    // Send cover letter ONLY if apply was successful (needed for submission)
    // Don't spam it when browser just opened
    if (result.success && result.coverLetter && result.coverLetter.length > 50) {
      await ctx.reply(
        `📝 *Супровідний лист:*\n\n${result.coverLetter}`,
        { parse_mode: 'Markdown' },
      );
    }

    // Send screenshot only on success or if form was filled
    if (result.screenshotBase64 && result.success) {
      try {
        const screenshotBuffer = Buffer.from(result.screenshotBase64, 'base64');
        await ctx.replyWithPhoto(new InputFile(screenshotBuffer, 'screenshot.png'), {
          caption: '✅ Форму заповнено — перевір і натисни Submit!',
        });
      } catch (err) {
        logger.warn(`[AutoApply] Скріншот: ${(err as Error).message}`);
      }
    }

    logger.info(`[AutoApply] User ${user.id} → ${vacancy.title}: ${result.method} success=${result.success}`);
  } catch (err) {
    logger.error(`[AutoApply] Помилка: ${(err as Error).message}`);
    await ctx.api.editMessageText(from.id, msg.message_id, '❌ Помилка авто-відгуку. Спробуй ще раз.')
      .catch(() => undefined);
  }
}

function detectPlatform(url: string): string {
  if (url.includes('linkedin.com')) return 'LinkedIn Easy Apply';
  if (url.includes('greenhouse.io')) return 'Greenhouse ATS';
  if (url.includes('lever.co')) return 'Lever ATS';
  if (url.includes('workable.com')) return 'Workable ATS';
  if (url.includes('recruitee.com')) return 'Recruitee ATS';
  if (url.includes('traffit.com')) return 'Traffit ATS';
  if (url.includes('smartrecruiters.com')) return 'SmartRecruiters';
  if (url.includes('teamtailor.com')) return 'TeamTailor';
  if (url.includes('justjoin.it')) return 'JustJoinIT';
  if (url.includes('nofluffjobs.com')) return 'NoFluffJobs';
  if (url.includes('bulldogjob.pl')) return 'BulldogJob';
  return '🌐 Браузерне заповнення форми';
}
