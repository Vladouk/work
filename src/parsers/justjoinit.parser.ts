import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const API_URL = 'https://justjoin.it/api/offers';
const BASE = 'https://justjoin.it';

// Ключові слова для фільтрації
const TITLE_KEYWORDS = [
  'junior', 'intern', 'internship', 'trainee', 'stażysta', 'praktykant', 'młodszy',
];

// Локації: Wrocław, Remote або вся Польща
const ALLOWED_LOCATIONS = ['wrocław', 'wroclaw', 'remote', 'poland', 'polska', 'zdaln'];

export class JustJoinITParser extends BaseParser {
  readonly source: JobSource = 'JUSTJOINIT';

  async parse(): Promise<RawVacancy[]> {
    try {
      const vacancies = await this.withRetry(() => this.fetchFromApi());
      logger.info(`[JustJoinIT] Знайдено ${vacancies.length} вакансій`);
      return vacancies;
    } catch (err) {
      logger.error(`[JustJoinIT] ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchFromApi(): Promise<RawVacancy[]> {
    // Публічний API — повертає всі вакансії без пагінації
    const response = await this.http.get(API_URL, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 30000,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offers: any[] = Array.isArray(response.data) ? response.data : [];

    const results: RawVacancy[] = [];

    for (const o of offers) {
      const mapped = this.mapOffer(o);
      if (mapped) results.push(mapped);
    }

    return results;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapOffer(o: any): RawVacancy | null {
    try {
      const title: string = o.title ?? '';
      const slug: string = o.slug ?? o.id ?? '';
      if (!title || !slug) return null;

      // Фільтр: тільки junior/intern/trainee
      const experienceLevel: string = (o.experienceLevel ?? '').toLowerCase();
      const titleLower = title.toLowerCase();
      const isJuniorLevel =
        experienceLevel === 'junior' ||
        experienceLevel === 'intern' ||
        experienceLevel === 'trainee' ||
        TITLE_KEYWORDS.some((kw) => titleLower.includes(kw));

      if (!isJuniorLevel) return null;

      // Фільтр локації: Wrocław, Remote або Польща
      const city: string = o.city ?? '';
      const workplaceType: string = (o.workplaceType ?? '').toLowerCase();
      const isRemote = workplaceType === 'remote' || workplaceType === 'remote_only';

      const locationStr = `${city} ${workplaceType}`.toLowerCase();
      const isAllowedLocation =
        isRemote ||
        ALLOWED_LOCATIONS.some((loc) => locationStr.includes(loc)) ||
        city === ''; // якщо місто не вказано — пропускаємо

      if (!isAllowedLocation) return null;

      // Зарплата
      const salaryRange = o.salaryRanges?.[0] ?? {};
      const salaryMin: number | undefined = salaryRange.from ?? undefined;
      const salaryMax: number | undefined = salaryRange.to ?? undefined;
      const currency: string = salaryRange.currency ?? 'PLN';

      return {
        title,
        company: o.companyName ?? '',
        city,
        location: city || (isRemote ? 'Remote' : 'Poland'),
        country: 'Poland',
        isRemote,
        salaryMin,
        salaryMax,
        currency,
        url: `${BASE}/job-offer/${slug}`,
        source: this.source,
        category: this.detectCategory(title, (o.skills ?? []).map((s: { name?: string } | string) =>
          typeof s === 'string' ? s : s.name ?? '').join(' ')),
        experienceLevel: this.detectExperienceLevel(experienceLevel || title),
        tags: (o.skills ?? []).map((s: { name?: string } | string) =>
          typeof s === 'string' ? s : s.name ?? ''),
        externalId: String(slug),
        postedAt: o.publishedAt ? new Date(o.publishedAt) : undefined,
      };
    } catch {
      return null;
    }
  }
}
