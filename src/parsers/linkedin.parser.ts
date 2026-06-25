import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { RawVacancy, JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { logger } from '../infrastructure/logger';

const BASE = 'https://www.linkedin.com';
const PROFILE_DIR = path.resolve(process.cwd(), 'browser-profile');

// Пошукові запити для junior позицій в Польщі
const SEARCH_QUERIES = [
  'junior developer poland',
  'junior node.js poland',
  'junior react poland',
  'junior typescript poland',
  'junior backend poland',
  'junior fullstack poland',
  'qa junior poland',
  'it support junior poland',
  'helpdesk junior poland',
];

export class LinkedInParser extends BaseParser {
  readonly source: JobSource = 'LINKEDIN';
  private ctx: BrowserContext | null = null;

  async parse(): Promise<RawVacancy[]> {
    logger.info('[LinkedIn] Запуск парсера...');

    let browser;
    try {
      browser = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-setuid-sandbox',
        ],
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });

      // Перевіряємо логін
      const page = await browser.newPage();
      await page.goto(`${BASE}/feed/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const isLoggedIn = await page.locator('[data-test-id="nav-settings__open"]')
        .or(page.locator('.global-nav__me'))
        .or(page.locator('img.global-nav__me-photo'))
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (!isLoggedIn) {
        logger.warn('[LinkedIn] Не залогінений. Відкрий браузер вручну і залогінься на linkedin.com');
        await page.close();
        await browser.close();
        return [];
      }

      logger.info('[LinkedIn] ✅ Залогінений');
      await page.close();

      // Парсимо вакансії
      const allVacancies: RawVacancy[] = [];

      for (const query of SEARCH_QUERIES) {
        try {
          const results = await this.searchJobs(browser, query);
          allVacancies.push(...results);
          logger.info(`[LinkedIn] "${query}": ${results.length} вакансій`);
          await this.sleep(2000 + Math.random() * 1000);
        } catch (err) {
          logger.warn(`[LinkedIn] "${query}": ${(err as Error).message}`);
        }
      }

      await browser.close();

      const deduped = this.deduplicateByUrl(allVacancies);
      logger.info(`[LinkedIn] Всього знайдено: ${deduped.length} вакансій`);
      return deduped;

    } catch (err) {
      logger.error(`[LinkedIn] Помилка парсера: ${(err as Error).message}`);
      await browser?.close().catch(() => undefined);
      return [];
    }
  }

  private async searchJobs(browser: BrowserContext, query: string): Promise<RawVacancy[]> {
    const page = await browser.newPage();
    const vacancies: RawVacancy[] = [];

    try {
      // Пошук з фільтром Easy Apply + Entry Level + Poland
      const url = `${BASE}/jobs/search/?keywords=${encodeURIComponent(query)}&location=Poland&f_E=1,2&f_EA=true&sortBy=DD`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Скролимо щоб завантажити більше вакансій
      for (let i = 0; i < 3; i++) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await page.waitForTimeout(1500);
      }

      // Збираємо картки вакансій
      const jobCards = page.locator('.jobs-search__results-list li, .scaffold-layout__list li');
      const count = await jobCards.count();
      logger.info(`[LinkedIn] "${query}": знайдено ${count} карток`);

      for (let i = 0; i < Math.min(count, 25); i++) {
        try {
          const card = jobCards.nth(i);
          const mapped = await this.parseJobCard(card, page);
          if (mapped) vacancies.push(mapped);
        } catch { /* skip */ }
      }

    } finally {
      await page.close();
    }

    return vacancies;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseJobCard(card: any, page: Page): Promise<RawVacancy | null> {
    try {
      const title = (await card.locator(
        '.base-search-card__title, .job-card-list__title, h3'
      ).first().textContent().catch(() => '')).trim();

      const company = (await card.locator(
        '.base-search-card__subtitle, .job-card-container__company-name, h4'
      ).first().textContent().catch(() => '')).trim();

      const location = (await card.locator(
        '.job-search-card__location, .job-card-container__metadata-item'
      ).first().textContent().catch(() => '')).trim();

      const link = await card.locator('a.base-card__full-link, a[href*="/jobs/view/"]')
        .first()
        .getAttribute('href')
        .catch(() => null);

      if (!title || !link) return null;
      if (!this.isJuniorVacancy(title)) return null;

      const fullUrl = link.startsWith('http') ? link : `${BASE}${link}`;
      const isRemote = location.toLowerCase().includes('remote') ||
        location.toLowerCase().includes('zdaln');

      // Перевіряємо чи є Easy Apply
      const hasEasyApply = await card.locator(
        '.jobs-apply-button, [aria-label*="Easy Apply"], .job-card-container__apply-method'
      ).isVisible({ timeout: 300 }).catch(() => false);

      return {
        title,
        company: company || 'Unknown',
        location,
        city: this.normalizeCity(location),
        country: 'Poland',
        isRemote,
        url: fullUrl,
        source: this.source,
        category: this.detectCategory(title),
        experienceLevel: this.detectExperienceLevel(title),
        tags: hasEasyApply ? ['easy-apply'] : [],
      };
    } catch {
      return null;
    }
  }

  private deduplicateByUrl(v: RawVacancy[]): RawVacancy[] {
    const seen = new Set<string>();
    return v.filter(x => {
      // Нормалізуємо URL — прибираємо query params
      const clean = x.url.split('?')[0];
      if (seen.has(clean)) return false;
      seen.add(clean);
      return true;
    });
  }
}
