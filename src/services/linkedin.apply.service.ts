import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../infrastructure/logger';

const BASE = 'https://www.linkedin.com';
const PROFILE_DIR = path.resolve(process.cwd(), 'browser-profile');

export interface LinkedInApplyProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin?: string | null;
  github?: string | null;
  position: string;
  experienceMonths: number;
  skills: string;
  coverLetter: string;
  location?: string;
  cvLocalPath?: string;
}

export interface LinkedInApplyResult {
  url: string;
  title: string;
  company: string;
  success: boolean;
  method: string;
  message: string;
}

export class LinkedInApplyService {
  // ── Перевірка логіну (через cookies.json — без запуску браузера) ───────────
  async checkLogin(): Promise<{ loggedIn: boolean; name?: string }> {
    try {
      const cookiesPath = path.resolve(process.cwd(), 'browser-profile', 'cookies.json');
      if (!fs.existsSync(cookiesPath)) {
        return { loggedIn: false };
      }

      const raw = fs.readFileSync(cookiesPath, 'utf-8');
      const cookies: Array<{ name: string; domain: string; expires?: number; value: string }> = JSON.parse(raw);

      const now = Date.now() / 1000;

      // li_at — головний auth-токен LinkedIn
      const liAt = cookies.find(
        c => c.name === 'li_at' && c.domain.includes('linkedin.com'),
      );

      if (!liAt || !liAt.value) {
        return { loggedIn: false };
      }

      // Перевіряємо термін дії
      if (liAt.expires && liAt.expires < now) {
        logger.warn('[LinkedIn] li_at cookie expired');
        return { loggedIn: false };
      }

      // JSESSIONID — наявність підтверджує активну сесію
      const session = cookies.find(
        c => c.name === 'JSESSIONID' && c.domain.includes('linkedin.com'),
      );

      logger.info('[LinkedIn] ✅ li_at знайдено — залогінений');
      return { loggedIn: true, name: session ? 'LinkedIn User' : 'LinkedIn User' };

    } catch (err) {
      logger.warn(`[LinkedIn] checkLogin error: ${(err as Error).message}`);
      return { loggedIn: false };
    }
  }

  // ── Пошук і подача Easy Apply вакансій ────────────────────────────────────
  async searchAndApply(
    keywords: string,
    location: string = 'Poland',
    maxJobs: number = 10,
    profile: LinkedInApplyProfile,
    onProgress: (msg: string) => Promise<void>,
  ): Promise<LinkedInApplyResult[]> {
    const results: LinkedInApplyResult[] = [];
    let ctx: BrowserContext | null = null;

    try {
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        slowMo: 200,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: null,
      });

