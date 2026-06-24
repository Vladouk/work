import { Context } from 'grammy';
import { UserRepository } from '../../repositories/UserRepository';
import { settingsKeyboard } from '../keyboards';
import { logger } from '../../infrastructure/logger';

const userRepo = new UserRepository();
const pendingInput = new Map<number, { type: string }>();

export async function handleSettings(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  try {
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    const s = user?.settings;

    const text = [
      `⚙️ *Твої налаштування*`,
      ``,
      `🔑 Ключові слова: ${s?.keywords?.join(', ') ?? 'не задано'}`,
      `🌍 Країна: ${s?.country ?? 'Польща'}`,
      `📍 Місто: ${s?.city ?? 'будь-яке'}`,
      `🏠 Тільки Remote: ${s?.remoteOnly ? 'Так ✅' : 'Ні'}`,
      `💰 Зарплата: ${s?.salaryMin ?? 'будь-яка'} – ${s?.salaryMax ?? '∞'} ${s?.currency ?? 'PLN'}`,
      `🎯 Мін. збіг: ${s?.minMatchScore ?? 60}%`,
      `🔔 Сповіщення: ${s?.notifyEnabled ? 'Увімкнено ✅' : 'Вимкнено ❌'}`,
      ``,
      `Натисни кнопку щоб змінити:`,
    ].join('\n');

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: settingsKeyboard,
    });
  } catch (err) {
    logger.error(`[Settings] Помилка: ${(err as Error).message}`);
    await ctx.reply('Помилка завантаження налаштувань.');
  }
}

export async function handleSettingsCallback(ctx: Context, action: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  switch (action) {
    case 'keywords':
      pendingInput.set(from.id, { type: 'keywords' });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        '🔑 *Ключові слова*\n\nНадішли список через кому:\n\n' +
          'Приклад: `junior, node.js, react, backend`\n\n' +
          '_Використовуються для фільтрації вакансій_',
        { parse_mode: 'Markdown' },
      );
      break;

    case 'location':
      pendingInput.set(from.id, { type: 'location' });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        '📍 *Місто*\n\nНадішли назву міста або `будь-яке`:\n\nПриклад: `Wrocław`',
        { parse_mode: 'Markdown' },
      );
      break;

    case 'remote': {
      const user = await userRepo.findByTelegramId(BigInt(from.id));
      const current = user?.settings?.remoteOnly ?? false;
      await userRepo.updateSettings(user!.id, { remoteOnly: !current });
      await ctx.answerCallbackQuery(`Remote: ${!current ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}`);
      await handleSettings(ctx);
      break;
    }

    case 'salary':
      pendingInput.set(from.id, { type: 'salary' });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        '💰 *Діапазон зарплати (PLN)*\n\nФормат: `мін-макс`\n\n' +
          'Приклад: `3000-8000`\n\nНадішли `будь-яка` щоб прибрати фільтр',
        { parse_mode: 'Markdown' },
      );
      break;

    case 'notify': {
      const user = await userRepo.findByTelegramId(BigInt(from.id));
      const current = user?.settings?.notifyEnabled ?? true;
      await userRepo.updateSettings(user!.id, { notifyEnabled: !current });
      await ctx.answerCallbackQuery(`Сповіщення: ${!current ? 'УВІМКНЕНО' : 'ВИМКНЕНО'}`);
      await handleSettings(ctx);
      break;
    }

    case 'minscore':
      pendingInput.set(from.id, { type: 'minscore' });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        '🎯 *Мінімальний відсоток збігу*\n\n' +
          'Надішли число від 0 до 100:\n\nПриклад: `70`\n\n' +
          '_Тільки вакансії з таким % або вище будуть тебе сповіщати_',
        { parse_mode: 'Markdown' },
      );
      break;

    default:
      await ctx.answerCallbackQuery();
  }
}

export async function handleSettingsInput(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  if (!from) return false;

  const pending = pendingInput.get(from.id);
  if (!pending) return false;

  const text = ctx.message?.text ?? '';
  pendingInput.delete(from.id);

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return false;

  switch (pending.type) {
    case 'keywords': {
      const keywords = text.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
      await userRepo.updateSettings(user.id, { keywords });
      await ctx.reply(`✅ Ключові слова оновлено: ${keywords.join(', ')}`);
      return true;
    }

    case 'location': {
      if (text.toLowerCase() === 'будь-яке' || text.toLowerCase() === 'any') {
        await userRepo.updateSettings(user.id, { city: null });
        await ctx.reply('✅ Місто: будь-яке місто в Польщі');
      } else {
        await userRepo.updateSettings(user.id, { city: text.trim() });
        await ctx.reply(`✅ Місто встановлено: ${text.trim()}`);
      }
      return true;
    }

    case 'salary': {
      if (text.toLowerCase() === 'будь-яка' || text.toLowerCase() === 'any') {
        await userRepo.updateSettings(user.id, { salaryMin: null, salaryMax: null });
        await ctx.reply('✅ Фільтр зарплати прибрано');
      } else {
        const match = text.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (match) {
          const min = parseInt(match[1], 10);
          const max = parseInt(match[2], 10);
          await userRepo.updateSettings(user.id, { salaryMin: min, salaryMax: max });
          await ctx.reply(`✅ Зарплата: ${min.toLocaleString()}–${max.toLocaleString()} PLN`);
        } else {
          await ctx.reply('❌ Невірний формат. Приклад: `3000-8000`', { parse_mode: 'Markdown' });
        }
      }
      return true;
    }

    case 'minscore': {
      const score = parseInt(text.trim(), 10);
      if (isNaN(score) || score < 0 || score > 100) {
        await ctx.reply('❌ Введи число від 0 до 100');
      } else {
        await userRepo.updateSettings(user.id, { minMatchScore: score });
        await ctx.reply(`✅ Мінімальний збіг: ${score}%`);
      }
      return true;
    }

    default:
      return false;
  }
}
