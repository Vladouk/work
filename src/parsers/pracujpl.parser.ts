import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const BASE = 'https://www.pracuj.pl';

// Пошукові запити: junior IT + Wrocław/Remote
const SEARCH_URLS = [
  `${BASE}/praca/junior%20developer;kw/wroclaw;wp?rd=30&et=1%2C17&pp=50`,
  `${BASE}/praca/junior%20node.js;kw/wroclaw;wp?rd=30&pp=50`,
  `${BASE}/praca/junior%20react;kw/wroclaw;wp?rd=30&pp=50`,
  `${BASE}/praca/junior%20javascript;kw/wroclaw;wp?rd=30&pp=50`,
  `${BASE}/praca/junior%20typescript;kw/wroclaw;wp?rd=30&pp=50`,
  `${BASE}/praca/qa%20junior;kw/wroclaw;wp?rd=30&pp=50`,
  `${BASE}/praca/it%20support;kw/wroclaw;wp?rd=30&et=1%2C17&pp=50`,
  `${BASE}/praca/helpdesk;kw/wroclaw;wp?rd=30&pp=50`,
  // Remote по всій Польщі
  `${BASE}/praca/junior%20developer;kw?rd=0&et=1%2C17&wm=1&pp=50`,
  `${BASE}/praca/junior%20node.js;kw?wm=1&pp=50`,
];

// Ключові слова для фільтрації заголовків
const KEYWORDS = [
  'junior', 'intern', 'trainee', 'stażysta', 'praktykant', 'młodszy',
  'node.js', 'nodejs', 'javascript', 'typescript', 'react', 'fullstack',
  'full-stack', 'backend', 'qa', 'tester', 'it support', 'helpdesk',
  'technical support', 'project coordinator',
];

export class PracujPlParser extends BaseParser {
  readonly source: JobSource = 'PRACUJPL';

  async parse(): Promise<RawVacancy[]> {
    logger.info('[PracujPL] Запускаю через Playwright (обхід Cloudflare)...');
    const vacancies: RawVacancy[] = [];

    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });

      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'pl-PL',
        extraHTTPHeaders: {
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8',
        },
      });

      for (const url of SEARCH_URLS) {
        try {
          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          // Чекаємо поки завантажаться картки
          await page.waitForTimeout(2500);

          const html = await page.content();
          const results = this.parseHtml(html);
          vacancies.push(...results);
          await page.close();
          await this.sleep(1500);
        } catch (err) {
          logger.warn(`[PracujPL] ${url}: ${(err as Error).message}`);
        }
      }

      await context.close();
    } catch (err) {
      logger.error(`[PracujPL] Playwright error: ${(err as Error).message}`);
    } finally {
      await browser?.close();
    }

    const deduped = this.deduplicateByUrl(vacancies);
    logger.info(`[PracujPL] Знайдено ${deduped.length} вакансій`);
    return deduped;
  }

  private parseHtml(html: string): RawVacancy[] {
    const $ = cheerio.load(html);
    const vacancies: RawVacancy[] = [];

    // Спочатку JSON-LD (найнадійніший спосіб)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() ?? '');
        const items: object[] = data['@graph'] ?? (Array.isArray(data) ? data : [data]);

        for (const item of items as Record<string, unknown>[]) {
          if (item['@type'] !== 'JobPosting') continue;
          const title = String(item['title'] ?? '');
          const url = String(item['url'] ?? '');
          if (!title || !url) continue;
          if (!this.isRelevantVacancy(title)) continue;

          const jobLocation = item['jobLocation'] as Record<string, unknown> | undefined;
          const locationArr = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];
          const city = String(
            (locationArr[0] as Record<string, Record<string, string>> | undefined)?.address?.addressLocality ?? '',
          );
          const baseSalary = item['baseSalary'] as Record<string, unknown> | undefined;
          const salValue = (baseSalary?.value ?? {}) as { minValue?: number; maxValue?: number };
          const salCurrency = typeof baseSalary?.currency === 'string' ? baseSalary.currency : 'PLN';

          vacancies.push({
            title,
            company: String((item['hiringOrganization'] as Record<string, string> | undefined)?.name ?? ''),
            city,
            location: city || 'Poland',
            country: 'Poland',
            isRemote: item['jobLocationType'] === 'TELECOMMUTE',
            salaryMin: salValue.minValue,
            salaryMax: salValue.maxValue,
            currency: salCurrency,
            description: String(item['description'] ?? '').slice(0, 1000),
            url: url.startsWith('http') ? url : `${BASE}${url}`,
            source: this.source,
            category: this.detectCategory(title),
            experienceLevel: this.detectExperienceLevel(title),
            postedAt: item['datePosted'] ? new Date(String(item['datePosted'])) : undefined,
          });
        }
      } catch {
        /* skip */
      }
    });

    if (vacancies.length > 0) return vacancies;

    // HTML fallback — нові селектори pracuj.pl
    const cardSelectors = [
      '[data-test="default-offer"]',
      '[class*="jobOffer"]',
      '[class*="tiles_c"]',
      'li[data-test-offerid]',
    ];

    for (const selector of cardSelectors) {
      $(selector).each((_, el) => {
        try {
          const $el = $(el);
          const title =
            $el.find('[data-test="offer-title"], h2, h3').first().text().trim();
          const company =
            $el.find('[data-test="text-company-name"], [class*="company"]').first().text().trim();
          const location =
            $el.find('[data-test="text-region"], [class*="location"]').first().text().trim();
          const href =
            $el.find('a[href*="/praca/"]').first().attr('href') ??
            $el.closest('a').attr('href') ?? '';

          if (!title || !href) return;
          if (!this.isRelevantVacancy(title)) return;

          const fullUrl = href.startsWith('http') ? href : `${BASE}${href}`;
          vacancies.push({
            title,
            company: company || 'Unknown',
            location,
            city: this.normalizeCity(location),
            country: 'Poland',
            isRemote: location.toLowerCase().includes('zdaln') || location.toLowerCase().includes('remote'),
            url: fullUrl,
            source: this.source,
            category: this.detectCategory(title),
            experienceLevel: this.detectExperienceLevel(title),
          });
        } catch {
          /* skip */
        }
      });

      if (vacancies.length > 0) break; // якщо перший селектор спрацював
    }

    return vacancies;
  }

  /**
   * Перевірка релевантності: заголовок має містити одне з ключових слів
   */
  private isRelevantVacancy(title: string): boolean {
    const lower = title.toLowerCase();
    return KEYWORDS.some((kw) => lower.includes(kw));
  }

  private deduplicateByUrl(vacancies: RawVacancy[]): RawVacancy[] {
    const seen = new Set<string>();
    return vacancies.filter((v) => {
      if (seen.has(v.url)) return false;
      seen.add(v.url);
      return true;
    });
  }
}
