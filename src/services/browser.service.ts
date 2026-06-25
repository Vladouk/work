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

      // If success on main page — close any new tabs that opened (external ATS popups)
      if (result.success) {
        const ctx2 = await this.getContext();
        const pages = ctx2.pages();
        for (const p2 of pages) {
          if (p2 !== page) {
            await p2.close().catch(() => undefined);
          }
        }
      }

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
    // Додаткові ATS
    if (url.includes('oraclecloud.com')) return this.oracleHcm(page, p, originalUrl);
    if (url.includes('successfactors'))  return this.successFactors(page, p, originalUrl);
    if (url.includes('taleo.net'))       return this.taleo(page, p, originalUrl);
    if (url.includes('icims.com'))       return this.icims(page, p, originalUrl);

    // Для всіх інших сайтів — universal smart filler
    return this.generic(page, p, originalUrl);
  }

  // ── Accept cookie consent (universal) ─────────────────────────────────────
  private async acceptCookies(page: Page): Promise<void> {
    logger.info('[Browser] Перевіряю cookie banner...');

    const cookieSelectors = [
      // Pracuj.pl
      'button[data-test="button-accept-all-in-cookiebar"]',
      'button[data-test="button-submitCookie"]',
      // OneTrust (найпоширеніший)
      '#onetrust-accept-btn-handler',
      'button#onetrust-accept-btn-handler',
      // CookieBot
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      // Quantcast
      '.qc-cmp2-summary-buttons button:last-child',
      // Polish
      'button:has-text("Akceptuj wszystkie")',
      'button:has-text("Zaakceptuj wszystkie")',
      'button:has-text("Zaakceptuj")',
      'button:has-text("Akceptuję")',
      'button:has-text("Akceptuj")',
      'button:has-text("Przyjmij wszystko")',
      'button:has-text("Przyjmij wszystkie")',
      'button:has-text("Zgadzam się")',
      'button:has-text("Zezwól na wszystkie")',
      // English
      'button:has-text("Accept all")',
      'button:has-text("Accept All")',
      'button:has-text("Accept all cookies")',
      'button:has-text("Accept cookies")',
      'button:has-text("Accept & continue")',
      'button:has-text("I agree")',
      'button:has-text("Agree")',
      'button:has-text("Got it")',
      'button:has-text("OK")',
      // Generic class-based
      '.cookie-accept',
      '.accept-cookies',
      '[data-testid*="cookie"][data-testid*="accept"]',
      '[aria-label*="Accept" i][aria-label*="cookie" i]',
    ];

    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 800 })) {
          await btn.click();
          logger.info(`[Browser] ✅ Cookie banner закрито: "${sel}"`);
          await page.waitForTimeout(700);
          return;
        }
      } catch { /* next */ }
    }

    logger.info('[Browser] Cookie banner не знайдено (ок)');
  }

  // ── Знайти і клікнути кнопку "Apply" на будь-якому сайті ──────────────────
  private async findAndClickApplyButton(page: Page): Promise<boolean> {
    logger.info('[Browser] Шукаю кнопку Apply...');

    // Спочатку чекаємо щоб сторінка повністю завантажилась
    await page.waitForTimeout(1500);

    // Всі можливі варіанти кнопки "Подати заявку"
    const applyTexts = [
      // English — від найточніших до загальних
      'Apply now', 'Apply Now', 'Apply for this job', 'Apply for this position',
      'Apply for job', 'Apply online', 'Apply today',
      'Quick apply', 'Easy apply', 'Fast apply',
      // Polish
      'Aplikuj teraz', 'Aplikuj szybko', 'Aplikuj na tę ofertę', 'Aplikuj',
      'Zaaplikuj', 'Złóż aplikację', 'Wyślij aplikację',
      // SmartRecruiters Polish
      'Jestem zainteresowany', 'Jestem zainteresowana',
      // Ukrainian/Russian
      'Відгукнутись', 'Подати заявку', 'Откликнуться', 'Подать заявку',
      // German
      'Jetzt bewerben', 'Bewerben',
      // French
      'Postuler maintenant', 'Postuler',
      // General — тільки в кінці (щоб не зачепити інші кнопки)
      'Apply',
    ];

    // Список слів які НЕ є кнопками Apply (виключаємо)
    const excludeTexts = [
      'cookie', 'Cookie', 'privacy', 'Privacy', 'settings', 'Settings',
      'policy', 'Policy', 'terms', 'Terms', 'reject', 'Reject',
    ];

    // Метод 1: getByRole — шукає тільки button і link елементи
    for (const text of applyTexts) {
      try {
        // Шукаємо точно по тексту через getByRole
        const candidates = page.getByRole('button', { name: new RegExp(`^${text}$`, 'i') })
          .or(page.getByRole('link', { name: new RegExp(`^${text}$`, 'i') }));

        const count = await candidates.count();
        for (let i = 0; i < count; i++) {
          const el = candidates.nth(i);
          if (!await el.isVisible({ timeout: 400 })) continue;

          // Перевіряємо що це не cookie кнопка
          const label = ((await el.textContent().catch(() => '')) ?? '').trim();
          if (excludeTexts.some(ex => label.toLowerCase().includes(ex.toLowerCase()))) {
            logger.info(`[Browser] Пропускаю (cookie/privacy): "${label}"`);
            continue;
          }

          // Перевіряємо позицію — Apply кнопка зазвичай у верхній частині сторінки
          // або в sticky header, але НЕ в footer cookie banner
          const box = await el.boundingBox().catch(() => null);
          if (box) {
            const viewportSize = page.viewportSize();
            const pageHeight = viewportSize?.height ?? 800;
            // Якщо кнопка в самому низу (>90% висоти viewport) — підозріло
            if (box.y > pageHeight * 0.9) {
              logger.info(`[Browser] Пропускаю кнопку внизу сторінки (y=${Math.round(box.y)}): "${label}"`);
              continue;
            }
          }

          logger.info(`[Browser] ✅ Apply знайдено (getByRole): "${label}"`);
          await el.click();
          logger.info(`[Browser] ✅ Клікнув: "${label}"`);
          await page.waitForTimeout(2500);
          return true;
        }
      } catch { /* next */ }
    }

    // Метод 2: data-test / aria-label атрибути
    const attrSels = [
      '[data-test*="apply"]:not([data-test*="cookie"])',
      '[data-testid*="apply"]:not([data-testid*="cookie"])',
      '[aria-label*="apply" i]:not([aria-label*="cookie" i])',
      '[aria-label*="aplikuj" i]',
      'a[href*="/apply"]:not([href*="cookie"])',
    ];
    for (const sel of attrSels) {
      try {
        const btn = page.locator(sel).first();
        if (!await btn.isVisible({ timeout: 500 })) continue;

        const label = ((await btn.textContent().catch(() => sel)) ?? sel).trim();
        if (excludeTexts.some(ex => label.toLowerCase().includes(ex.toLowerCase()))) continue;

        logger.info(`[Browser] ✅ Apply через атрибут: "${label}" [${sel}]`);
        await btn.click();
        logger.info(`[Browser] ✅ Клікнув: ${sel}`);
        await page.waitForTimeout(2500);
        return true;
      } catch { /* next */ }
    }

    // Метод 3: JS пошук — виключаємо cookie елементи
    const clicked = await page.evaluate(`
      (function() {
        var applyTexts = ['Apply now','Apply Now','Aplikuj teraz','Aplikuj szybko','Aplikuj',
          'Jestem zainteresowany','Jestem zainteresowana','Jetzt bewerben','Postuler',
          'Відгукнутись','Подати заявку'];
        var cookieWords = ['cookie','privacy','settings','policy','terms','reject'];

        var els = Array.from(document.querySelectorAll('button, a[role="button"]'));
        for (var i = 0; i < els.length; i++) {
          var t = (els[i].textContent || '').trim();
          var tl = t.toLowerCase();
          if (cookieWords.some(function(w) { return tl.includes(w); })) continue;

          // Перевіряємо позицію
          var rect = els[i].getBoundingClientRect();
          if (rect.y > window.innerHeight * 0.9) continue;

          for (var j = 0; j < applyTexts.length; j++) {
            if (tl === applyTexts[j].toLowerCase()) {
              els[i].click();
              return t;
            }
          }
        }
        return null;
      })()
    `).catch(() => null) as string | null;

    if (clicked) {
      logger.info(`[Browser] ✅ Клікнув через JS: "${clicked}"`);
      await page.waitForTimeout(2500);
      return true;
    }

    // Логуємо видимі кнопки для дебагу
    const visibleBtns = await page.$$eval(
      'button, a[role="button"]',
      els => els
        .filter(e => !!(e as { offsetParent?: unknown }).offsetParent)
        .map(e => (e.textContent || '').trim())
        .filter(t => t.length > 0 && t.length < 60)
        .slice(0, 25)
    ).catch(() => [] as string[]);
    logger.warn(`[Browser] ⚠️ Apply не знайдено. Видимі кнопки: ${visibleBtns.join(' | ')}`);

    return false;
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

    // Знаємо URL поточних вкладок ДО кліку
    const ctx = page.context();
    const pagesBefore = new Set(ctx.pages().map(p2 => p2.url()));

    await submitBtn.click();
    await page.waitForTimeout(3000);

    // --- Pracuj може показати попередження "Pracodawca prosi o wypełnienie swojego formularza" ---
    const kontynuujSels = [
      'button:has-text("Kontynuuj aplikowanie")',
      'a:has-text("Kontynuuj aplikowanie")',
      '[data-test*="continue"]',
    ];
    for (const sel of kontynuujSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          logger.info('[Browser] Pracuj: клікаю "Kontynuuj aplikowanie"');
          // Оновлюємо список вкладок перед кліком
          const pagesBeforeKont = new Set(ctx.pages().map(p2 => p2.url()));
          await btn.click();
          await page.waitForTimeout(5000); // більше часу для відкриття зовнішнього сайту

          // Шукаємо нову вкладку що з'явилась після кліку
          const allPages = ctx.pages();
          logger.info(`[Browser] Вкладки після Kontynuuj (${allPages.length}): ${allPages.map(p2 => p2.url()).join(' | ')}`);

          const newTab = allPages.find(p2 => !pagesBeforeKont.has(p2.url()) && p2 !== page);
          if (newTab) {
            logger.info(`[Browser] Знайдено нову вкладку: ${newTab.url()}`);
            await newTab.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
            await newTab.waitForTimeout(2000);
            await this.acceptCookies(newTab);
            await newTab.waitForTimeout(1000);
            return this.handleExternalAts(newTab, p, newTab.url(), originalUrl);
          }
          break;
        }
      } catch { /* next */ }
    }

    // --- Перевіряємо всі вкладки що з'явились після початкового кліку ---
    const allPagesNow = ctx.pages();
    logger.info(`[Browser] Всі вкладки (${allPagesNow.length}): ${allPagesNow.map(p2 => p2.url()).join(' | ')}`);

    const newTabAny = allPagesNow.find(p2 => !pagesBefore.has(p2.url()) && p2 !== page && !p2.url().includes('about:blank'));
    if (newTabAny) {
      logger.info(`[Browser] Нова вкладка знайдена: ${newTabAny.url()}`);
      await newTabAny.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
      await newTabAny.waitForTimeout(2000);
      await this.acceptCookies(newTabAny);
      await newTabAny.waitForTimeout(1000);
      return this.handleExternalAts(newTabAny, p, newTabAny.url(), originalUrl);
    }

    // --- Перевіряємо чи відбувся редирект на поточній вкладці ---
    const afterClickUrl = page.url();
    logger.info(`[Browser] Pracuj поточна вкладка: ${afterClickUrl}`);

    if (!afterClickUrl.includes('pracuj.pl')) {
      logger.info('[Browser] Pracuj: редирект на зовнішній сайт на поточній вкладці');
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

    // Check current URL — dziękujemy = success
    const afterUrl = page.url();
    logger.info(`[Browser] Pracuj після submit: ${afterUrl}`);

    if (afterUrl.includes('dziekujemy') || afterUrl.includes('podziekowanie') || afterUrl.includes('confirmation')) {
      logger.info('[Browser] Pracuj: URL dziękujemy — успіх!');
      return {
        success: true,
        method: 'Pracuj.pl Quick Apply',
        message:
          `✅ *Відгук відправлено через Pracuj\\.pl\\!*\n\n` +
          `${messageFilled ? '📝 Повідомлення роботодавцю додано\\.' : ''}`,
      };
    }

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
    if (currentUrl.includes('oraclecloud.com')) return this.oracleHcm(page, p, originalUrl);
    if (currentUrl.includes('successfactors'))  return this.successFactors(page, p, originalUrl);
    if (currentUrl.includes('taleo.net'))       return this.taleo(page, p, originalUrl);
    if (currentUrl.includes('icims.com'))       return this.icims(page, p, originalUrl);

    // Невідомий зовнішній сайт — universal flow з детальним логуванням:
    logger.info(`[Browser] Universal flow для: ${currentUrl}`);

    // КРОК 1: Клікаємо Apply кнопку (широкий список варіантів)
    const applyClicked = await this.findAndClickApplyButton(page);
    if (!applyClicked) {
      logger.warn('[Browser] Apply кнопку не знайдено, продовжую з поточною сторінкою...');
    }

    // КРОК 2: Якщо є вибір "Apply with CV" vs "Apply with profile" — клікаємо CV
    const applyWithCvSels = [
      'button:has-text("Apply with CV")',
      'a:has-text("Apply with CV")',
      'div:has-text("Apply with CV")',
      '[data-test*="apply-with-cv"]',
    ];
    for (const sel of applyWithCvSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          logger.info(`[Browser] Вибір методу: клікаю "Apply with CV" (${sel})`);
          await btn.click();
          await page.waitForTimeout(2500);
          break;
        }
      } catch { /* next */ }
    }

    // КРОК 3: Заповнюємо поля форми
    logger.info('[Browser] Заповнюю поля форми...');
    await this.fillExternalForm(page, p);

    // КРОК 4: Завантажуємо CV
    if (p.cvLocalPath && fs.existsSync(p.cvLocalPath)) {
      logger.info(`[Browser] Завантажую CV: ${p.cvLocalPath}`);
      await this.upload(page, p.cvLocalPath);
      await page.waitForTimeout(1000);
    }

    // КРОК 5: Приймаємо чекбокси згоди (RODO/Privacy)
    logger.info('[Browser] Приймаю consent checkboxes...');
    await this.acceptConsents(page);
    await page.waitForTimeout(500);

    // КРОК 6: Клікаємо Submit / Apply now
    logger.info('[Browser] Шукаю кнопку Submit...');
    const submitSels = [
      'button:has-text("Apply now")',
      'button:has-text("Apply Now")',
      'button:has-text("Submit application")',
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Wyślij")',
      'button:has-text("Wyślij aplikację")',
      'button:has-text("Zatwierdź")',
      'button:has-text("Send application")',
      'button[type="submit"]',
      'input[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          const disabled = await btn.isDisabled().catch(() => false);
          if (!disabled) {
            const label = await btn.textContent().catch(() => sel);
            await btn.scrollIntoViewIfNeeded().catch(() => undefined);
            await btn.click();
            submitted = true;
            logger.info(`[Browser] ✅ Submit клікнуто: "${label?.trim()}" [${sel}]`);
            await page.waitForTimeout(3000);
            break;
          } else {
            logger.warn(`[Browser] Submit заблоковано (disabled): ${sel}`);
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

  // ── Розумне заповнення будь-якої форми по смислу полів ───────────────────
  private async fillExternalForm(page: Page, p: FillFormProfile): Promise<void> {
    // Маппінг: які значення підходять для яких ключових слів
    const fieldMap: Array<{ keywords: string[]; value: string; type?: string }> = [
      { keywords: ['firstname', 'first_name', 'fname', 'given-name', 'imię', 'imie', 'vorname', 'prénom'], value: p.firstName },
      { keywords: ['lastname', 'last_name', 'lname', 'family-name', 'surname', 'nazwisko', 'nachname', 'nom'], value: p.lastName },
      { keywords: ['fullname', 'full_name', 'name', 'imienazwisko'], value: p.fullName },
      { keywords: ['email', 'e-mail', 'mail', 'adres e-mail'], value: p.email, type: 'email' },
      { keywords: ['phone', 'tel', 'telefon', 'mobile', 'numer', 'handy'], value: p.phone, type: 'tel' },
      { keywords: ['linkedin'], value: p.linkedin ?? '' },
      { keywords: ['github', 'gitlab'], value: p.github ?? '' },
      { keywords: ['salary', 'wynagrodzenie', 'oczekiwania', 'gehalt'], value: p.salaryExpectation ?? '' },
      { keywords: ['cover', 'motivation', 'message', 'letter', 'wiadomosc', 'wiadomość', 'list', 'motivace', 'anschreiben', 'notes', 'uwagi'], value: p.coverLetter },
    ];

    // Збираємо всі видимі input і textarea
    const inputs = page.locator('input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea');
    const count = await inputs.count();
    logger.info(`[Browser] SmartFill: знайдено ${count} полів`);

    for (let i = 0; i < count; i++) {
      try {
        const el = inputs.nth(i);
        if (!await el.isVisible({ timeout: 300 })) continue;

        // Збираємо всі атрибути що описують поле
        const attrs = await el.evaluate(`(node) => {
          const n = node;
          const labelEl = n.id
            ? document.querySelector('label[for="' + n.id + '"]')
            : n.closest('label') || n.parentElement && n.parentElement.querySelector('label');
          return {
            name: (n.getAttribute('name') || '').toLowerCase(),
            id: (n.getAttribute('id') || '').toLowerCase(),
            placeholder: (n.getAttribute('placeholder') || '').toLowerCase(),
            autocomplete: (n.getAttribute('autocomplete') || '').toLowerCase(),
            type: (n.getAttribute('type') || 'text').toLowerCase(),
            label: (labelEl && labelEl.textContent || '').toLowerCase().trim(),
            ariaLabel: (n.getAttribute('aria-label') || '').toLowerCase(),
          };
        }`).catch(() => null) as { name: string; id: string; placeholder: string; autocomplete: string; type: string; label: string; ariaLabel: string } | null;

        if (!attrs) continue;

        const haystack = `${attrs.name} ${attrs.id} ${attrs.placeholder} ${attrs.autocomplete} ${attrs.label} ${attrs.ariaLabel}`;

        // Знаходимо підходяще значення
        let matched = '';
        for (const { keywords, value, type } of fieldMap) {
          if (!value) continue;
          // Перевірка по type (email, tel)
          if (type && attrs.type === type) { matched = value; break; }
          // Перевірка по ключових словах
          if (keywords.some(kw => haystack.includes(kw))) { matched = value; break; }
        }

        if (matched) {
          const current = await el.inputValue().catch(() => '');
          if (!current) {
            await el.fill(matched);
            logger.info(`[Browser] SmartFill: "${attrs.name || attrs.id || attrs.placeholder}" = "${matched.slice(0, 30)}"`);
          }
        }
      } catch { /* skip */ }
    }

    // Work mode checkboxes — відмічаємо Remote якщо є
    try {
      const labels = page.locator('label');
      const labelCount = await labels.count();
      for (let i = 0; i < labelCount; i++) {
        const label = labels.nth(i);
        const text = ((await label.textContent().catch(() => '')) ?? '').toLowerCase();
        if (text.includes('remote')) {
          const cb = label.locator('input[type="checkbox"]').or(page.locator(`input[type="checkbox"]#${await label.getAttribute('for') ?? '__none__'}`));
          if (await cb.isVisible({ timeout: 300 }).catch(() => false)) {
            const checked = await cb.isChecked().catch(() => false);
            if (!checked) await cb.check();
            break;
          }
        }
      }
    } catch { /* skip */ }
  }

  // ── Автоматично приймаємо чекбокси згоди ─────────────────────────────────
  private async acceptConsents(page: Page): Promise<void> {
    try {
      // Через evaluate — не залежить від видимості/позиції
      await page.evaluate(`
        Array.from(document.querySelectorAll('input[type="checkbox"]'))
          .forEach(function(cb) { if (!cb.checked) cb.click(); });
      `);
      logger.info('[Browser] Consent checkboxes відмічено через JS');
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
    logger.info('[Browser] SmartRecruiters handler...');
    await page.waitForTimeout(2000);

    // КРОК 1: Спочатку закриваємо ВСІ cookie/privacy банери
    await this.acceptCookies(page);
    await page.waitForTimeout(500);

    // КРОК 2: Клікаємо "Jestem zainteresowany(a)" через JS (без scroll, без перекриття)
    const applyTexts = [
      'Jestem zainteresowany', 'Jestem zainteresowana',
      'Apply now', 'Apply Now', 'Apply',
    ];

    let applyClicked = false;
    for (const text of applyTexts) {
      try {
        // Шукаємо через getByRole — не залежить від позиції
        const btn = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          logger.info(`[Browser] SmartRecruiters: клікаю через JS: "${text}"`);
          // Клікаємо через evaluate — обходить будь-яке перекриття
          await btn.evaluate('(el) => el.click()');
          applyClicked = true;
          await page.waitForTimeout(3000);
          break;
        }
      } catch { /* next */ }
    }

    // Fallback: JS пошук по тексту
    if (!applyClicked) {
      const clicked = await page.evaluate(`
        (function() {
          var btns = Array.from(document.querySelectorAll('button, a'));
          var texts = ['Jestem zainteresowany', 'Jestem zainteresowana', 'Apply now', 'Apply'];
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim();
            for (var j = 0; j < texts.length; j++) {
              if (t.toLowerCase().includes(texts[j].toLowerCase())) {
                btns[i].click();
                return t;
              }
            }
          }
          return null;
        })()
      `).catch(() => null) as string | null;

      if (clicked) {
        logger.info(`[Browser] SmartRecruiters: JS клік: "${clicked}"`);
        applyClicked = true;
        await page.waitForTimeout(3000);
      }
    }

    if (!applyClicked) {
      logger.warn('[Browser] SmartRecruiters: Apply кнопку не знайдено');
    }

    // КРОК 3: Знову закриваємо cookie якщо з\'явились після кліку
    await this.acceptCookies(page);

    // КРОК 4: Перевіряємо нові вкладки
    const allPages = page.context().pages();
    const newTab = allPages.find(p2 => p2 !== page && !p2.url().includes('about:blank'));
    let activePage = page;
    if (newTab) {
      logger.info(`[Browser] SmartRecruiters: нова вкладка: ${newTab.url()}`);
      await newTab.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
      await this.acceptCookies(newTab);
      await newTab.waitForTimeout(1500);
      activePage = newTab;
    }

    logger.info(`[Browser] SmartRecruiters: сторінка: ${activePage.url()}`);

    // КРОК 5: Заповнюємо форму через smart filler
    logger.info('[Browser] SmartRecruiters: заповнюю поля...');
    await this.fillExternalForm(activePage, p);

    // Додаткові специфічні поля SmartRecruiters
    await this.f(activePage, 'input[name="firstName"]', p.firstName);
    await this.f(activePage, 'input[name="lastName"]', p.lastName);
    await this.f(activePage, 'input[name="email"]', p.email);
    await this.f(activePage, 'input[name="phoneNumber"]', p.phone);
    await this.f(activePage, 'textarea[name="message"]', p.coverLetter);
    logger.info('[Browser] SmartRecruiters: поля заповнено');

    // КРОК 6: CV
    if (p.cvLocalPath && fs.existsSync(p.cvLocalPath)) {
      logger.info('[Browser] SmartRecruiters: завантажую CV...');
      await this.upload(activePage, p.cvLocalPath);
    }

    // КРОК 7: Consent checkboxes (через evaluate щоб не перекривались)
    await activePage.evaluate(`
      Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .forEach(function(cb) { if (!cb.checked) cb.click(); });
    `).catch(() => undefined);
    logger.info('[Browser] SmartRecruiters: checkboxes відмічено');

    // КРОК 8: Submit через JS evaluate (без scroll, без перекриття)
    const submitTexts = ['Send application', 'Submit application', 'Submit', 'Apply'];
    for (const text of submitTexts) {
      try {
        const btn = activePage.getByRole('button', { name: new RegExp(text, 'i') }).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          const disabled = await btn.isDisabled().catch(() => false);
          if (!disabled) {
            logger.info(`[Browser] SmartRecruiters: ✅ Submit: "${text}"`);
            await btn.evaluate('(el) => el.click()');
            await activePage.waitForTimeout(3000);
            return { success: true, method: 'SmartRecruiters', message: '✅ *Відгук відправлено через SmartRecruiters\\!*' };
          } else {
            logger.warn(`[Browser] SmartRecruiters: Submit disabled: "${text}"`);
          }
        }
      } catch { /* next */ }
    }

    return {
      success: false, method: 'SmartRecruiters',
      message: `📋 Форму SmartRecruiters заповнено\\. Натисни Submit вручну\\.`,
    };
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

  // ── Oracle HCM (oraclecloud.com) ───────────────────────────────────────────
  private async oracleHcm(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    logger.info('[Browser] Oracle HCM handler...');
    await page.waitForTimeout(3000);

    // Oracle HCM — кнопка "Apply Now"
    const applyBtn = page.locator('button:has-text("Apply Now"), a:has-text("Apply Now"), button:has-text("Aplikuj")').first();
    if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await applyBtn.click();
      await page.waitForTimeout(3000);
      await this.acceptCookies(page);
    }

    // Oracle може відкрити нову вкладку або модал з формою
    await this.fillExternalForm(page, p);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    await this.acceptConsents(page);

    const submitBtn = page.locator('button:has-text("Submit"), button:has-text("Apply"), button[type="submit"]').first();
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
      return { success: true, method: 'Oracle HCM', message: '✅ *Відгук відправлено через Oracle HCM\\!*' };
    }

    return {
      success: false, method: 'Oracle HCM',
      message: `📋 Форму Oracle HCM заповнено\\. Натисни Submit вручну\\.\n\n🔗 [Вакансія](${originalUrl})`,
    };
  }

  // ── SAP SuccessFactors ─────────────────────────────────────────────────────
  private async successFactors(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    logger.info('[Browser] SuccessFactors handler...');
    await page.waitForTimeout(3000);
    await this.acceptCookies(page);

    // SuccessFactors Apply button
    const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply Now"), [data-automation-id*="apply"]').first();
    if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await applyBtn.click();
      await page.waitForTimeout(3000);
    }

    await this.fillExternalForm(page, p);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    await this.acceptConsents(page);

    const submit = page.locator('button:has-text("Submit"), [data-automation-id*="submit"]').first();
    if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submit.click();
      await page.waitForTimeout(3000);
      return { success: true, method: 'SuccessFactors', message: '✅ *Відгук відправлено через SuccessFactors\\!*' };
    }

    return {
      success: false, method: 'SuccessFactors',
      message: `📋 Форму SuccessFactors заповнено\\. Натисни Submit вручну\\.\n\n🔗 [Вакансія](${originalUrl})`,
    };
  }

  // ── Oracle Taleo ───────────────────────────────────────────────────────────
  private async taleo(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    logger.info('[Browser] Taleo handler...');
    await page.waitForTimeout(3000);
    await this.acceptCookies(page);

    await this.fillExternalForm(page, p);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    await this.acceptConsents(page);

    const submit = page.locator('button:has-text("Submit"), input[type="submit"], button:has-text("Next")').first();
    if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submit.click();
      await page.waitForTimeout(3000);
      return { success: true, method: 'Taleo', message: '✅ *Відгук відправлено через Taleo\\!*' };
    }

    return {
      success: false, method: 'Taleo',
      message: `📋 Форму Taleo заповнено\\. Натисни Submit вручну\\.\n\n🔗 [Вакансія](${originalUrl})`,
    };
  }

  // ── iCIMS ──────────────────────────────────────────────────────────────────
  private async icims(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    logger.info('[Browser] iCIMS handler...');
    await page.waitForTimeout(3000);
    await this.acceptCookies(page);

    // iCIMS — кнопка "Apply for Job"
    const applyBtn = page.locator('button:has-text("Apply for Job"), a:has-text("Apply"), button:has-text("Apply")').first();
    if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await applyBtn.click();
      await page.waitForTimeout(3000);
    }

    await this.fillExternalForm(page, p);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath);
    await this.acceptConsents(page);

    const submit = page.locator('button:has-text("Submit"), button[type="submit"]').first();
    if (await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submit.click();
      await page.waitForTimeout(3000);
      return { success: true, method: 'iCIMS', message: '✅ *Відгук відправлено через iCIMS\\!*' };
    }

    return {
      success: false, method: 'iCIMS',
      message: `📋 Форму iCIMS заповнено\\. Натисни Submit вручну\\.\n\n🔗 [Вакансія](${originalUrl})`,
    };
  }

  private async generic(page: Page, p: FillFormProfile, originalUrl: string): Promise<BrowserApplyResult> {
    logger.info(`[Browser] Generic handler: ${page.url()}`);

    // Перевіряємо cookie banner
    await this.acceptCookies(page);

    // Шукаємо і клікаємо кнопку Apply
    await this.findAndClickApplyButton(page);

    // Перевіряємо нові вкладки після кліку
    await page.waitForTimeout(1500);
    const allPages = page.context().pages();
    const newTab = allPages.find(p2 => p2 !== page && !p2.url().includes('about:blank'));
    if (newTab) {
      logger.info(`[Browser] Generic: нова вкладка після Apply: ${newTab.url()}`);
      await newTab.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
      await this.acceptCookies(newTab);
      await newTab.waitForTimeout(1000);
      return this.handleExternalAts(newTab, p, newTab.url(), originalUrl);
    }

    // Заповнюємо форму на поточній сторінці
    logger.info('[Browser] Generic: заповнюю форму...');
    await this.fillExternalForm(page, p);
    await this.acceptConsents(page);
    if (p.cvLocalPath) await this.upload(page, p.cvLocalPath).catch(() => undefined);

    // Submit
    const submitSels = [
      'button:has-text("Submit application")', 'button:has-text("Submit Application")',
      'button:has-text("Apply now")', 'button:has-text("Apply Now")',
      'button:has-text("Submit")', 'button:has-text("Apply")',
      'button:has-text("Send")', 'button:has-text("Wyślij")',
      'button[type="submit"]', 'input[type="submit"]',
    ];
    for (const sel of submitSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 800 })) {
          const disabled = await btn.isDisabled().catch(() => false);
          if (!disabled) {
            const label = await btn.textContent().catch(() => sel);
            await btn.click();
            logger.info(`[Browser] Generic: ✅ Submit: "${label?.trim()}"`);
            await page.waitForTimeout(2000);
            return { success: true, method: 'Generic', message: `✅ Форму заповнено і відправлено\\!` };
          }
        }
      } catch { /* next */ }
    }

    return {
      success: false, method: 'Generic',
      message: `📋 Форму заповнено\\. Натисни Submit у браузері\\.\n\n*Ім'я:* ${p.fullName}\n*Email:* ${p.email}\n*Телефон:* ${p.phone}\n\n🔗 [Вакансія](${originalUrl})`,
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
