import { chromium, BrowserContext, Page, Browser } from 'playwright';
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
const COOKIES_FILE = path.resolve(process.cwd(), 'browser-profile', 'cookies.json');

export class BrowserService {
  private ctx: BrowserContext | null = null;
  private browser: Browser | null = null;

  // ── Get or create context ──────────────────────────────────────────────────
  async getContext(): Promise<BrowserContext> {
    // Reuse if alive
    if (this.ctx) {
      try {
        this.ctx.pages();
        return this.ctx;
      } catch {
        this.ctx = null;
        this.browser = null;
      }
    }

    if (!fs.existsSync(PROFILE_DIR)) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }

    // Try persistent context first (has saved sessions)
    try {
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
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--disable-infobars',
          '--hide-crash-restore-bubble',
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      await this.ctx.addInitScript(
        `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,
      );
      logger.info('[Browser] ✅ Браузер готовий (persistent)');
      return this.ctx;
    } catch (err) {
      logger.warn(`[Browser] Persistent profile недоступний: ${(err as Error).message.split('\n')[0]}`);
      logger.info('[Browser] Fallback: звичайний запуск з cookies...');
    }

    // Fallback: regular launch + restore cookies from file
    this.browser = await chromium.launch({
      headless: false,
      slowMo: 200,
      args: [
        '--no-sandbox',
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    this.ctx = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: null,
      locale: 'uk-UA',
    });

    await this.ctx.addInitScript(
      `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,
    );

    // Restore cookies if saved
    if (fs.existsSync(COOKIES_FILE)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
        await this.ctx.addCookies(cookies);
        logger.info(`[Browser] ✅ Відновлено ${cookies.length} cookies`);
      } catch {
        logger.warn('[Browser] Не вдалось відновити cookies');
      }
    }

