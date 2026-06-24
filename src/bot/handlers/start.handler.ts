import { Context } from 'grammy';
import { UserRepository } from '../../repositories/UserRepository';
import { mainMenuKeyboard } from '../keyboards';
import { logger } from '../../infrastructure/logger';

const userRepo = new UserRepository();

export async function handleStart(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  try {
    await userRepo.upsert({
      telegramId: BigInt(from.id),
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    });

    const name = from.first_name ?? from.username ?? 'друже';
    await ctx.reply(
      `👋 *Привіт, ${name}!*\n\n` +
        `Я твій особистий *мисливець за Junior IT вакансіями* в Польщі 🇵🇱\n\n` +
        `Що я вмію:\n` +
        `• 🔍 Сканую NoFluffJobs, JustJoinIT, BulldogJob та Pracuj.pl кожні 30 хв\n` +
        `• 🎯 Порівнюю вакансії з твоїм CV за допомогою AI\n` +
        `• 🔔 Надсилаю сповіщення про підходящі вакансії миттєво\n` +
        `• 🤖 Генерую супровідні листи та повідомлення для рекрутерів\n` +
        `• 📨 *Автоматично відправляю CV* на вакансії за тебе\n\n` +
        `*Як почати:*\n` +
        `1️⃣ Завантаж CV командою /cv\n` +
        `2️⃣ Заповни профіль командою /profile\n` +
        `3️⃣ Налаштуй фільтри командою /settings\n` +
        `4️⃣ Переглядай вакансії командою /jobs\n\n` +
        `Використовуй меню нижче:`,
      {
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard,
      },
    );

    logger.info(`[Start] Користувач: ${from.id} @${from.username}`);
  } catch (err) {
    logger.error(`[Start] Помилка: ${(err as Error).message}`);
    await ctx.reply('Щось пішло не так. Спробуй ще раз.');
  }
}
