import * as cheerio from 'cheerio';
import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const BASE = 'https://bulldogjob.pl';

// Сторінки з фільтром junior/intern/trainee
const PAGES = [
  `${BASE}/companies/jobs/s/experienceLevel,junior`,
  `${BASE}/companies/jobs/s/experienceLevel,intern`,
  `${BASE}/companies/jobs/s/experienceLevel,trainee`,
];

// Дозволені локації
const ALLOWED_LOCATIONS = ['wrocław', 'wroclaw', 'remote', 'poland', 'polska', 'zdaln'];

export class BulldogJobParser extends BaseParser {
  readonly source: JobSource = 'BULLDOGJOB';

  async parse(): Promise<RawVacancy[]> {
    const all: RawVacancy[] = [];

    for (const url of PAGES) {
      try {
        const results = await this.withRetry(() => this.parsePage(url));
        all.push(...results);
        await this.sleep(1200);
      } catch (err) {
        logger.warn(`[BulldogJob] ${url}: ${(err as Error).message}`);
      }
    }

    const deduped = this.deduplicateByUrl(all);
    logger.info(`[BulldogJob] Знайдено ${deduped.length} вакансій`);
    return deduped;
  }

  private async parsePage(url: string): Promise<RawVacancy[]> {
    const response = await this.http.get(url, {
      headers: { Accept: 'text/html', 'Accept-Language': 'pl-PL,pl;q=0.9' },
    });

    const $ = cheerio.load(response.data as string);
    const vacancies: RawVacancy[] = [];

    // Bulldogjob зберігає дані у __NEXT_DATA__
    const nextDataRaw = $('#__NEXT_DATA__').html();
    if (nextDataRaw) {
      try {
        const nextData = JSON.parse(nextDataRaw);
        const jobs =
          this.deepFind(nextData, 'jobs') ??
          this.deepFind(nextData, 'offers') ??
          this.deepFind(nextData, 'listings') ??
          [];

        for (const job of jobs as object[]) {
          const mapped = this.mapJob(job);
          if (mapped) vacancies.push(mapped);
        }

        if (vacancies.length > 0) return vacancies;
      } catch {
        /* fall through до HTML */
      }
    }

    // HTML fallback
    $('[class*="JobItem"], [class*="job-item"], [class*="JobListItem"], [class*="listing"]').each((_, el) => {
      try {
        const $el = $(el);
        const title = $el.find('h2, h3, [class*="title"]').first().text().trim();
        const company = $el.find('[class*="company"]').first().text().trim();
        const location = $el.find('[class*="location"], [class*="city"]').first().text().trim();
        const salary = $el.find('[class*="salary"]').first().text().trim();
        const href = $el.find('a').first().attr('href') ?? '';
        if (!title || !href) return;

        if (!this.isJuniorVacancy(title)) return;
        if (!this.isAllowedLocation(location)) return;

        const fullUrl = href.startsWith('http') ? href : `${BASE}${href}`;
        const parsed = this.parseSalary(salary);

        vacancies.push({
          title,
          company: company || 'Unknown',
          location: location || 'Poland',
          city: this.normalizeCity(location),
          country: 'Poland',
          isRemote: location.toLowerCase().includes('remote'),
          salaryMin: parsed.min,
          salaryMax: parsed.max,
          currency: parsed.currency ?? 'PLN',
          url: fullUrl,
          source: this.source,
          category: this.detectCategory(title),
          experienceLevel: this.detectExperienceLevel(title),
        });
      } catch {
        /* skip */
      }
    });

    return vacancies;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapJob(job: any): RawVacancy | null {
    try {
      const title: string = job.title ?? job.name ?? '';
      const id: string = String(job.id ?? job.slug ?? '');
      if (!title) return null;

      const seniority: string = (job.seniority ?? job.experienceLevel ?? '').toLowerCase();
      const isJuniorLevel =
        seniority === 'junior' ||
        seniority === 'intern' ||
        seniority === 'trainee' ||
        this.isJuniorVacancy(title);

      if (!isJuniorLevel) return null;

      const city: string = job.city ?? job.location ?? '';
      const isRemote: boolean = job.remote ?? job.isRemote ?? false;

      if (!this.isAllowedLocation(`${city} ${isRemote ? 'remote' : ''}`)) return null;

      const jobUrl = job.url
        ? job.url.startsWith('http') ? job.url : `${BASE}${job.url}`
        : `${BASE}/jobs/${id}`;

      return {
        title,
        company: job.company?.name ?? job.companyName ?? '',
        city,
        location: city || (isRemote ? 'Remote' : 'Poland'),
        country: 'Poland',
        isRemote,
        salaryMin: job.salaryFrom ?? job.salary_from,
        salaryMax: job.salaryTo ?? job.salary_to,
        currency: job.currency ?? 'PLN',
        url: jobUrl,
        source: this.source,
        category: this.detectCategory(title, (job.skills ?? []).join(' ')),
        experienceLevel: this.detectExperienceLevel(seniority || title),
        tags: job.skills ?? [],
        externalId: id || undefined,
      };
    } catch {
      return null;
    }
  }

  private isAllowedLocation(location: string): boolean {
    if (!location) return true; // якщо немає локації — пропускаємо
    const lower = location.toLowerCase();
    return ALLOWED_LOCATIONS.some((loc) => lower.includes(loc));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private deepFind(obj: any, key: string): any[] | null {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj[key]) && obj[key].length > 0) return obj[key];
    for (const v of Object.values(obj)) {
      const found = this.deepFind(v, key);
      if (found) return found;
    }
    return null;
  }

  private deduplicateByUrl(v: RawVacancy[]): RawVacancy[] {
    const seen = new Set<string>();
    return v.filter((x) => {
      if (seen.has(x.url)) return false;
      seen.add(x.url);
      return true;
    });
  }
}
