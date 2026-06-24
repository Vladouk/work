import { Bot } from 'grammy';
import { Vacancy } from '@prisma/client';
import { prisma } from '../infrastructure/database';
import { UserRepository } from '../repositories/UserRepository';
import { VacancyRepository } from '../repositories/VacancyRepository';
import { CvRepository } from '../repositories/CvRepository';
import { openaiService } from './openai.service';
import { logger } from '../infrastructure/logger';

export class NotificationService {
  private bot: Bot;
  private userRepo: UserRepository;
  private vacancyRepo: VacancyRepository;
  private cvRepo: CvRepository;

  constructor(bot: Bot) {
    this.bot = bot;
    this.userRepo = new UserRepository();
    this.vacancyRepo = new VacancyRepository();
    this.cvRepo = new CvRepository();
  }

  async notifyUsersAboutNewJobs(since: Date): Promise<void> {
    const users = await this.userRepo.findActive();
    const activeUsers = users.filter((u) => u.settings?.notifyEnabled);

    if (activeUsers.length === 0) {
      logger.info('[Notifications] No active users to notify');
      return;
    }

    for (const user of activeUsers) {
      try {
        await this.notifyUser(user.id, Number(user.telegramId), user.settings, since);
      } catch (err) {
        logger.error(`[Notifications] Failed for user ${user.id}: ${(err as Error).message}`);
      }
    }
  }

  private async notifyUser(
    userId: number,
    telegramId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    settings: any,
    since: Date,
  ): Promise<void> {
    const filter = {
      keywords: settings?.keywords ?? ['junior'],
      city: settings?.remoteOnly ? undefined : settings?.city ?? undefined,
      country: settings?.country ?? 'Poland',
      isRemote: settings?.remoteOnly ? true : undefined,
      salaryMin: settings?.salaryMin ?? undefined,
    };

    const newVacancies = await this.vacancyRepo.findNew(since, filter);
    if (newVacancies.length === 0) return;

    logger.info(`[Notifications] User ${userId}: ${newVacancies.length} new vacancies to check`);

    const cv = await this.cvRepo.findActiveByUser(userId);
    const minScore = settings?.minMatchScore ?? 60;

    for (const vacancy of newVacancies) {
      try {
        let matchScore: number | undefined;
        let matchReason: string | undefined;

        if (cv?.extractedText) {
          const existing = await this.cvRepo.findMatch(vacancy.id, cv.id);
          if (existing) {
            matchScore = existing.matchScore;
            matchReason = existing.matchReason ?? undefined;
          } else {
            const result = await openaiService.matchCvToVacancy(
              cv.extractedText,
              vacancy.title,
              vacancy.description ?? '',
            );
            matchScore = result.matchScore;
            matchReason = result.matchReason;

            await this.cvRepo.saveMatch({
              vacancyId: vacancy.id,
              cvFileId: cv.id,
              ...result,
            });
          }

          if (matchScore < minScore) continue;
        }

        await this.sendVacancyNotification(telegramId, vacancy, matchScore, matchReason);
        await this.recordNotification(userId, vacancy.id, matchScore);
        await this.sleep(100); // avoid hitting Telegram rate limits
      } catch (err) {
        logger.error(`[Notifications] Failed to process vacancy ${vacancy.id}: ${(err as Error).message}`);
      }
    }
  }

  async sendVacancyNotification(
    telegramId: number,
    vacancy: Vacancy,
    matchScore?: number,
    matchReason?: string,
  ): Promise<void> {
    const salaryText = vacancy.salaryMin && vacancy.salaryMax
      ? `💰 ${vacancy.salaryMin.toLocaleString()}–${vacancy.salaryMax.toLocaleString()} ${vacancy.currency ?? 'PLN'}`
      : vacancy.salaryMin
      ? `💰 від ${vacancy.salaryMin.toLocaleString()} ${vacancy.currency ?? 'PLN'}`
      : '💰 Зарплата не вказана';

    const locationText = vacancy.isRemote ? '🌍 Remote' : `📍 ${vacancy.location ?? 'Польща'}`;
    const scoreText = matchScore !== undefined ? `\n🎯 *Збіг: ${matchScore}%*` : '';
    const reasonText = matchReason ? `\n_${this.escape(matchReason)}_` : '';

    const message = [
      `🚀 *Нова підходяща вакансія\\!*`,
      ``,
      `*${this.escape(vacancy.title)}*`,
      `🏢 ${this.escape(vacancy.company)}`,
      locationText,
      salaryText,
      scoreText,
      reasonText,
      ``,
      `🔗 [Переглянути вакансію](${vacancy.url})`,
    ]
      .filter(Boolean)
      .join('\n');

    await this.bot.api.sendMessage(telegramId, message, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: false },
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💾 Зберегти', callback_data: `save_job_${vacancy.id}` },
            { text: '✅ Відправив', callback_data: `applied_job_${vacancy.id}` },
          ],
          [
            { text: '🤖 Супровідний лист', callback_data: `cover_letter_${vacancy.id}` },
            { text: '📝 Повідомлення', callback_data: `outreach_${vacancy.id}` },
          ],
          [
            { text: '📨 Авто-відгук', callback_data: `auto_apply_${vacancy.id}` },
          ],
          [
            { text: '❌ Приховати', callback_data: `hide_job_${vacancy.id}` },
          ],
        ],
      },
    });
  }

  private async recordNotification(userId: number, vacancyId: number, matchScore?: number): Promise<void> {
    await prisma.notification.create({
      data: {
        userId,
        vacancyId,
        matchScore,
        status: 'SENT',
        sentAt: new Date(),
      },
    });
  }

  private escape(text: string): string {
    // Escape only characters that break Markdown v1 in Telegram
    return (text ?? '').replace(/[*_[\]`]/g, '\\$&');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
