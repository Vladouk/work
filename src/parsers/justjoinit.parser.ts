import { chromium } from 'playwright';
import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const BASE = 'https://justjoin.it';
const API_BASE = 'https://justjoin.it/api/candidate-api';

const TITLE_KEYWORDS = [
  'junior', 'intern', 'internship', 'trainee', 'stażysta', 'praktykant', 'młodszy',
];

const ALLOWED_LOCATIONS = ['wrocław', 'wroclaw', 'remote', 'poland', 'polska', 'zdaln'];

export class JustJoinITParser extends BaseParser {
  readonly source: JobSource = 'JUSTJOINIT';

  async parse(): Promise<RawVacancy[]> {
    // Спробуємо через прямий candidate-api
    try {
      const apiResults = await this.fetchViaApi();
      if (apiResults.length > 0) {
        logger.info(`[JustJoinIT] Знайдено ${apiResults.length} вакансій через API`);
        return apiResults;
      }
    } catch (err) {
      logger.warn(`[JustJoinIT] API failed: ${(err as Error).message}, fallback to Playwright`);
    }

    // Fallback: Playwright + DOM parsing
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'pl-PL',
      });

      const collectedOffers: object[] = [];

      const page = await context.newPage();

      // Перехоплюємо API запити
      page.on('response', async (response) => {
        const url = response.url();
        const ct = response.headers()['content-type'] ?? '';
        if (!ct.includes('application/json')) return;
        if (url.includes('candidate-api/offers') || url.includes('candidate-api/jobs')) {
          try {
            const json = await response.json();
            const items = Array.isArray(json)
              ? json
              : json?.data ?? json?.offers ?? json?.items ?? json?.results ?? [];
            if (Array.isArray(items) && items.length > 0) {
              collectedOffers.push(...items);
            }
          } catch { /* ignore */ }
        }
      });

      await page.goto(
        `${BASE}/job-offers?experienceLevel=junior&orderBy=newest`,
        { waitUntil: 'domcontentloaded', timeout: 45000 },
      );
      await page.waitForTimeout(5000);

      // Парсимо DOM якщо API не перехопили
      if (collectedOffers.length === 0) {
        const html = await page.content();
        await browser.close();
        return this.parseHtml(html);
      }

      await browser.close();

      const results: RawVacancy[] = [];
      for (const o of collectedOffers) {
        const mapped = this.mapOffer(o as Record<string, unknown>);
        if (mapped) results.push(mapped);
      }

      // Дедуплікація
      const deduped = [...new Map(results.map((v) => [v.url, v])).values()];
      logger.info(`[JustJoinIT] Знайдено ${deduped.length} вакансій`);
      return deduped;
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      logger.error(`[JustJoinIT] ${(err as Error).message}`);
      return [];
    }
  }

  private mapOffer(o: Record<string, unknown>): RawVacancy | null {
    try {
      const title = String(o.title ?? o.name ?? '');
      const slug = String(o.slug ?? o.id ?? '');
      if (!title || !slug) return null;

      const experienceLevel = String(o.experienceLevel ?? o.seniority ?? '').toLowerCase();
      const titleLower = title.toLowerCase();
      const isJuniorLevel =
        experienceLevel === 'junior' ||
        experienceLevel === 'intern' ||
        experienceLevel === 'trainee' ||
        TITLE_KEYWORDS.some((kw) => titleLower.includes(kw));

      if (!isJuniorLevel) return null;

      const city = String(o.city ?? o.location ?? '');
      const workplaceType = String(o.workplaceType ?? o.workplace_type ?? '').toLowerCase();
      const isRemote = workplaceType === 'remote' || workplaceType === 'remote_only' || workplaceType === 'fully_remote';
      const locationStr = `${city} ${workplaceType}`.toLowerCase();

      const isAllowedLocation =
        isRemote ||
        ALLOWED_LOCATIONS.some((loc) => locationStr.includes(loc)) ||
        city === '';

      if (!isAllowedLocation) return null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const salaryRange = (o.salaryRanges as any)?.[0] ?? (o.salary as any) ?? {};
      const salaryMin: number | undefined = salaryRange.from ?? salaryRange.min ?? undefined;
      const salaryMax: number | undefined = salaryRange.to ?? salaryRange.max ?? undefined;
      const currency: string = salaryRange.currency ?? 'PLN';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const skills: string[] = ((o.skills ?? o.requiredSkills ?? []) as any[]).map(
        (s) => (typeof s === 'string' ? s : s?.name ?? ''),
      );

      return {
        title,
        company: String(o.companyName ?? o.company ?? ''),
        city,
        location: city || (isRemote ? 'Remote' : 'Poland'),
        country: 'Poland',
        isRemote,
        salaryMin,
        salaryMax,
        currency,
        url: `${BASE}/job-offer/${slug}`,
        source: this.source,
        category: this.detectCategory(title, skills.join(' ')),
        experienceLevel: this.detectExperienceLevel(experienceLevel || title),
        tags: skills,
        externalId: String(slug),
        postedAt: o.publishedAt ? new Date(o.publishedAt as string) : undefined,
      };
    } catch {
      return null;
    }
  }

  // Прямий запит до candidate-api
  private async fetchViaApi(): Promise<RawVacancy[]> {
    const results: RawVacancy[] = [];

    for (const level of ['junior', 'intern', 'trainee']) {
      try {
        const resp = await this.http.get(`${API_BASE}/offers`, {
          params: {
            experienceLevel: level,
            orderBy: 'newest',
            page: 1,
            perPage: 100,
          },
          headers: {
            Accept: 'application/json',
            Referer: 'https://justjoin.it/',
            Origin: 'https://justjoin.it',
            'Accept-Language': 'pl-PL,pl;q=0.9',
          },
          timeout: 20000,
        });
        // API повертає { data: [...] }
        const items = Array.isArray(resp.data)
          ? resp.data
          : resp.data?.data ?? resp.data?.offers ?? resp.data?.items ?? [];
        for (const o of items) {
          const mapped = this.mapOffer(o as Record<string, unknown>);
          if (mapped) results.push(mapped);
        }
        logger.info(`[JustJoinIT] API level=${level}: ${items.length} офферів`);
      } catch (err) {
        logger.warn(`[JustJoinIT] API level=${level} failed: ${(err as Error).message}`);
      }
    }

    return [...new Map(results.map((v) => [v.url, v])).values()];
  }

  // HTML fallback
  private parseHtml(html: string): RawVacancy[] {
    const results: RawVacancy[] = [];
    try {
      const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (match) {
        const nextData = JSON.parse(match[1]);
        const offers =
          nextData?.props?.pageProps?.offers ??
          nextData?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.data ??
          [];
        if (Array.isArray(offers)) {
          for (const o of offers) {
            const mapped = this.mapOffer(o as Record<string, unknown>);
            if (mapped) results.push(mapped);
          }
        }
      }
    } catch { /* ignore */ }
    return results;
  }
}