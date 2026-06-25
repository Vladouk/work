import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const BASE = 'https://nofluffjobs.com';
const API_URL = 'https://nofluffjobs.com/api/search/posting';

const JUNIOR_LEVELS = ['junior', 'intern', 'trainee'];
const ALLOWED_LOCATIONS = ['wrocław', 'wroclaw', 'remote', 'poland', 'polska'];

export class NoFluffJobsParser extends BaseParser {
  readonly source: JobSource = 'NOFLUFFJOBS';

  async parse(): Promise<RawVacancy[]> {
    try {
      const results = await this.withRetry(() => this.fetchFromApi());
      logger.info(`[NoFluffJobs] Знайдено ${results.length} вакансій`);
      return results;
    } catch (err) {
      logger.error(`[NoFluffJobs] ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchFromApi(): Promise<RawVacancy[]> {
    const response = await this.http.post(
      API_URL,
      {
        criteria: [
          { field: 'seniority', values: ['junior', 'intern', 'trainee'] },
        ],
        page: 1,
        pageSize: 100,
        salaryCurrency: 'PLN',
        salaryPeriod: 'month',
        region: 'pl',
        language: 'pl-PL',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Origin: 'https://nofluffjobs.com',
          Referer: 'https://nofluffjobs.com/pl/praca',
          'Accept-Language': 'pl-PL,pl;q=0.9',
          'x-nfj-app': 'nfj',
        },
        timeout: 30000,
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const postings: any[] = response.data?.postings ?? response.data?.items ?? response.data?.data ?? [];
    logger.info(`[NoFluffJobs] API повернув ${postings.length} офферів`);

    const results: RawVacancy[] = [];
    for (const p of postings) {
      const mapped = this.mapPosting(p);
      if (mapped) results.push(mapped);
    }

    return [...new Map(results.map((v) => [v.url, v])).values()];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapPosting(p: any): RawVacancy | null {
    try {
      const title: string = p.title ?? p.name ?? '';
      const slug: string = p.url ?? p.slug ?? p.id ?? '';
      if (!title || !slug) return null;

      const seniority: string[] = Array.isArray(p.seniority)
        ? p.seniority.map((s: string) => s.toLowerCase())
        : [String(p.seniority ?? '').toLowerCase()];

      const isJuniorLevel =
        seniority.some((s) => JUNIOR_LEVELS.includes(s)) ||
        JUNIOR_LEVELS.some((kw) => title.toLowerCase().includes(kw));

      if (!isJuniorLevel) return null;

      const location: string = p.location?.place ?? p.city ?? '';
      const isRemote = p.location?.fullyRemote === true || p.remote === true;

      const locationStr = `${location} ${isRemote ? 'remote' : ''}`.toLowerCase();
      const isAllowedLocation =
        isRemote ||
        ALLOWED_LOCATIONS.some((loc) => locationStr.includes(loc)) ||
        location === '';

      if (!isAllowedLocation) return null;

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
