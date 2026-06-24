import { Context } from 'grammy';
import { VacancyRepository } from '../../repositories/VacancyRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { jobActionsKeyboard, paginationKeyboard } from '../keyboards';
import { logger } from '../../infrastructure/logger';
import { Vacancy } from '@prisma/client';

const vacancyRepo = new VacancyRepository();
const userRepo = new UserRepository();

const PAGE_SIZE = 5;

export async function handleJobs(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  try {
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    const settings = user?.settings;

    const filter = {
      keywords: settings?.keywords ?? ['junior'],
      city: settings?.remoteOnly ? undefined : settings?.city ?? undefined,
      country: settings?.country ?? 'Poland',
      isRemote: settings?.remoteOnly ? true : undefined,
      limit: PAGE_SIZE,
      offset: 0,
      excludeApplied: true,
      userId: user?.id,
    };

    const vacancies = await vacancyRepo.findMany(filter);
    const total = await vacancyRepo.count(filter);

    if (vacancies.length === 0) {
      await ctx.reply(
        '😔 Вакансій за твоїми фільтрами не знайдено.\n\n' +
          'Спробуй змінити ключові слова в /settings або перевір пізніше.',
      );
      return;
    }

    await ctx.reply(
      `📋 *Знайдено ${total} вакансій*\nПоказую ${vacancies.length} останніх:\n\n` +
        '_Підказка: /search <ключове слово> для пошуку_',
      { parse_mode: 'Markdown' },
    );

    for (const vacancy of vacancies) {
      await sendVacancyCard(ctx, vacancy);
      await sleep(100);
    }

    if (total > PAGE_SIZE) {
      const totalPages = Math.ceil(total / PAGE_SIZE);
      await ctx.reply(`Сторінка 1/${totalPages}`, {
        reply_markup: paginationKeyboard(1, totalPages, 'jobs'),
      });
    }
  } catch (err) {
    logger.error(`[Jobs] Помилка: ${(err as Error).message}`);
    await ctx.reply('Помилка завантаження вакансій. Спробуй ще раз.');
  }
}

export async function handleJobsPage(ctx: Context, page: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  const settings = user?.settings;

  const filter = {
    keywords: settings?.keywords ?? ['junior'],
    city: settings?.remoteOnly ? undefined : settings?.city ?? undefined,
    country: settings?.country ?? 'Poland',
    isRemote: settings?.remoteOnly ? true : undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    excludeApplied: true,
    userId: user?.id,
  };

  const vacancies = await vacancyRepo.findMany(filter);
  const total = await vacancyRepo.count(filter);
  const totalPages = Math.ceil(total / PAGE_SIZE);

  for (const vacancy of vacancies) {
    await sendVacancyCard(ctx, vacancy);
    await sleep(100);
  }

  if (totalPages > 1) {
    await ctx.reply(`Сторінка ${page}/${totalPages}`, {
      reply_markup: paginationKeyboard(page, totalPages, 'jobs'),
    });
  }
}

export async function handleSearch(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? '';
  const query = text.replace('/search', '').trim();

  const from = ctx.from;
  if (!from) return;
  
  if (!query) {
    await ctx.reply(
      '🔍 *Пошук вакансій*\n\nФормат: `/search <ключове слово>`\n\nПриклади:\n' +
        '• `/search node.js backend`\n' +
        '• `/search react wroclaw`\n' +
        '• `/search qa remote`',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  try {
    const keywords = query.split(/\s+/);
    const user = await userRepo.findByTelegramId(BigInt(from.id));
    
    const vacancies = await vacancyRepo.findMany({
      keywords,
      limit: 10,
      excludeApplied: true,
      userId: user?.id,
    });

    if (vacancies.length === 0) {
      await ctx.reply(`😔 Нічого не знайдено за: *${query}*`, { parse_mode: 'Markdown' });
      return;
    }

    await ctx.reply(`🔍 *Результати: ${query}*\n\nЗнайдено ${vacancies.length} вакансій:`, {
      parse_mode: 'Markdown',
    });

    for (const vacancy of vacancies) {
      await sendVacancyCard(ctx, vacancy);
      await sleep(100);
    }
  } catch (err) {
    logger.error(`[Search] Помилка: ${(err as Error).message}`);
    await ctx.reply('Помилка пошуку. Спробуй ще раз.');
  }
}

export async function sendVacancyCard(ctx: Context, vacancy: Vacancy): Promise<void> {
  const salaryText = formatSalary(vacancy);
  const locationText = vacancy.isRemote ? '🌍 Remote' : `📍 ${vacancy.location ?? 'Польща'}`;
  const sourceEmoji = sourceEmojis[vacancy.source] ?? '🔗';

  const card = [
    `*${escapeMarkdown(vacancy.title)}*`,
    `🏢 ${escapeMarkdown(vacancy.company)}`,
    locationText,
    salaryText,
    `${sourceEmoji} ${vacancy.source}`,
    ``,
    `🔗 [Переглянути вакансію](${vacancy.url})`,
  ].join('\n');

  await ctx.reply(card, {
    parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true },
    reply_markup: jobActionsKeyboard(vacancy.id),
  });
}

function formatSalary(v: Vacancy): string {
  if (v.salaryMin && v.salaryMax) {
    return `💰 ${v.salaryMin.toLocaleString()}–${v.salaryMax.toLocaleString()} ${v.currency ?? 'PLN'}`;
  }
  if (v.salaryMin) return `💰 від ${v.salaryMin.toLocaleString()} ${v.currency ?? 'PLN'}`;
  if (v.salaryMax) return `💰 до ${v.salaryMax.toLocaleString()} ${v.currency ?? 'PLN'}`;
  return '💰 Зарплата не вказана';
}

const sourceEmojis: Record<string, string> = {
  LINKEDIN: '💼',   // залишаємо для старих записів у БД
  NOFLUFFJOBS: '🐾',
  JUSTJOINIT: '🟢',
  PRACUJPL: '🔵',
  BULLDOGJOB: '🐶',
};

function escapeMarkdown(text: string): string {
  return text.replace(/[*_[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