      await ctx.addInitScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      `);

      const page = await ctx.newPage();

      // Перевіряємо логін напряму через cookies.json (без навігації)
      const { loggedIn } = await this.checkLogin();
      if (!loggedIn) {
        await page.close();
        await ctx.close();
        throw new Error('NOT_LOGGED_IN');
      }

      logger.info('[LinkedIn] ✅ Залогінений, починаю пошук...');
      await onProgress(`🔍 Шукаю Easy Apply вакансії: "${keywords}" в ${location}...`);

      // Одразу на сторінку пошуку — persistent context вже має cookies
      const searchUrl = `${BASE}/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&f_E=1,2&f_EA=true&sortBy=DD`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Скролимо для завантаження
      for (let i = 0; i < 2; i++) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await page.waitForTimeout(1500);
      }

      // Збираємо картки
      const jobCards = page.locator('.jobs-search__results-list li, .scaffold-layout__list li');
      const totalCards = await jobCards.count();
      const toProcess = Math.min(totalCards, maxJobs);

      logger.info(`[LinkedIn] Знайдено ${totalCards} карток, обробляю ${toProcess}`);
      await onProgress(`📋 Знайдено ${totalCards} вакансій, подаю на ${toProcess}...`);

      for (let i = 0; i < toProcess; i++) {
        try {
          const card = jobCards.nth(i);

          const title = ((await card.locator('h3, .base-search-card__title, .job-card-list__title')
            .first().textContent().catch(() => '')) ?? '').trim();
          const company = ((await card.locator('h4, .base-search-card__subtitle, .job-card-container__company-name')
            .first().textContent().catch(() => '')) ?? '').trim();
          const link = await card.locator('a.base-card__full-link, a[href*="/jobs/view/"]')
            .first().getAttribute('href').catch(() => null);

          if (!title || !link) continue;
          const fullUrl = link.startsWith('http') ? link : `${BASE}${link}`;

          logger.info(`[LinkedIn] ${i + 1}/${toProcess}: ${title} @ ${company}`);
          await onProgress(`⏳ ${i + 1}/${toProcess}: ${title} @ ${company}`);

          // Клікаємо на картку щоб відкрити деталі
          await card.click().catch(() => undefined);
          await page.waitForTimeout(2000);

          // Шукаємо Easy Apply кнопку в деталях
          const result = await this.applyToJob(page, fullUrl, title, company, profile);
          results.push(result);

          await onProgress(
            `${result.success ? '✅' : '❌'} ${title} @ ${company}: ${result.method}`
          );

          // Пауза між відгуками
          await this.sleep(3000 + Math.random() * 2000);

        } catch (err) {
          logger.warn(`[LinkedIn] Картка ${i}: ${(err as Error).message}`);
        }
      }

      await page.close();
      await ctx.close();

    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'NOT_LOGGED_IN') throw err;
      logger.error(`[LinkedIn] searchAndApply error: ${msg}`);
      await ctx?.close().catch(() => undefined);
    }

    return results;
  }

  // ── Подача на одну вакансію ────────────────────────────────────────────────
  private async applyToJob(
    page: Page,
    url: string,
    title: string,
    company: string,
    profile: LinkedInApplyProfile,
  ): Promise<LinkedInApplyResult> {
    const base = { url, title, company };

    try {
      // Шукаємо Easy Apply кнопку (вона може бути в sidebar або в header)
      const easyApplyBtn = page.locator([
        'button.jobs-apply-button',
        'button[aria-label*="Easy Apply" i]',
        'button:has-text("Easy Apply")',
        'button:has-text("Łatwe aplikowanie")',
        'button:has-text("Aplikuj szybko")',
      ].join(', ')).first();

      const hasEasyApply = await easyApplyBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (!hasEasyApply) {
        logger.info(`[LinkedIn] "${title}": нема Easy Apply, пропускаю`);
        return { ...base, success: false, method: 'skip', message: 'Нема Easy Apply' };
      }

      logger.info(`[LinkedIn] "${title}": клікаю Easy Apply`);
      await easyApplyBtn.click();
      await page.waitForTimeout(3000);

      // Проходимо кроки Easy Apply
      return await this.walkEasyApplySteps(page, profile, base);

    } catch (err) {
      return { ...base, success: false, method: 'error', message: (err as Error).message.slice(0, 100) };
    }
  }

  // ── Кроки Easy Apply модалу ────────────────────────────────────────────────
  private async walkEasyApplySteps(
    page: Page,
    profile: LinkedInApplyProfile,
    base: { url: string; title: string; company: string },
  ): Promise<LinkedInApplyResult> {
    for (let step = 1; step <= 15; step++) {
      logger.info(`[LinkedIn] Easy Apply step ${step}`);

      // Заповнюємо поточний крок
      await this.fillEasyApplyStep(page, profile);
      await page.waitForTimeout(600);

      // Submit
      const submitBtn = page.locator([
        'button[aria-label*="Submit application" i]',
        'button:has-text("Submit application")',
        'button:has-text("Wyślij aplikację")',
        'button:has-text("Надіслати заявку")',
      ].join(', ')).first();

      if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const disabled = await submitBtn.isDisabled().catch(() => false);
        if (!disabled) {
          await submitBtn.click();
          await page.waitForTimeout(3000);
          logger.info(`[LinkedIn] ✅ "${base.title}": відгук відправлено`);
          return { ...base, success: true, method: 'LinkedIn Easy Apply', message: '✅ Відгук відправлено' };
        }
        return { ...base, success: false, method: 'LinkedIn Easy Apply', message: '⚠️ Submit заблоковано — є незаповнені поля' };
      }

      // Next / Review
      const nextBtn = page.locator([
        'button[aria-label*="Continue to next step" i]',
        'button[aria-label*="Review your application" i]',
        'button:has-text("Next")',
        'button:has-text("Review")',
        'button:has-text("Continue")',
        'button:has-text("Dalej")',
        'button:has-text("Przejrzyj")',
      ].join(', ')).first();

      if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const disabled = await nextBtn.isDisabled().catch(() => false);
        if (!disabled) {
          const label = await nextBtn.textContent().catch(() => 'Next');
          logger.info(`[LinkedIn] Клікаю "${label?.trim()}"`);
          await nextBtn.click();
          await page.waitForTimeout(2000);
          continue;
        }
        return { ...base, success: false, method: 'LinkedIn Easy Apply', message: '⚠️ Next заблоковано — заповни поля вручну' };
      }

      // Dismiss/Close — якщо нічого не знайдено
      logger.warn(`[LinkedIn] Step ${step}: нема Next/Submit`);
      break;
    }

    return { ...base, success: false, method: 'LinkedIn Easy Apply', message: '📋 Форму відкрито — заповни вручну' };
  }

  // ── Заповнення полів одного кроку Easy Apply ───────────────────────────────
  private async fillEasyApplyStep(page: Page, profile: LinkedInApplyProfile): Promise<void> {
    // First / Last name (LinkedIn іноді питає)
    await this.fill(page, 'input[id*="firstName" i], input[name*="firstName" i]', profile.firstName);
    await this.fill(page, 'input[id*="lastName" i], input[name*="lastName" i]', profile.lastName);

    // Email
    await this.fill(page, 'input[id*="email" i], input[type="email"]', profile.email);

    // Phone
    await this.fill(page, 'input[id*="phoneNumber" i], input[name*="phone" i]', profile.phone);

    // City / location
    const city = profile.location || 'Warsaw';
    await this.fill(page, 'input[id*="city" i], input[name*="city" i]', city);

    // Cover letter textarea
    const textarea = page.locator('textarea').first();
    if (await textarea.isVisible({ timeout: 500 }).catch(() => false)) {
      const current = await textarea.inputValue().catch(() => '');
      if (!current) {
        await textarea.fill(profile.coverLetter);
        logger.info('[LinkedIn] Cover letter заповнено');
      }
    }

    // CV upload
    if (profile.cvLocalPath && fs.existsSync(profile.cvLocalPath)) {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.isVisible({ timeout: 500 }).catch(() => false)) {
        await fileInput.setInputFiles(profile.cvLocalPath);
        logger.info('[LinkedIn] CV завантажено');
      }
    }

    // Радіо-кнопки / select — вибираємо перший варіант
    const selects = page.locator('select');
    const selectCount = await selects.count();
    for (let i = 0; i < selectCount; i++) {
      try {
        const sel = selects.nth(i);
        if (!await sel.isVisible({ timeout: 300 })) continue;
        const val = await sel.locator('option').nth(1).getAttribute('value').catch(() => null);
        if (val) await sel.selectOption(val);
      } catch { /* skip */ }
    }

    // Yes/No радіо — обираємо "Yes" де є
    const radioYes = page.locator('input[type="radio"][value*="yes" i], input[type="radio"][value*="true" i]');
    const radioCount = await radioYes.count();
    for (let i = 0; i < radioCount; i++) {
      try {
        const r = radioYes.nth(i);
        if (await r.isVisible({ timeout: 300 })) await r.check();
      } catch { /* skip */ }
    }

    // Числові поля (досвід роботи)
    const numberInputs = page.locator('input[type="number"], input[id*="experience" i], input[id*="years" i]');
    const numCount = await numberInputs.count();
    for (let i = 0; i < numCount; i++) {
      try {
        const inp = numberInputs.nth(i);
        if (!await inp.isVisible({ timeout: 300 })) continue;
        const current = await inp.inputValue().catch(() => '');
        if (!current) {
          const yearsExp = Math.floor(profile.experienceMonths / 12);
          await inp.fill(String(yearsExp || 1));
        }
      } catch { /* skip */ }
    }
  }

  private async fill(page: Page, selector: string, value: string): Promise<void> {
    if (!value) return;
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 500 })) {
        const current = await el.inputValue().catch(() => '');
        if (!current) await el.fill(value);
      }
    } catch { /* silent */ }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const linkedInApplyService = new LinkedInApplyService();