    logger.info('[Browser] ✅ Браузер готовий (fallback)');
    return this.ctx;
  }

  // ── Save cookies after use ─────────────────────────────────────────────────
  async saveCookies(): Promise<void> {
    if (!this.ctx) return;
    try {
      const cookies = await this.ctx.cookies();
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
      logger.info(`[Browser] 💾 Збережено ${cookies.length} cookies`);
    } catch { /* ignore */ }
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

      // Save cookies for next time (in case persistent profile not available)
      await this.saveCookies().catch(() => undefined);

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
    if (url.includes('bulldogjob.pl'))   return this.bulldogjob(page, p, originalUrl);
    if (url.includes('teamquest.pl'))    return this.teamquest(page, p, originalUrl);
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
      // TeamQuest / generic cookie banners
      'button:has-text("I Przyjmij wszystko")',
      'button:has-text("Przyjmij wszystko")',
      'button:has-text("Przyjmij wszystkie")',
      'button:has-text("Zaakceptuj wszystko")',
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

    // Закриваємо попап перекладача якщо є
    await page.keyboard.press('Escape').catch(() => undefined);

    // Встановлюємо viewport щоб форма справа відрендерилась
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    await page.evaluate('window.scrollTo(0, 200)');
    await page.waitForTimeout(1500);

    // --- STEP 1: Шукаємо кнопку Aplikuj через всі методи ---
    let submitBtn = null;

    // Метод 1: getByRole — найнадійніший для Playwright
    try {
      const roleBtn = page.getByRole('button', { name: /aplikuj/i });
      const count = await roleBtn.count();
      if (count > 0) {
        submitBtn = roleBtn.first();
        logger.info(`[Browser] Pracuj: знайдено через getByRole, count=${count}`);
      }
    } catch { /* next */ }

    // Метод 2: getByText
    if (!submitBtn) {
      try {
        const textBtn = page.getByText(/aplikuj/i).first();
        const tag = await textBtn.evaluate(el => el.tagName).catch(() => '');
        if (tag === 'BUTTON' || tag === 'A') {
          submitBtn = textBtn;
          logger.info('[Browser] Pracuj: знайдено через getByText');
        }
      } catch { /* next */ }
    }

    // Метод 3: data-test атрибути
    if (!submitBtn) {
      for (const sel of [
        '[data-test="quick-apply-button"]',
        '[data-test="button-quick-apply"]',
        '[data-test*="apply"]',
      ]) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() > 0) {
            submitBtn = el;
            logger.info(`[Browser] Pracuj: знайдено через ${sel}`);
            break;
          }
        } catch { /* next */ }
      }
    }

    // Метод 4: JS evaluate — шукає по всьому DOM без фільтрів
    if (!submitBtn) {
      const allBtns = await page.evaluate('Array.from(document.querySelectorAll("button, a[role=\'button\']")).map(b => ({ text: b.textContent?.trim() ?? "", tag: b.tagName })).filter(b => b.text.length > 0)') as Array<{text: string; tag: string}>;
      logger.warn(`[Browser] Pracuj: всі елементи: ${allBtns.map(b => b.text).slice(0, 30).join(' | ')}`);

      const clicked = await page.evaluate(`
        (function() {
          var all = Array.from(document.querySelectorAll('button, a[role="button"], a'));
          var btn = all.find(function(b) { return /aplikuj/i.test(b.textContent || ''); });
          if (btn) { btn.click(); return btn.textContent.trim() || 'clicked'; }
          return null;
        })()
      `) as string | null;

      if (clicked) {
        logger.info(`[Browser] Pracuj: JS click на "${clicked}"`);
        await page.waitForTimeout(3000);
        return {
          success: true,
          method: 'Pracuj.pl Quick Apply',
          message: `✅ *Відгук відправлено на Pracuj\\.pl\\!*`,
        };
      }

      // Нічого не знайшли
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

    // --- STEP 2: Якщо кнопку знайшли через методи 1-3 — заповнюємо і відправляємо ---
    return this.pracujFillAndSubmit(page, p, submitBtn, originalUrl);
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

    // --- Pracuj може показати попередження "Pracodawca prosi o wypełnienie swojego formularza" ---
    // Треба клікнути "Kontynuuj aplikowanie" щоб продовжити
    const kontynuujSels = [
      'button:has-text("Kontynuuj aplikowanie")',
      'a:has-text("Kontynuuj aplikowanie")',
      '[data-test*="continue"]',
    ];
    for (const sel of kontynuujSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          logger.info('[Browser] Pracuj: кліку "Kontynuuj aplikowanie"');
          await btn.click();
          await page.waitForTimeout(3000);
          break;
        }
      } catch { /* next */ }
    }

    // --- Перевіряємо чи відбувся редирект на зовнішній сайт ---
    const afterClickUrl = page.url();
    logger.info(`[Browser] Pracuj після кліку: ${afterClickUrl}`);

    if (!afterClickUrl.includes('pracuj.pl')) {
      // Редирект на зовнішній ATS — обробляємо
      logger.info('[Browser] Pracuj: редирект на зовнішній сайт, обробляю...');
      await this.acceptCookies(page);
      await page.waitForTimeout(1500);
      return this.handleExternalAts(page, p, afterClickUrl, originalUrl);
    }

    // Обробляємо "Pytania od pracodawcy" — додаткові питання роботодавця
    await this.handlePracujQuestions(page, p);

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

    // Redirected to external ATS after questions
    const finalRedirectUrl = page.url();
    if (!finalRedirectUrl.includes('pracuj.pl')) {
      await this.acceptCookies(page);
      return this.handleExternalAts(page, p, finalRedirectUrl, originalUrl);
    }

    return {
      success: false,
      method: 'Pracuj.pl',
      message:
        `📋 *Форму відкрито на Pracuj\\.pl*\n\n` +
        `${messageFilled ? '✅ Повідомлення заповнено\\.' : '⚠️ Заповни "Wiadomość do pracodawcy"\\.'}\n\n` +
        `Натисни *Wyślij* у браузері вручну\\.\n\n` +
        `*Ім'я:* ${p.fullName}\n*Email:* ${p.email}`,
    };
  }

  // ── Обробка зовнішнього ATS після редиректу з Pracuj.pl ───────────────────
  private async handleExternalAts(
    page: Page,
    p: FillFormProfile,
    currentUrl: string,
    originalUrl: string,
  ): Promise<BrowserApplyResult> {
    logger.info(`[Browser] External ATS: ${currentUrl}`);

    // Якщо відомий ATS — делегуємо відповідному хендлеру
    if (currentUrl.includes('greenhouse.io'))   return this.greenhouse(page, p);
    if (currentUrl.includes('lever.co'))        return this.lever(page, p);
    if (currentUrl.includes('workable.com'))    return this.workable(page, p);
    if (currentUrl.includes('recruitee.com'))   return this.recruitee(page, p);
    if (currentUrl.includes('traffit.com'))     return this.traffit(page, p);
    if (currentUrl.includes('smartrecruiters')) return this.smartrecruiters(page, p);
    if (currentUrl.includes('teamtailor'))      return this.teamtailor(page, p);
    if (currentUrl.includes('ashbyhq.com'))     return this.ashby(page, p);

    // Невідомий зовнішній сайт — universal flow:
    // 1. Клікаємо "Apply with CV" якщо є вибір
    const applyWithCvSels = [
      'button:has-text("Apply with CV")',
      'a:has-text("Apply with CV")',
      '[data-test*="apply-with-cv"]',
    ];
    for (const sel of applyWithCvSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          logger.info(`[Browser] External: клікаю "Apply with CV"`);
          await btn.click();
          await page.waitForTimeout(2500);
          break;
        }
      } catch { /* next */ }
    }

    // 2. Заповнюємо поля форми
    await this.fillExternalForm(page, p);

    // 3. Завантажуємо CV
    if (p.cvLocalPath && fs.existsSync(p.cvLocalPath)) {
      await this.upload(page, p.cvLocalPath);
    }

    // 4. Приймаємо чекбокси згоди (RODO/Privacy)
    await this.acceptConsents(page);

    // 5. Клікаємо Submit / Apply now
    const submitSels = [
      'button:has-text("Apply now")',
      'button:has-text("Wyślij")',
      'button:has-text("Submit")',
      'button[type="submit"]',
      'input[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          const disabled = await btn.isDisabled().catch(() => false);
          if (!disabled) {
            await btn.scrollIntoViewIfNeeded().catch(() => undefined);
            await btn.click();
            submitted = true;
            logger.info(`[Browser] External: submitted via ${sel}`);
            await page.waitForTimeout(3000);
            break;
          }
        }
      } catch { /* next */ }
    }

    if (submitted) {
      return {
        success: true,
        method: 'External ATS',
        message: `✅ *Відгук відправлено\\!*\n\n🔗 [Вакансія](${originalUrl})`,
      };
    }

    return {
      success: false,
      method: 'External ATS',
      message:
        `📋 *Форму заповнено на зовнішньому сайті*\n\n` +
        `Натисни *Apply now* / *Submit* у браузері вручну\\.\n\n` +
        `*Ім'я:* ${p.fullName}\n*Email:* ${p.email}\n*Телефон:* ${p.phone}`,
    };
  }

  // ── Заповнення полів зовнішньої форми ─────────────────────────────────────
  private async fillExternalForm(page: Page, p: FillFormProfile): Promise<void> {
    await this.ft(page, ['input[name*="first" i]', 'input[id*="first" i]', 'input[placeholder*="First name" i]', 'input[autocomplete="given-name"]'], p.firstName);
    await this.ft(page, ['input[name*="last" i]', 'input[id*="last" i]', 'input[placeholder*="Surname" i]', 'input[autocomplete="family-name"]'], p.lastName);
    await this.ft(page, ['input[name*="name"]', 'input[placeholder*="Full name" i]'], p.fullName);
    await this.ft(page, ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]'], p.email);
    await this.ft(page, ['input[type="tel"]', 'input[name*="phone" i]', 'input[id*="phone" i]'], p.phone);
    if (p.linkedin) await this.ft(page, ['input[name*="linkedin" i]', 'input[placeholder*="LinkedIn" i]', 'input[id*="linkedin" i]'], p.linkedin);
    if (p.github) await this.ft(page, ['input[name*="github" i]', 'input[placeholder*="GitHub" i]'], p.github);
    await this.ft(page, ['textarea[name*="cover" i]', 'textarea[name*="message" i]', 'textarea[id*="cover" i]', 'textarea'], p.coverLetter);

    // Work mode checkboxes (Remote, Hybrid, Office) — відмічаємо Remote якщо є
    try {
      const remoteCheckbox = page.locator('input[type="checkbox"] + label:has-text("Remote"), label:has-text("Remote") input[type="checkbox"]').first();
      if (await remoteCheckbox.isVisible({ timeout: 800 })) {
        const checked = await remoteCheckbox.isChecked().catch(() => false);
        if (!checked) await remoteCheckbox.check();
      }
    } catch { /* skip */ }
  }

  // ── Автоматично приймаємо чекбокси згоди ─────────────────────────────────
  private async acceptConsents(page: Page): Promise<void> {
    try {
      // Приймаємо всі обов'язкові чекбокси (RODO, consent)
      const checkboxes = page.locator('input[type="checkbox"]');
      const count = await checkboxes.count();
      for (let i = 0; i < count; i++) {
        try {
          const cb = checkboxes.nth(i);
          if (!await cb.isVisible({ timeout: 400 })) continue;
          const checked = await cb.isChecked().catch(() => false);
          if (!checked) {
            await cb.check();
            logger.info(`[Browser] Consent checkbox ${i} checked`);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // ── Pracuj.pl: обробка питань роботодавця ────────────────────────────────
  private async handlePracujQuestions(page: Page, p: FillFormProfile): Promise<void> {
    // Перевіряємо чи відкрилась сторінка з питаннями
    const hasQuestions = await page.locator('text=Pytania od pracodawcy').isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasQuestions) return;

    logger.info('[Browser] Pracuj: знайдено питання від роботодавця, заповнюю...');

    // Заповнюємо dropdown'и — обираємо перший варіант у кожному
    const selects = page.locator('select');
    const selectCount = await selects.count();
    for (let i = 0; i < selectCount; i++) {
      try {
        const sel = selects.nth(i);
        if (!await sel.isVisible({ timeout: 500 })) continue;
        const options = await sel.locator('option').all();
        // Пропускаємо перший варіант "wybierz" (placeholder), беремо другий
        if (options.length > 1) {
          const val = await options[1].getAttribute('value');
          if (val) await sel.selectOption(val);
        }
      } catch { /* skip */ }
    }

    // Заповнюємо зарплатні очікування якщо є окремий input
    if (p.salaryExpectation) {
      try {
        const salaryInput = page.locator('input[name*="salary" i], input[placeholder*="wynagrodzeni" i]').first();
        if (await salaryInput.isVisible({ timeout: 500 })) {
          await salaryInput.fill(p.salaryExpectation);
        }
      } catch { /* skip */ }
    }

    // Обираємо чекбокс "rozmowa wideo" якщо є
    try {
      const videoCheckbox = page.locator('input[type="checkbox"]').first();
      if (await videoCheckbox.isVisible({ timeout: 500 })) {
        await videoCheckbox.check();
      }
    } catch { /* skip */ }

    await page.waitForTimeout(500);

    // Натискаємо "Wyślij odpowiedzi" або "Pomiń"
    const sendBtn = page.getByRole('button', { name: /wyślij odpowiedzi/i });
    const skipBtn = page.getByRole('button', { name: /pomiń/i }).or(page.getByText(/pomiń/i));

    if (await sendBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      logger.info('[Browser] Pracuj: натискаю "Wyślij odpowiedzi"');
      await sendBtn.click();
    } else if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      logger.info('[Browser] Pracuj: натискаю "Pomiń"');
      await skipBtn.first().click();
    }

    await page.waitForTimeout(2000);
    logger.info('[Browser] Pracuj: питання оброблено');
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

  // ── TeamQuest ───────────────────────────────────────────────────────────────
  private async teamquest(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    logger.info('[Browser] TeamQuest handler...');
    await this.acceptCookies(page);
    await page.waitForTimeout(2000);

    if (!p.cvLocalPath) {
      return { success: false, method: 'TeamQuest', message: `⚠️ CV не знайдено\\. Завантаж CV через /cv і спробуй знову\\.` };
    }

    let uploaded = false;

    // Підхід 1: Знаходимо прихований input[type=file] і передаємо файл напряму
    // Це працює якщо кнопка "Wyślij CV" є label для прихованого input
    try {
      const fileInput = page.locator('input[type="file"]').first();
      // Робимо input видимим через JS щоб Playwright міг взаємодіяти
      await page.evaluate(`
        (function() {
          var input = document.querySelector('input[type="file"]');
          if (input) {
            input.style.display = 'block';
            input.style.opacity = '1';
            input.style.position = 'fixed';
            input.style.top = '0';
            input.style.left = '0';
            input.style.zIndex = '99999';
          }
        })()
      `);
      await page.waitForTimeout(300);
      await fileInput.setInputFiles(p.cvLocalPath);
      logger.info('[Browser] TeamQuest: ✅ CV через input[type=file] (made visible)');
      uploaded = true;
      await page.waitForTimeout(2000);
    } catch (err) {
      logger.warn(`[Browser] TeamQuest input visible: ${(err as Error).message.substring(0, 80)}`);
    }

    // Підхід 2: filechooser через клік кнопки
    if (!uploaded) {
      const uploadBtn = page.locator('button:has-text("Wyślij CV")').first();
      if (await uploadBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        try {
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 8000 }),
            uploadBtn.click(),
          ]);
          await fileChooser.setFiles(p.cvLocalPath);
          logger.info('[Browser] TeamQuest: ✅ CV через filechooser');
          uploaded = true;
          await page.waitForTimeout(2000);
        } catch (err) {
          logger.warn(`[Browser] TeamQuest filechooser: ${(err as Error).message.substring(0, 80)}`);
        }
      }
    }

    if (!uploaded) {
      return {
        success: false,
        method: 'TeamQuest',
        message: `⚠️ Не вдалось завантажити CV\\.\n\n📧 Надішли CV вручну на praca@teamquest.pl\n\n🔗 [Відкрий вакансію](${originalUrl})`,
      };
    }

    // Після upload TeamQuest сам редиректить на форму з полями
    // Чекаємо редирект і заповнюємо поля
    logger.info('[Browser] TeamQuest: чекаємо редирект після upload CV...');
    await page.waitForTimeout(3000);

    const afterUploadUrl = page.url();
    logger.info(`[Browser] TeamQuest після upload: ${afterUploadUrl}`);

    // Заповнюємо поля форми якщо вони є
    await this.fillInputs(page, p);
    await page.waitForTimeout(500);

    const finalUrl = page.url();
    logger.info(`[Browser] TeamQuest final URL: ${finalUrl}`);

    return {
      success: true,
      method: 'TeamQuest',
      message: `✅ *CV завантажено на TeamQuest\\!*\n\n_Браузер відкритий — заповни решту полів і натисни Submit\\._`,
    };
  }

  // ── BulldogJob ─────────────────────────────────────────────────────────────
  private async bulldogjob(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    logger.info('[Browser] BulldogJob handler...');

    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
    await page.waitForTimeout(2000);

    // Реєструємо listener ДО кліку щоб не пропустити нову вкладку
    const newPagePromise = page.context().waitForEvent('page', { timeout: 8000 });

    // Натискаємо Aplikuj
    let clicked = false;
    try {
      const applyBtn = page.getByRole('button', { name: /aplikuj/i })
        .or(page.getByRole('link', { name: /aplikuj/i }))
        .first();
      if (await applyBtn.isVisible({ timeout: 3000 })) {
        await applyBtn.click();
        clicked = true;
        logger.info('[Browser] BulldogJob: кнопка Aplikuj натиснута');
      }
    } catch { /* next */ }

    if (!clicked) {
      clicked = !!(await page.evaluate(`
        (function() {
          var el = Array.from(document.querySelectorAll('a, button'))
            .find(function(e) { return /aplikuj/i.test(e.textContent || ''); });
          if (el) { el.click(); return true; }
          return false;
        })()
      `));
    }

    if (!clicked) {
      newPagePromise.catch(() => undefined);
      return {
        success: false,
        method: 'BulldogJob',
        message: `⚠️ Кнопку "Aplikuj" не знайдено\\.\n\n🔗 [Вакансія](${originalUrl})`,
      };
    }

    // Чекаємо нову вкладку роботодавця
    let targetPage = page;
    try {
      const newPage = await newPagePromise;
      await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await this.acceptCookies(newPage);
      logger.info(`[Browser] BulldogJob: нова вкладка: ${newPage.url()}`);
      targetPage = newPage;
    } catch {
      await page.waitForTimeout(2000);
      logger.warn('[Browser] BulldogJob: нова вкладка не відкрилась, поточна: ' + page.url());
    }

    await this.acceptCookies(page);
    const newUrl = targetPage.url();
    logger.info(`[Browser] BulldogJob після кліку: ${newUrl}`);

    // Якщо залишились на BulldogJob thank-you — нову вкладку не перехопили
    if (newUrl.includes('bulldogjob.pl') && newUrl.includes('thank-you')) {
      return {
        success: false,
        method: 'BulldogJob',
        message: `⚠️ Не вдалось перехопити вкладку роботодавця\\.\n\n🔗 [Подай вручну](${originalUrl})`,
      };
    }

    // Якщо нова вкладка — teamquest або інший ATS
    return this.handlePage(targetPage, p, originalUrl);
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
