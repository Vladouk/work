import { Context, InputFile } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { prisma } from '../../infrastructure/database';
import { UserRepository } from '../../repositories/UserRepository';
import { CvRepository } from '../../repositories/CvRepository';
import { autoApplyService } from '../../services/autoapply.service';
import { config } from '../../config';
import { logger } from '../../infrastructure/logger';

const userRepo = new UserRepository();
const cvRepo = new CvRepository();
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// Зберігаємо черги для кожного юзера
const applyQueues = new Map<number, string[]>();
const runningApply = new Set<number>();
// Тимчасове сховище URL-списків для кнопок (уникаємо обмеження 64 байти callback_data)
const pendingBulkUrls = new Map<string, string[]>();

function storePendingUrls(urls: string[]): string {
  const id = Date.now().toString(36);
  pendingBulkUrls.set(id, urls);
  // Чистимо старі записи через 10 хвилин
  setTimeout(() => pendingBulkUrls.delete(id), 10 * 60 * 1000);
  return id;
}

// ── Парсимо URL з тексту ────────────────────────────────────────────────────
function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s,\n"'<>]+/g;
  const matches = text.match(urlRegex) ?? [];

  return matches
    .map(u => u.replace(/[.,;)]+$/, '')) // прибираємо trailing пунктуацію
    .filter(url => {
      try {
        new URL(url); // валідний URL
        // Виключаємо явно нерелевантні
        const lower = url.toLowerCase();
        if (lower.includes('telegram.org')) return false;
        if (lower.includes('github.com') && !lower.includes('job')) return false;
        if (lower.includes('google.com/maps')) return false;
        return true; // приймаємо всі інші — роботодавець може бути будь-який
      } catch {
        return false;
      }
    })
    .slice(0, 30); // максимум 30 за раз
}

