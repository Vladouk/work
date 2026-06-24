import * as cheerio from 'cheerio';
import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const BASE = 'https://theprotocol.it';
const URL = `${BASE}/filtry/oferty-pracy;t?specializations=it&experienceLevels=junior,intern,trainee`;

export class TheProtocolParser extends BaseParser {
  readonly source: JobSource = 'BULLDOGJOB'; // reuse enum — same Poland IT niche

  async parse(): Promise<RawVacancy[]> {
    try {
      const vacancies = await this.withRetry(() => this.parsePage(URL));
      logger.info(`[TheProtocol] Знайдено ${vacancies.length} вакансій`);
      return vacancies;
    } catch (err) {
      logger.error(`[TheProtocol] ${(err as Error).message}`);
      return [];
    }
  }

  private async parsePage(url: string): Promise<RawVacancy[]> {
    const response = await this.http.get(url, {
      headers: { Accept: 'text/html', 'Accept-Language': 'pl-PL,pl;q=0.9' },
    });

    const $ = cheerio.load(response.data as string);
    const vacancies: RawVacancy[] = [];

    // TheProtocol stores data in __NEXT_DATA__
    const nextDataEl = $('#__NEXT_DATA__').html();
    if (nextDataEl) {
      try {
        const nextData = JSON.parse(nextDataEl);
        const offers = this.deepFind(nextData, 'offers') ?? this.deepFind(nextData, 'jobs') ?? [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const o of offers as any[]) {
          const mapped = this.mapOffer(o);
          if (mapped) vacancies.push(mapped);
        }
      } catch { /* fall through */ }
    }

    // HTML fallback
    if (vacancies.length === 0) {
      $('a[href*="/oferty-pracy/"]').each((_, el) => {
        try {
          const $el = $(el);
          const title = $el.find('h2, h3, [class*="title"]').first().text().trim()
            || $el.attr('title') || '';
          const href = $el.attr('href') ?? '';
          if (!title || !href) return;

          const fullUrl = href.startsWith('http') ? href : `${BASE}${href}`;
          if (!this.isJuniorVacancy(title)) return;

          vacancies.push({
            title,
            company: $el.find('[class*="company"]').first().text().trim() || 'Unknown',
            location: 'Poland',
            country: 'Poland',
            isRemote: false,
            url: fullUrl,
            source: this.source,
            category: this.detectCategory(title),
            experienceLevel: this.detectExperienceLevel(title),
          });
        } catch { /* skip */ }
      });
    }

    return vacancies;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapOffer(o: any): RawVacancy | null {
    try {
      const title = o.title ?? o.name ?? '';
      const slug = o.slug ?? o.id ?? '';
      if (!title || !slug) return null;
      if (!this.isJuniorVacancy(title, o.experienceLevel ?? '')) return null;

      const city = o.city ?? o.location?.city ?? o.workplace ?? '';
      const isRemote = o.remoteWork ?? o.isRemote ?? (o.workType === 'remote' || false);

      return {
        title,
        company: o.company?.name ?? o.companyName ?? o.employer ?? '',
        city,
        location: city || (isRemote ? 'Remote' : 'Poland'),
        country: 'Poland',
        isRemote,
        salaryMin: o.salaryFrom ?? o.salary?.from,
        salaryMax: o.salaryTo ?? o.salary?.to,
        currency: o.currency ?? o.salary?.currency ?? 'PLN',
        url: `${BASE}/oferty-pracy/${slug}`,
        source: this.source,
        category: this.detectCategory(title, (o.technologies ?? []).join(' ')),
        experienceLevel: this.detectExperienceLevel(o.experienceLevel ?? title),
        tags: (o.technologies ?? o.skills ?? []).map(
          (s: string | { name: string }) => typeof s === 'string' ? s.toLowerCase() : s.name.toLowerCase(),
        ),
        externalId: String(slug),
      };
    } catch { return null; }
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
}
