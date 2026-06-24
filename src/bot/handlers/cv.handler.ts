import { Context } from 'grammy';
import { cvService } from '../../services/cv.service';
import { openaiService } from '../../services/openai.service';
import { VacancyRepository } from '../../repositories/VacancyRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { cvMenuKeyboard } from '../keyboards';
import { logger } from '../../infrastructure/logger';
import { config } from '../../config';

const vacancyRepo = new VacancyRepository();
const userRepo = new UserRepository();

export async function handleCv(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  const cv = await cvService.getActiveCv(user?.id ?? 0);

  const statusText = cv
    ? `📄 *Поточне CV:* ${cv.fileName}\n📅 Завантажено: ${cv.createdAt.toLocaleDateString('uk-UA')}\n📝 Текст розпізнано: ${cv.extractedText ? 'Так ✅' : 'Ні ❌'}`
    : '❌ CV ще не завантажено';

  await ctx.reply(
    `📄 *Управління CV*\n\n${statusText}\n\n` +
      'Щоб завантажити нове CV — надішли PDF-файл або натисни кнопку нижче:',
    {
      parse_mode: 'Markdown',
      reply_markup: cvMenuKeyboard,
    },
  );
}

export async function handleCvUpload(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const document = ctx.message?.document;
  if (!document) {
    await ctx.reply(
      '📤 *Завантаження CV*\n\nНадішли своє CV як PDF-файл.\n\n_Просто прикріпи файл у чаті._',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (!document.mime_type?.includes('pdf')) {
    await ctx.reply('❌ Будь ласка, завантажуй тільки PDF файли.');
    return;
  }

  const processingMsg = await ctx.reply('⏳ Обробляю твоє CV...');

  try {
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    if (!user) throw new Error('Користувача не знайдено');

    const file = await ctx.api.getFile(document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;

    const { extractedText } = await cvService.processCvUpload(
      user.id,
      document.file_id,
      document.file_name ?? 'cv.pdf',
      fileUrl,
    );

    await ctx.api.editMessageText(
      from.id,
      processingMsg.message_id,
      extractedText
        ? `✅ *CV успішно завантажено!*\n\n📝 Розпізнано ${extractedText.length} символів тексту.\n\n` +
            `Тепер CV буде використовуватись для порівняння з вакансіями.`
        : `✅ *CV завантажено!*\n\n⚠️ Не вдалось розпізнати текст з цього PDF.\nСпробуй завантажити текстовий PDF для кращого результату.`,
      { parse_mode: 'Markdown' },
    );

    logger.info(`[CV] Користувач ${user.id} завантажив CV: ${document.file_name}`);
  } catch (err) {
    logger.error(`[CV] Помилка завантаження: ${(err as Error).message}`);
    await ctx.api
      .editMessageText(from.id, processingMsg.message_id, '❌ Не вдалось обробити CV. Спробуй ще раз.')
      .catch(() => undefined);
  }
}

export async function handleCvMatchJobs(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  await ctx.answerCallbackQuery?.('Порівнюю CV...');

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return;

  const cv = await cvService.getActiveCv(user.id);
  if (!cv?.extractedText) {
    await ctx.reply('❌ Спочатку завантаж CV через /cv');
    return;
  }

  const msg = await ctx.reply('🤖 Порівнюю твоє CV з останніми вакансіями...');

  try {
    const recentVacancies = await vacancyRepo.findMany({
      keywords: user.settings?.keywords ?? ['junior'],
      limit: 20,
    });

    const results: Array<{ title: string; company: string; score: number; url: string }> = [];

    for (const vacancy of recentVacancies) {
      const result = await cvService.matchCvToVacancy(user.id, vacancy);
      if (result && result.matchScore >= (user.settings?.minMatchScore ?? 60)) {
        results.push({ title: vacancy.title, company: vacancy.company, score: result.matchScore, url: vacancy.url });
      }
    }

    results.sort((a, b) => b.score - a.score);

    const lines = [
      `🎯 *Результати порівняння CV*`,
      ``,
      `Перевірено ${recentVacancies.length} вакансій, підходить: ${results.length}`,
      ``,
      ...results.slice(0, 10).map(
        (r, i) => `${i + 1}. *${r.title}* @ ${r.company}\n   Збіг: ${r.score}% | [Переглянути](${r.url})`,
      ),
    ];

    await ctx.api.editMessageText(from.id, msg.message_id, lines.join('\n'), {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    logger.error(`[CV] Помилка порівняння: ${(err as Error).message}`);
    await ctx.api.editMessageText(from.id, msg.message_id, '❌ Помилка порівняння. Спробуй ще раз.').catch(() => undefined);
  }
}

export async function handleCoverLetterCallback(ctx: Context, vacancyId: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  await ctx.answerCallbackQuery('Генерую супровідний лист...');

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return;

  const cv = await cvService.getActiveCv(user.id);
  if (!cv?.extractedText) {
    await ctx.reply('❌ Спочатку завантаж CV через /cv');
    return;
  }

  const vacancy = await vacancyRepo.findById(vacancyId);
  if (!vacancy) { await ctx.reply('❌ Вакансію не знайдено.'); return; }

  const msg = await ctx.reply('✍️ Генерую персоналізований супровідний лист...');

  try {
    const coverLetter = await openaiService.generateCoverLetter(cv.extractedText, vacancy.title, vacancy.company);
    await ctx.api.editMessageText(
      from.id, msg.message_id,
      `📝 *Супровідний лист — ${vacancy.title}*\n\n${coverLetter}`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error(`[CV] Помилка генерації листа: ${(err as Error).message}`);
    await ctx.api.editMessageText(from.id, msg.message_id, '❌ Помилка генерації.').catch(() => undefined);
  }
}

export async function handleOutreachCallback(ctx: Context, vacancyId: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  await ctx.answerCallbackQuery('Генерую повідомлення...');

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return;

  const vacancy = await vacancyRepo.findById(vacancyId);
  if (!vacancy) { await ctx.reply('❌ Вакансію не знайдено.'); return; }

  const msg = await ctx.reply('📨 Генерую повідомлення для рекрутера...');

  try {
    const name = user.firstName ?? user.username ?? 'Кандидат';
    const outreach = await openaiService.generateOutreachMessage(name, vacancy.title, vacancy.company);
    await ctx.api.editMessageText(
      from.id, msg.message_id,
      `📨 *Повідомлення для ${vacancy.company}*\n\n${outreach}`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error(`[CV] Помилка outreach: ${(err as Error).message}`);
    await ctx.api.editMessageText(from.id, msg.message_id, '❌ Помилка генерації.').catch(() => undefined);
  }
}
