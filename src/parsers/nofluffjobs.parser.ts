import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const API_URL = 'https://nofluffjobs.com/api/search/posting';
const BASE = 'https://nofluffjobs.com';

// Ключові слова рівня досвіду
const JUNIOR_LEVELS = ['junior', 'intern', 'trainee'];

// Дозволені локації
const ALLOWED_LOCATIONS = ['wrocław', 'wroclaw', 'remote', 'poland', 'polska'];

export class NoFluffJobsParser extends BaseParser {
  readonly source: JobSource = 'NOFLUFFJOBS';

  async parse(): Promise<RawVacancy[]> {
    try {
      const vacancies = await this.withRetry(() => this.fetchFromApi());
      logger.info(`[NoFluffJobs] Знайдено ${vacancies.length} вакансій`);
      return vacancies;
    } catch (err) {
      logger.error(`[NoFluffJobs] ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchFromApi(): Promise<RawVacancy[]> {
    // API підтримує фільтр по seniority і criteria
    const response = await this.http.post(
      API_URL,
      {
        criteria: [
          { field: 'seniority', values: ['junior', 'intern', 'trainee'] },
        ],
        page: 1,
        pageSize: 200,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'pl-PL,pl;q=0.9',
        },
        timeout: 30000,
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const postings: any[] = response.data?.postings ?? response.data?.items ?? [];

    const results: RawVacancy[] = [];
    for (const p of postings) {
      const mapped = this.mapPosting(p);
      if (mapped) results.push(mapped);
    }
    return results;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapPosting(p: any): RawVacancy | null {
    try {
      const title: string = p.title ?? p.name ?? '';
      const slug: string = p.url ?? p.slug ?? p.id ?? '';
      if (!title || !slug) return null;

      // Перевірка рівня
      const seniority: string[] = Array.isArray(p.seniority)
        ? p.seniority.map((s: string) => s.toLowerCase())
        : [String(p.seniority ?? '').toLowerCase()];

      const isJuniorLevel =
        seniority.some((s) => JUNIOR_LEVELS.includes(s)) ||
        JUNIOR_LEVELS.some((kw) => title.toLowerCase().includes(kw));

      if (!isJuniorLevel) return null;

      // Локація
      const location: string = p.location?.place ?? p.city ?? '';
      const isRemote = p.location?.fullyRemote === true || p.remote === true;
      const locationLower = `${location} ${isRemote ? 'remote' : ''}`.toLowerCase();

      const isAllowedLocation =
        isRemote ||
        ALLOWED_LOCATIONS.some((loc) => locationLower.includes(loc)) ||
        location === '';

      if (!isAllowedLocation) return null;

      // Зарплата
      const salary = p.salary ?? {};
      const salaryMin: number | undefined = salary.from ?? undefined;
      const salaryMax: number | undefined = salary.to ?? undefined;
      const currency: string = salary.currency ?? 'PLN';

      const fullUrl = slug.startsWith('http') ? slug : `${BASE}/pl/${slug}`;

      return {
        title,
        company: p.name ?? p.company?.name ?? '',
        city: location,
        location: location || (isRemote ? 'Remote' : 'Poland'),
        country: 'Poland',
        isRemote,
        salaryMin,
        salaryMax,
        currency,
        url: fullUrl,
        source: this.source,
        category: this.detectCategory(title, (p.technology ?? []).join(' ')),
        experienceLevel: this.detectExperienceLevel(seniority[0] ?? title),
        tags: p.technology ?? p.skills ?? [],
        externalId: String(p.id ?? slug),
        postedAt: p.posted ? new Date(p.posted) : undefined,
      };
    } catch {
      return null;
    }
  }
}
