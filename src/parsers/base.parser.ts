import axios, { AxiosInstance } from 'axios';
import { RawVacancy, JobSource, ExperienceLevel, JobCategory } from '../domain/types';
import { logger } from '../infrastructure/logger';
import { config } from '../config';

export abstract class BaseParser {
  protected readonly http: AxiosInstance;
  abstract readonly source: JobSource;

  protected readonly juniorKeywords = [
    'junior', 'intern', 'internship', 'trainee', 'entry', 'entry-level',
    'graduate', 'stażysta', 'praktykant', 'młodszy',
  ];

  protected readonly categoryKeywords: Record<JobCategory, string[]> = {
    BACKEND: ['backend', 'back-end', 'back end', 'server', 'api', 'microservice'],
    FULLSTACK: ['fullstack', 'full-stack', 'full stack'],
    NODEJS: ['node.js', 'nodejs', 'node js', 'express', 'nestjs', 'fastify'],
    JAVASCRIPT: ['javascript', 'js ', ' js,', 'vanilla js', 'ecmascript'],
    TYPESCRIPT: ['typescript', 'ts ', ' ts,'],
    REACT: ['react', 'react.js', 'reactjs', 'next.js', 'nextjs'],
    QA: ['qa', 'quality assurance', 'tester', 'testing', 'selenium', 'cypress', 'playwright'],
    IT_SUPPORT: ['it support', 'helpdesk', 'help desk', 'support specialist', 'service desk'],
    PROJECT_COORDINATOR: ['project coordinator', 'project manager', 'pm ', 'scrum master', 'agile'],
    OTHER: [],
  };

  constructor() {
    this.http = axios.create({
      timeout: config.parser.timeout,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,pl;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });
  }

  abstract parse(): Promise<RawVacancy[]>;

  protected detectExperienceLevel(text: string): ExperienceLevel {
    const lower = text.toLowerCase();
    if (lower.includes('intern') || lower.includes('internship') || lower.includes('praktyk') || lower.includes('stażyst')) {
      return 'INTERN';
    }
    if (lower.includes('trainee')) return 'TRAINEE';
    return 'JUNIOR';
  }

  protected detectCategory(title: string, description = ''): JobCategory {
    const text = `${title} ${description}`.toLowerCase();
    for (const [category, keywords] of Object.entries(this.categoryKeywords)) {
      if (keywords.some((kw) => text.includes(kw))) {
        return category as JobCategory;
      }
    }
    return 'OTHER';
  }

  protected isJuniorVacancy(title: string, description = ''): boolean {
    const text = `${title} ${description}`.toLowerCase();
    return this.juniorKeywords.some((kw) => text.includes(kw));
  }

  protected parseSalary(text: string): { min?: number; max?: number; currency?: string } {
    if (!text) return {};
    const cleaned = text.replace(/\s/g, '').replace(',', '.');
    const plnMatch = cleaned.match(/(\d+(?:\.\d+)?)[kK]?[-–](\d+(?:\.\d+)?)[kK]?(?:PLN|zł|pln)?/);
    if (plnMatch) {
      let min = parseFloat(plnMatch[1]);
      let max = parseFloat(plnMatch[2]);
      if (plnMatch[0].toLowerCase().includes('k')) {
        min *= 1000;
        max *= 1000;
      }
      return { min: Math.round(min), max: Math.round(max), currency: 'PLN' };
    }
    return {};
  }

  protected async withRetry<T>(fn: () => Promise<T>, retries = config.parser.maxRetries): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        logger.warn(`[${this.source}] Attempt ${attempt}/${retries} failed: ${lastError.message}`);
        if (attempt < retries) {
          await this.sleep(1000 * attempt);
        }
      }
    }
    throw lastError;
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected normalizeCity(location: string): string | undefined {
    if (!location) return undefined;
    const known = ['Wrocław', 'Warsaw', 'Warszawa', 'Kraków', 'Gdańsk', 'Poznań', 'Łódź', 'Katowice', 'Szczecin'];
    for (const city of known) {
      if (location.toLowerCase().includes(city.toLowerCase())) return city;
    }
    return location.split(',')[0]?.trim();
  }
}