// ── /apply_bulk команда ─────────────────────────────────────────────────────
export async function handleBulkApplyCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const text = ctx.message?.text ?? '';
  const urls = extractUrls(text);

  if (urls.length === 0) {
    await ctx.reply(
      `📨 *Масовий авто-відгук*\n\n` +
      `Скинь мені список посилань на вакансії — по одному або декілька, я подам відгук на кожну.\n\n` +
      `*Підтримую:*\n` +
      `• pracuj.pl\n• justjoin.it\n• nofluffjobs.com\n• bulldogjob.pl\n• будь-який сайт роботодавця\n\n` +
      `*Формат:* просто скинь посилання в чат (до 30 за раз)\n\n` +
      `Приклад:\n` +
      `\`https://pracuj.pl/praca/...\`\n` +
      `\`https://justjoin.it/job-offer/...\``,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  await startBulkApply(ctx, from.id, urls);
}

// ── Обробка посилань з тексту ───────────────────────────────────────────────
export async function handleUrlsInMessage(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  if (!from) return false;

  const text = ctx.message?.text ?? '';
  const urls = extractUrls(text);

  if (urls.length === 0) return false;

  // Якщо одне посилання — питаємо чи потрібен авто-відгук
  if (urls.length === 1) {
    const id = storePendingUrls(urls);
    await ctx.reply(
      `🔗 Знайшов посилання на вакансію:\n${urls[0]}\n\nПодати авто-відгук?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📨 Так, подати відгук', callback_data: `bulk_go_${id}` },
            { text: '❌ Ні', callback_data: 'noop' },
          ]],
        },
      },
    );
    return true;
  }

  // Якщо декілька — список і кнопка bulk apply
  const id = storePendingUrls(urls);
  await ctx.reply(
    `🔗 *Знайшов ${urls.length} посилань на вакансії:*\n\n` +
    urls.map((u, i) => {
      try { return `${i + 1}. ${new URL(u).hostname} — \`${u.slice(0, 50)}...\``; }
      catch { return `${i + 1}. ${u.slice(0, 60)}`; }
    }).join('\n') +
    `\n\nПодати авто-відгук на всі?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: `📨 Подати на всі (${urls.length})`, callback_data: `bulk_go_${id}` },
          { text: '❌ Скасувати', callback_data: 'noop' },
        ]],
      },
    },
  );
  return true;
}

// ── Callback: bulk_go_ (один або список URL через ID) ──────────────────────
export async function handleBulkGoCallback(ctx: Context, id: string): Promise<void> {
  await ctx.answerCallbackQuery('⏳ Запускаю...');
  const from = ctx.from;
  if (!from) return;

  const urls = pendingBulkUrls.get(id);
  if (!urls || urls.length === 0) {
    await ctx.reply('❌ Список вакансій застарів. Скинь посилання ще раз.');
    return;
  }
  pendingBulkUrls.delete(id);
  await startBulkApply(ctx, from.id, urls);
}

// ── Callback: bulk_url_ (одне посилання з тексту) ──────────────────────────
export async function handleBulkUrlCallback(ctx: Context, encodedUrl: string): Promise<void> {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;

  try {
    const url = decodeURIComponent(encodedUrl);
    await startBulkApply(ctx, from.id, [url]);
  } catch {
    await ctx.reply('❌ Помилка обробки URL');
  }
}

// ── Callback: bulk_start_ (список посилань) ─────────────────────────────────
export async function handleBulkStartCallback(ctx: Context, encodedUrls: string): Promise<void> {
  await ctx.answerCallbackQuery('⏳ Запускаю...');
  const from = ctx.from;
  if (!from) return;

  try {
    const urls: string[] = JSON.parse(Buffer.from(encodedUrls, 'base64').toString());
    await startBulkApply(ctx, from.id, urls);
  } catch {
    await ctx.reply('❌ Помилка запуску. Спробуй /apply_bulk і скинь посилання ще раз.');
  }
}

// ── Зупинити поточну чергу ───────────────────────────────────────────────────
export async function handleBulkStop(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  await ctx.answerCallbackQuery('⏹ Зупиняю...');
  applyQueues.delete(from.id);
  runningApply.delete(from.id);
  await ctx.reply('⏹ *Масовий відгук зупинено.*', { parse_mode: 'Markdown' });
}

// ── Основна логіка масового відгуку ─────────────────────────────────────────
async function startBulkApply(ctx: Context, telegramId: number, urls: string[]): Promise<void> {
  if (runningApply.has(telegramId)) {
    await ctx.reply(
      '⚠️ Вже виконується масовий відгук. Зачекай або зупини: /stop_apply',
    );
    return;
  }

  const user = await userRepo.findByTelegramId(BigInt(telegramId));
  if (!user) return;

  const [profile, cv] = await Promise.all([
    prisma.userProfile.findUnique({ where: { userId: user.id } }),
    cvRepo.findActiveByUser(user.id),
  ]);

  if (!profile?.email || !profile?.fullName) {
    await ctx.reply(
      '❌ *Профіль не заповнено*\n\nДля авто-відгуку потрібні контактні дані.\n\nЗаповни: /profile',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (!cv?.extractedText) {
    await ctx.reply('❌ *CV не завантажено*\n\nЗавантаж PDF: /cv', { parse_mode: 'Markdown' });
    return;
  }

  // Завантажуємо CV файл один раз для всіх відгуків
  let cvLocalPath: string | undefined;
  try {
    const file = await ctx.api.getFile(cv.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    cvLocalPath = path.join(UPLOADS_DIR, `cv_${user.id}_bulk.pdf`);
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(cvLocalPath, resp.data as Buffer);
  } catch (err) {
    logger.warn(`[BulkApply] CV завантаження: ${(err as Error).message}`);
  }

  const profileData = {
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
  };

  applyQueues.set(telegramId, [...urls]);
  runningApply.add(telegramId);

  const statusMsg = await ctx.reply(
    `🚀 *Масовий авто-відгук запущено*\n\n` +
    `📋 Черга: *${urls.length}* вакансій\n` +
    `⏱ Орієнтовний час: ~${Math.ceil(urls.length * 1.5)} хв\n\n` +
    `_Подаю відгуки послідовно, зачекай..._\n\n` +
    `[⏹ Зупинити](tg://callback_data/bulk_stop)`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '⏹ Зупинити', callback_data: 'bulk_stop' }]],
      },
    },
  );

  // Результати
  const results: Array<{ url: string; success: boolean; method: string; error?: string }> = [];
  let done = 0;

  for (const url of urls) {
    // Перевіряємо чи не зупинено
    if (!runningApply.has(telegramId)) break;

    done++;
    logger.info(`[BulkApply] ${done}/${urls.length}: ${url}`);

    // Оновлюємо статус-повідомлення
    await ctx.api.editMessageText(
      telegramId,
      statusMsg.message_id,
      `🚀 *Масовий авто-відгук*\n\n` +
      `📋 Прогрес: *${done}/${urls.length}*\n` +
      `⏳ Обробляю: ${new URL(url).hostname}...\n\n` +
      results.slice(-3).map(r => `${r.success ? '✅' : '❌'} ${r.method} — ${new URL(r.url).hostname}`).join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '⏹ Зупинити', callback_data: 'bulk_stop' }]],
        },
      },
    ).catch(() => undefined);

    try {
      // Знаходимо або створюємо вакансію в БД
      let vacancy = await prisma.vacancy.findFirst({ where: { url } });

      if (!vacancy) {
        // Зберігаємо мінімальну вакансію щоб мати ID
        vacancy = await prisma.vacancy.create({
          data: {
            title: 'Manual URL',
            company: new URL(url).hostname,
            url,
            source: 'PRACUJPL', // використовуємо як generic
            country: 'Poland',
          },
        });
      }

      const result = await autoApplyService.applyToVacancy(
        user.id,
        vacancy,
        cv.extractedText,
        cv.fileId,
        profileData,
        cvLocalPath,
      );

      await autoApplyService.recordAutoApply(user.id, vacancy.id, result.success);

      results.push({ url, success: result.success, method: result.method });

      // Повідомлення про результат кожної вакансії
      const hostname = new URL(url).hostname.replace('www.', '');
      await ctx.reply(
        `${result.success ? '✅' : '❌'} *${hostname}*\n${result.method}\n🔗 ${url}`,
        {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
        },
      );

      // Скріншот тільки якщо success
      if (result.success && result.screenshotBase64) {
        try {
          const buf = Buffer.from(result.screenshotBase64, 'base64');
          await ctx.replyWithPhoto(new InputFile(buf, 'screenshot.png'));
        } catch { /* ignore */ }
      }

    } catch (err) {
      const msg = (err as Error).message.slice(0, 100);
      results.push({ url, success: false, method: 'Error', error: msg });
      await ctx.reply(`❌ Помилка: ${new URL(url).hostname}\n\`${msg}\``, { parse_mode: 'Markdown' });
    }

    // Пауза між відгуками (2-4 сек рандом щоб не виглядати як бот)
    const pause = 2000 + Math.random() * 2000;
    await sleep(pause);
  }

  // Прибираємо тимчасовий CV
  if (cvLocalPath && fs.existsSync(cvLocalPath)) {
    fs.unlinkSync(cvLocalPath);
  }

  runningApply.delete(telegramId);
  applyQueues.delete(telegramId);

  // Фінальна статистика
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  await ctx.api.editMessageText(
    telegramId,
    statusMsg.message_id,
    `✅ *Масовий відгук завершено!*\n\n` +
    `📊 Результат:\n` +
    `✅ Успішно: *${successful}/${results.length}*\n` +
    `❌ Помилки: *${failed}*\n\n` +
    (failed > 0
      ? `_Невдалі відгуки потребують ручного заповнення — браузер відкритий_`
      : `_Всі відгуки подано автоматично!_`),
    { parse_mode: 'Markdown' },
  ).catch(() => undefined);

  logger.info(`[BulkApply] Done. ${successful}/${results.length} successful`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
