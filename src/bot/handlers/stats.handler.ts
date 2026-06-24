import { Context } from 'grammy';
import { prisma } from '../../infrastructure/database';
import { UserRepository } from '../../repositories/UserRepository';
import { statsKeyboard } from '../keyboards';
import { logger } from '../../infrastructure/logger';

const userRepo = new UserRepository();

export async function handleStats(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  try {
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    if (!user) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [jobsToday, totalJobs, savedJobs, appliedJobs, matchingJobs, notifSent, autoApplied] =
      await Promise.all([
        prisma.vacancy.count({ where: { scrapedAt: { gte: today } } }),
        prisma.vacancy.count({ where: { isActive: true } }),
        prisma.application.count({ where: { userId: user.id, status: 'SAVED' } }),
        prisma.application.count({ where: { userId: user.id, status: 'APPLIED' } }),
        prisma.notification.count({ where: { userId: user.id } }),
        prisma.notification.count({ where: { userId: user.id, status: 'SENT' } }),
        prisma.application.count({ where: { userId: user.id, notes: { contains: 'auto-apply' } } }),
      ]);

    const text = [
      `📊 *Твій дашборд пошуку роботи*`,
      ``,
      `📅 *Сьогодні*`,
      `  • Нових вакансій знайдено: ${jobsToday}`,
      ``,
      `📈 *Загалом*`,
      `  • Вакансій у базі: ${totalJobs}`,
      `  • Підходить під твій профіль: ${matchingJobs}`,
      `  • Сповіщень надіслано: ${notifSent}`,
      ``,
      `📁 *Твої відгуки*`,
      `  • 💾 Збережено: ${savedJobs}`,
      `  • ✅ Відправлено вручну: ${appliedJobs}`,
      `  • 🤖 Авто-відгуків: ${autoApplied}`,
      ``,
      `_Оновлено: ${new Date().toLocaleTimeString('uk-UA')}_`,
    ].join('\n');

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: statsKeyboard,
    });
  } catch (err) {
    logger.error(`[Stats] Помилка: ${(err as Error).message}`);
    await ctx.reply('Помилка завантаження статистики.');
  }
}
