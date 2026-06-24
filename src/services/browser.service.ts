import { chromium, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../infrastructure/logger';

export interface FillFormProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin?: string | null;
  github?: string | null;
  position: string;
  skills: string;
  languages: string;
  location: string;
  experienceMonths: number;
  salaryExpectation?: string | null;
  coverLetter: string;
  cvLocalPath?: string;
}

export interface BrowserApplyResult {
  success: boolean;
  method: string;
  message: string;
  screenshotBase64?: string;
}

const PROFILE_DIR = path.resolve(process.cwd(), 'browser-profile');

export class BrowserService {
  private ctx: BrowserContext | null = null;

  // ── Get or create persistent context ──────────────────────────────────────
  async getContext(): Promise<BrowserContext> {
    // Check if existing context is still alive
    if (this.ctx) {
      try {
        this.ctx.pages(); // sync check — throws if closed
        return this.ctx;
      } catch {
        this.ctx = null;
      }
    }

    if (!fs.existsSync(PROFILE_DIR)) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }

    logger.info('[Browser] Запускаю Chromium з persistent profile...');

    this.ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      slowMo: 300,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: null,
      locale: 'uk-UA',
      args: [
        '--no-sandbox',
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

    await this.ctx.addInitScript(
      `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,
    );

    logger.info('[Browser] ✅ Браузер готовий');
    return this.ctx;
  }

  // ── Main entry point ───────────────────────────────────────────────────────
  async applyOnExternalSite(
    jobUrl: string,
    profile: FillFormProfile,
  ): Promise<BrowserApplyResult> {
    logger.info(`[Browser] applyOnExternalSite: ${jobUrl}`);

    let page: Page | null = null;

    try {
      const ctx = await this.getContext();
      page = await ctx.newPage();

      // Use domcontentloaded — faster, avoids networkidle timeout on LinkedIn
      logger.info('[Browser] Завантажую сторінку...');
      await page.goto(jobUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // Wait extra for JS to render (LinkedIn is heavy SPA)
      await page.waitForTimeout(4000);
      logger.info(`[Browser] Сторінка: ${page.url()}`);

      const result = await this.handlePage(page, profile, jobUrl);

      const screenshot = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);

      logger.info(`[Browser] DONE: ${result.method} success=${result.success}`);
      return { ...result, screenshotBase64: screenshot?.toString('base64') };

    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`[Browser] FATAL: ${msg}`);

      // Context might be dead — reset it
      if (msg.includes('closed') || msg.includes('destroyed')) {
        this.ctx = null;
      }

      const screenshot = await page?.screenshot({ type: 'png' }).catch(() => null);

      return {
        success: false,
        method: 'Browser',
        message:
          `⚠️ Помилка браузера: ${msg.slice(0, 200)}\n\n` +
          `📋 Дані для ручного заповнення:\n` +
          `*Ім'я:* ${profile.fullName}\n` +
          `*Email:* ${profile.email}\n` +
          `*Телефон:* ${profile.phone}\n` +
          (profile.linkedin ? `*LinkedIn:* ${profile.linkedin}\n` : '') +
          `\n🔗 [Відкрити вакансію](${jobUrl})`,
        screenshotBase64: screenshot?.toString('base64'),
      };
    }
  }

  // ── Route by platform ──────────────────────────────────────────────────────
  private async handlePage(
    page: Page,
    p: FillFormProfile,
    originalUrl: string,
  ): Promise<BrowserApplyResult> {
    const url = page.url();

    // Accept cookie consent banner (Pracuj.pl and others)
    await this.acceptCookies(page);

    if (url.includes('pracuj.pl'))       return this.pracuj(page, p, originalUrl);
    if (url.includes('linkedin.com'))    return this.linkedin(page, p, originalUrl);
    if (url.includes('greenhouse.io'))   return this.greenhouse(page, p);
    if (url.includes('lever.co'))        return this.lever(page, p);
    if (url.includes('workable.com'))    return this.workable(page, p);
    if (url.includes('recruitee.com'))   return this.recruitee(page, p);
    if (url.includes('traffit.com'))     return this.traffit(page, p);
    if (url.includes('smartrecruiters')) return this.smartrecruiters(page, p);
    if (url.includes('teamtailor'))      return this.teamtailor(page, p);
    if (url.includes('ashbyhq.com'))     return this.ashby(page, p);

    return this.generic(page, p, originalUrl);
  }

  // ── Accept cookie consent (universal) ─────────────────────────────────────
  private async acceptCookies(page: Page): Promise<void> {
    const cookieSelectors = [
      // Pracuj.pl
      'button[data-test="button-accept-all-in-cookiebar"]',
      'button[data-test="button-submitCookie"]',
      // Generic Polish sites
      'button:has-text("Akceptuj wszystkie")',
      'button:has-text("Zaakceptuj")',
      'button:has-text("Akceptuję")',
      'button:has-text("Akceptuj")',
      // Generic English
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Accept cookies")',
      '#onetrust-accept-btn-handler',
      '.cookie-accept',
    ];

    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          logger.info(`[Browser] Cookie consent accepted: ${sel}`);
          await page.waitForTimeout(800);
          return;
        }
      } catch { /* next */ }
    }
  }

  // ── Pracuj.pl ──────────────────────────────────────────────────────────────
  private async pracuj(
    page: Page,
    p: FillFormProfile,
    originalUrl: string,
  ): Promise<BrowserApplyResult> {
    logger.info('[Browser] Pracuj.pl handler...');

    // Wait a bit more for the page JS to render the inline form
    await page.waitForTimeout(2000);

    // --- STEP 1: Check if inline quick-apply form is already visible on page ---
    // Pracuj.pl renders the form on the right side of the vacancy page when logged in.
    // The submit button inside this form is "Aplikuj szybko".
    const inlineFormSubmitSels = [
      'button[data-test="quick-apply-button"]',
      'button[data-test="button-quick-apply"]',
      // text-based — most reliable since data-test changes often
      'button:has-text("Aplikuj szybko")',
      'button:has-text("Aplikuj")',
    ];

    let submitBtn = null;
    for (const sel of inlineFormSubmitSels) {
      try {
        // Use first() in case multiple exist; pick the visible one
        const candidates = page.locator(sel);
        const count = await candidates.count();
        for (let i = 0; i < count; i++) {
          const el = candidates.nth(i);
          if (await el.isVisible({ timeout: 800 })) {
            submitBtn = el;
            logger.info(`[Browser] Pracuj inline form submit btn found: ${sel}[${i}]`);
            break;
          }
        }
        if (submitBtn) break;
      } catch { /* next */ }
    }

    // --- STEP 2: If inline form found — fill message and submit ---
    if (submitBtn) {
      return this.pracujFillAndSubmit(page, p, submitBtn, originalUrl);
    }

    // --- STEP 3: No inline form — maybe page not loaded or not logged in ---
    // Log all visible button texts for debugging
    const btns = await page.$$eval('button', (els) =>
      els.filter((e) => !!(e as { offsetParent?: unknown }).offsetParent)
        .map((e) => e.textContent?.trim() ?? '')
        .filter((t) => t.length > 0)
        .slice(0, 25),
    );
    logger.warn(`[Browser] Pracuj: inline form not found. Visible buttons: ${btns.join(' | ')}`);

    // Check if logged out
    const isLoggedOut = await page.locator('[data-test="link-login"]').isVisible({ timeout: 1000 }).catch(() => false);
    if (isLoggedOut) {
      return {
        success: false,
        method: 'Pracuj.pl',
        message:
          `🔐 *Залогінься на Pracuj\\.pl*\n\n` +
          `Браузер відкритий — увійди в акаунт\\.\n` +
          `Після логіну натисни "📨 Авто\\-відгук" ще раз\\.\n` +
          `Сесія збережеться автоматично\\.`,
      };
    }

    return {
      success: false,
      method: 'Pracuj.pl',
      message:
        `⚠️ Форму не знайдено на Pracuj\\.pl\\.\n\n` +
        `Браузер відкритий — натисни *"Aplikuj szybko"* вручну\\.\n\n` +
        `📋 Дані:\n*Ім'я:* ${p.fullName}\n*Email:* ${p.email}\n*Телефон:* ${p.phone}\n\n` +
        `🔗 [Відкрити вакансію](${originalUrl})`,
    };
  }

  // ── Pracuj.pl: fill message and submit inline form ─────────────────────────
  private async pracujFillAndSubmit(
    page: Page,
    p: FillFormProfile,
    submitBtn: ReturnType<Page['locator']>,
    originalUrl: string,
  ): Promise<BrowserApplyResult> {
    let messageFilled = false;

    // Try to enable "Załącz wiadomość" toggle first (if present)
    const attachToggleSels = [
      'button:has-text("Załącz wiadomość")',
      'label:has-text("Załącz wiadomość")',
      '[data-test*="attach-message"]',
      'span:has-text("Załącz wiadomość")',
    ];
    for (const sel of attachToggleSels) {
      try {
        const toggle = page.locator(sel).first();
        if (await toggle.isVisible({ timeout: 1000 })) {
          await toggle.click();
          await page.waitForTimeout(800);
          logger.info(`[Browser] Pracuj "Załącz wiadomość" toggle clicked`);
          break;
        }
      } catch { /* next */ }
    }

    // Fill message textarea (Wiadomość do pracodawcy)
    const messageSels = [
      'textarea[data-test*="message" i]',
      'textarea[name*="message" i]',
      'textarea[placeholder*="Wiadomość" i]',
      'textarea[placeholder*="wiadomosc" i]',
      'textarea[aria-label*="Wiadomość" i]',
      'textarea[data-test*="wiadomosc" i]',
      // fallback: any visible textarea on the page
      'textarea',
    ];

    for (const sel of messageSels) {
      try {
        const ta = page.locator(sel).first();
        if (await ta.isVisible({ timeout: 1500 })) {
          await ta.fill(p.coverLetter);
          messageFilled = true;
          logger.info(`[Browser] Pracuj message filled via: ${sel}`);
          break;
        }
      } catch { /* next */ }
    }

    // Click "Aplikuj szybko" submit button
    logger.info('[Browser] Pracuj: clicking submit button...');
    await submitBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await submitBtn.click();
    await page.waitForTimeout(3500);

    // Check for success confirmation
    const successSels = [
      '[data-test*="success"]',
      '[data-test="application-sent"]',
      'div:has-text("Aplikacja wysłana")',
      'div:has-text("Dziękujemy za aplikację")',
      'div:has-text("Twoja aplikacja została wysłana")',
      'p:has-text("wysłana")',
    ];
    for (const s of successSels) {
      if (await page.locator(s).isVisible({ timeout: 2000 }).catch(() => false)) {
        logger.info(`[Browser] Pracuj success confirmed: ${s}`);
        return {
          success: true,
          method: 'Pracuj.pl Quick Apply',
          message:
            `✅ *Відгук відправлено через Pracuj\\.pl\\!*\n\n` +
            `${messageFilled ? '📝 Повідомлення додано\\.' : ''}`,
        };
      }
    }

    // Check current URL — if still on pracuj.pl assume success
    const afterUrl = page.url();
    if (afterUrl.includes('pracuj.pl')) {
      logger.info('[Browser] Pracuj: submitted, still on pracuj.pl — assuming success');
      return {
        success: true,
        method: 'Pracuj.pl Quick Apply',
        message:
          `✅ *Форму відправлено на Pracuj\\.pl\\!*\n\n` +
          `${messageFilled ? '📝 Повідомлення роботодавцю додано\\.' : '⚠️ Повідомлення не додано \\(поле не знайдено\\)\\.'}`,
      };
    }

    // Redirected to external ATS
    await this.acceptCookies(page);
    return this.generic(page, p, originalUrl);
  }

  // ── LinkedIn ───────────────────────────────────────────────────────────────
  private async linkedin(
    page: Page,
    p: FillFormProfile,
    originalUrl: string,
  ): Promise<BrowserApplyResult> {

    // Check login: if page has job content it means we're logged in
    // The most reliable check is absence of sign-in modal/redirect
    const title = await page.title();
    const url = page.url();

    const isLoginPage =
      url.includes('/login') ||
      url.includes('/checkpoint') ||
      title.toLowerCase().includes('sign in') ||
      title.toLowerCase().includes('log in');

    // Also check for sign-in modal overlay
    const hasSignInModal = await page.locator('.contextual-sign-in-modal, .join-form').isVisible({ timeout: 1000 }).catch(() => false);

    logger.info(`[Browser] title="${title}" isLoginPage=${isLoginPage} hasModal=${hasSignInModal}`);

    if (isLoginPage || hasSignInModal) {
      return {
        success: false,
        method: 'LinkedIn',
        message:
          `🔐 *Залогінься в LinkedIn*\n\n` +
          `Браузер відкрито — увійди в акаунт\\.\n` +
          `Після логіну натисни "📨 Авто\\-відгук" ще раз\\.\n` +
          `Сесія збережеться автоматично\\.`,
      };
    }

    // Find the apply button — try ALL possible variants
    logger.info('[Browser] Шукаю кнопку Apply...');

    // Wait up to 5s for any apply button to appear
    const applySelector = [
      // by class (most reliable)
      'button.jobs-apply-button',
      '.jobs-s-apply button',
      // by text — Ukrainian, English, Polish, German
      'button:has-text("Подати заявку")',
      'button:has-text("Просте подання заявки")',
      'button:has-text("Просте подання")',
      'button:has-text("Easy Apply")',
      'button:has-text("Easy apply")',
      'button:has-text("Łatwe aplikowanie")',
      'button:has-text("Aplikuj szybko")',
      'button:has-text("Einfach bewerben")',
      // by aria-label
      'button[aria-label*="Easy Apply" i]',
      'button[aria-label*="подання" i]',
      'button[aria-label*="Apply" i]',
    ].join(', ');

    let applyBtn = null;
    try {
      await page.waitForSelector(applySelector, { timeout: 5000 });
      applyBtn = await page.$(applySelector);
    } catch {
      // Not found within 5s
    }

    if (!applyBtn) {
      // Log what buttons are on the page
      const btns = await page.$$eval('button', (els) =>
        els
          .filter((el) => el.offsetParent !== null) // visible only
          .map((el) => `"${el.textContent?.trim()}" [${el.getAttribute('aria-label') ?? ''}]`)
          .slice(0, 15),
      );
      logger.warn(`[Browser] Apply не знайдено. Кнопки: ${btns.join(' | ')}`);

      return {
        success: false,
        method: 'LinkedIn',
        message:
          `⚠️ Кнопку "Подати заявку" не знайдено\\.\n\n` +
          `Можливо вакансія з зовнішнім посиланням або вже подано заявку\\.\n\n` +
          `Браузер відкритий — натисни кнопку вручну\\.\n\n` +
          `📋 Дані:\n*Ім'я:* ${p.fullName}\n*Email:* ${p.email}\n*Телефон:* ${p.phone}`,
      };
    }

    // Click via JS to bypass any overlays
    logger.info('[Browser] ✅ Apply знайдено — клікаю...');
    await page.evaluate((btn) => (btn as unknown as { click(): void }).click(), applyBtn);
    await page.waitForTimeout(3000);

    // Walk through Easy Apply steps
    return this.easyApplySteps(page, p);
  }

  // ── Walk Easy Apply modal ──────────────────────────────────────────────────
  private async easyApplySteps(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    for (let step = 1; step <= 10; step++) {
      logger.info(`[Browser] Easy Apply step ${step}`);

      // Fill visible input fields
      await this.fillInputs(page, p);
      await page.waitForTimeout(500);

      // Check for Submit button
      const submitSelector = [
        'button:has-text("Submit application")',
        'button:has-text("Wyślij aplikację")',
        'button:has-text("Надіслати заявку")',
        'button:has-text("Відправити заявку")',
        'button:has-text("Подати заявку")',
        'button[aria-label*="Submit application" i]',
      ].join(', ');

      const submitBtn = await page.$(submitSelector);
      if (submitBtn) {
        const disabled = await page.evaluate(
          (btn) => (btn as unknown as { disabled: boolean }).disabled,
          submitBtn,
        );
        if (!disabled) {
          logger.info('[Browser] ✅ Клікаю Submit!');
          await page.evaluate(
            (btn) => (btn as unknown as { click(): void }).click(),
            submitBtn,
          );
          await page.waitForTimeout(3000);
          return {
            success: true,
            method: 'LinkedIn Easy Apply',
            message: `✅ *Відгук успішно відправлено через LinkedIn Easy Apply\\!*`,
          };
        }
        // Submit disabled — required field missing
        return {
          success: false,
          method: 'LinkedIn Easy Apply',
          message:
            `⚠️ Submit заблокований — є обов'язкове поле\\.\n` +
            `Перевір браузер, заповни і натисни Submit вручну\\.`,
        };
      }

      // Check for Next / Review button
      const nextSelector = [
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Review")',
        'button:has-text("Далі")',
        'button:has-text("Далее")',
        'button:has-text("Dalej")',
        'button:has-text("Przejrzyj")',
        'button[aria-label*="Continue to next step" i]',
        'button[aria-label*="Review your application" i]',
      ].join(', ');

      const nextBtn = await page.$(nextSelector);
      if (nextBtn) {
        const disabled = await page.evaluate(
          (btn) => (btn as unknown as { disabled: boolean }).disabled,
          nextBtn,
        );
        if (!disabled) {
          const txt = await page.evaluate(
            (btn) => (btn as unknown as { textContent: string }).textContent?.trim(),
            nextBtn,
          );
          logger.info(`[Browser] Клікаю Next: "${txt}"`);
          await page.evaluate(
            (btn) => (btn as unknown as { click(): void }).click(),
            nextBtn,
          );
          await page.waitForTimeout(2000);
          continue;
        }
        return {
          success: false,
          method: 'LinkedIn Easy Apply',
          message:
            `⚠️ Кнопка "Next" заблокована — заповни обов'язкові поля\\.` +
            `\nБраузер відкритий — натисни Next і Submit вручну\\.`,
        };
      }

      // No submit, no next — stop
      logger.warn(`[Browser] Step ${step}: не знайдено ні Submit ні Next`);
      break;
    }

    return {
      success: false,
      method: 'LinkedIn Easy Apply',
      message:
        `📋 Форму відкрито і частково заповнено\\.\n\n` +
        `Перевір браузер і натисни Submit\\.\n\n` +
        `*Ім'я:* ${p.fullName}\n*Email:* ${p.email}\n*Телефон:* ${p.phone}`,
    };
  }

  // ── Fill inputs on current page ─────────────────────────────────────────────
  private async fillInputs(page: Page, p: FillFormProfile): Promise<void> {
    const fields: Array<{ selectors: string[]; value: string }> = [
      {
        selectors: [
          'input[name="firstName"]',
          'input[id*="firstName" i]',
          'input[aria-label*="First name" i]',
          'input[aria-label*="Ім\'я" i]',
          'input[placeholder*="First name" i]',
        ],
        value: p.firstName,
      },
      {
        selectors: [
          'input[name="lastName"]',
          'input[id*="lastName" i]',
          'input[aria-label*="Last name" i]',
          'input[aria-label*="Прізвище" i]',
          'input[placeholder*="Last name" i]',
        ],
        value: p.lastName,
      },
      {
        selectors: [
          'input[type="email"]',
          'input[name="email"]',
          'input[id*="email" i]',
          'input[aria-label*="Email" i]',
          'input[aria-label*="Електронна" i]',
        ],
        value: p.email,
      },
      {
        selectors: [
          'input[type="tel"]',
          'input[name*="phone" i]',
          'input[id*="phone" i]',
          'input[aria-label*="Phone" i]',
          'input[aria-label*="Телефон" i]',
        ],
        value: p.phone,
      },
      {
        selectors: [
          'textarea[id*="cover" i]',
          'textarea[name*="cover" i]',
          'textarea[aria-label*="cover" i]',
          'textarea[aria-label*="супровід" i]',
        ],
        value: p.coverLetter,
      },
    ];

    for (const field of fields) {
      for (const sel of field.selectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 400 })) {
            const current = await el.inputValue().catch(() => '');
            if (!current) {
              await el.fill(field.value);
              logger.info(`[Browser] Filled: ${sel}`);
            }
            break;
          }
        } catch { /* next */ }
      }
    }

    // Upload CV
    if (p.cvLocalPath && fs.existsSync(p.cvLocalPath)) {
      try {
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.isVisible({ timeout: 400 }).catch(() => false)) {
          await fileInput.setInputFiles(p.cvLocalPath);
          logger.info(`[Browser] CV uploaded: ${path.basename(p.cvLocalPath)}`);
        }
      } catch { /* ignore */ }
    }
  }

  // ── ATS Fillers ────────────────────────────────────────────────────────────
  private async greenhouse(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.f(page, '#first_name', p.firstName);
    await this.f(page, '#last_name', p.lastName);
    await this.f(page, '#email', p.email);
    await this.f(page, '#phone', p.phone);
    await this.f(page, 'input[id*="linkedin"]', p.linkedin ?? '');
    await this.f(page, 'textarea[name*="cover"]', p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'Greenhouse', message: '✅ Greenhouse заповнено\\! Натисни Submit\\.' };
  }

  private async lever(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.f(page, 'input[name="name"]', p.fullName);
    await this.f(page, 'input[name="email"]', p.email);
    await this.f(page, 'input[name="phone"]', p.phone);
    await this.f(page, 'input[name="urls[LinkedIn]"]', p.linkedin ?? '');
    await this.f(page, 'input[name="urls[GitHub]"]', p.github ?? '');
    await this.f(page, 'textarea[name="comments"]', p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'Lever', message: '✅ Lever заповнено\\!' };
  }

  private async workable(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.ft(page, ['input[name="firstname"]', 'input[name="first_name"]'], p.firstName);
    await this.ft(page, ['input[name="lastname"]', 'input[name="last_name"]'], p.lastName);
    await this.f(page, 'input[name="email"]', p.email);
    await this.f(page, 'input[name="phone"]', p.phone);
    await this.ft(page, ['textarea[name="summary"]', 'textarea[name="cover_letter"]'], p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'Workable', message: '✅ Workable заповнено\\!' };
  }

  private async recruitee(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.f(page, 'input[name="name"]', p.fullName);
    await this.f(page, 'input[name="email"]', p.email);
    await this.f(page, 'input[name="phone"]', p.phone);
    await this.ft(page, ['textarea[name="message"]', 'textarea[name="cover_letter"]'], p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'Recruitee', message: '✅ Recruitee заповнено\\!' };
  }

  private async traffit(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.ft(page, ['input[name*="first" i]', 'input[placeholder*="First" i]'], p.firstName);
    await this.ft(page, ['input[name*="last" i]', 'input[placeholder*="Last" i]'], p.lastName);
    await this.f(page, 'input[type="email"]', p.email);
    await this.f(page, 'input[type="tel"]', p.phone);
    await this.f(page, 'textarea', p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'Traffit', message: '✅ Traffit заповнено\\!' };
  }

  private async smartrecruiters(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.f(page, 'input[name="firstName"]', p.firstName);
    await this.f(page, 'input[name="lastName"]', p.lastName);
    await this.f(page, 'input[name="email"]', p.email);
    await this.f(page, 'input[name="phoneNumber"]', p.phone);
    await this.f(page, 'textarea[name="message"]', p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'SmartRecruiters', message: '✅ SmartRecruiters заповнено\\!' };
  }

  private async teamtailor(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.ft(page, ['input[name="user[name]"]', 'input[name="name"]'], p.fullName);
    await this.ft(page, ['input[name="user[email]"]', 'input[name="email"]'], p.email);
    await this.ft(page, ['input[name="user[phone]"]', 'input[name="phone"]'], p.phone);
    await this.ft(page, ['textarea[name*="pitch"]', 'textarea[name*="cover"]'], p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'TeamTailor', message: '✅ TeamTailor заповнено\\!' };
  }

  private async ashby(page: Page, p: FillFormProfile): Promise<BrowserApplyResult> {
    await this.f(page, 'input[name="name"]', p.fullName);
    await this.f(page, 'input[name="email"]', p.email);
    await this.f(page, 'input[name="phone"]', p.phone);
    await this.f(page, 'textarea', p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    return { success: true, method: 'Ashby', message: '✅ Ashby заповнено\\!' };
  }

  private async generic(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    let n = 0;
    n += await this.ft(page, ['input[name*="first_name" i]', 'input[placeholder*="First name" i]', 'input[autocomplete="given-name"]'], p.firstName);
    n += await this.ft(page, ['input[name*="last_name" i]', 'input[placeholder*="Last name" i]', 'input[autocomplete="family-name"]'], p.lastName);
    if (n === 0) n += await this.ft(page, ['input[name="name" i]', 'input[placeholder*="Full name" i]'], p.fullName);
    n += await this.ft(page, ['input[type="email"]', 'input[name="email" i]', 'input[autocomplete="email"]'], p.email);
    n += await this.ft(page, ['input[type="tel"]', 'input[name*="phone" i]', 'input[autocomplete="tel"]'], p.phone);
    if (p.linkedin) await this.ft(page, ['input[name*="linkedin" i]'], p.linkedin);
    if (p.github) await this.ft(page, ['input[name*="github" i]'], p.github);
    n += await this.ft(page, ['textarea[name*="cover" i]', 'textarea[name*="message" i]', 'textarea'], p.coverLetter);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath).catch(() => undefined);

    if (n >= 2) {
      return { success: true, method: 'Generic', message: `✅ Форму заповнено \\(${n} полів\\)\\! Натисни Submit\\.` };
    }
    return {
      success: false, method: 'Generic',
      message: `⚠️ Не знайшов поля форми\\.\n\n📋 *Ім'я:* ${p.fullName}\n*Email:* ${p.email}\n*Телефон:* ${p.phone}\n\n🔗 [Вакансія](${originalUrl})`,
    };
  }

  // ── Low-level helpers ──────────────────────────────────────────────────────
  private async f(page: Page, selector: string, value: string): Promise<void> {
    if (!value) return;
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 })) await el.fill(value);
    } catch { /* silent */ }
  }

  private async ft(page: Page, selectors: string[], value: string): Promise<number> {
    if (!value) return 0;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 800 })) { await el.fill(value); return 1; }
      } catch { /* next */ }
    }
    return 0;
  }

  private async upload(page: Page, filePath: string): Promise<void> {
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const el = page.locator('input[type="file"]').first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.setInputFiles(filePath);
        logger.info(`[Browser] CV: ${path.basename(filePath)}`);
      }
    } catch { /* silent */ }
  }
}

export const browserService = new BrowserService();
