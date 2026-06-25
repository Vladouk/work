import { JobSource } from '../domain/types';
import { BaseParser } from './base.parser';
import { JustJoinITParser } from './justjoinit.parser';
import { NoFluffJobsParser } from './nofluffjobs.parser';
import { BulldogJobParser } from './bulldogjob.parser';
import { PracujPlParser } from './pracujpl.parser';
import { LinkedInParser } from './linkedin.parser';
import { VacancyRepository } from '../repositories/VacancyRepository';
import { prisma } from '../infrastructure/database';
import { logger } from '../infrastructure/logger';

export class ParserManager {
  private parsers: BaseParser[];
  private vacancyRepo: VacancyRepository;

  constructor() {
    this.parsers = [
      new JustJoinITParser(),  // ✅ Публічний API — найбільше junior вакансій
      new NoFluffJobsParser(), // ✅ API з фільтром по seniority
      new BulldogJobParser(),  // ✅ HTML + __NEXT_DATA__
      new PracujPlParser(),    // ✅ Playwright (обхід Cloudflare)
      // LinkedInParser виключено з автоматичного runAll — потребує активного логіну
    ];
    this.vacancyRepo = new VacancyRepository();
  }

  async runAll(): Promise<{ total: number; newJobs: number }> {
    let total = 0;
    let newJobs = 0;

    for (const parser of this.parsers) {
      const { jobsNew, jobsFound } = await this.runParser(parser);
      total += jobsFound;
      newJobs += jobsNew;
    }

    logger.info(`[ParserManager] Цикл завершено. Знайдено: ${total}, Нових: ${newJobs}`);
    return { total, newJobs };
  }

  // Запускати LinkedIn окремо (потребує логіну в браузері)
  async runLinkedIn(): Promise<{ jobsFound: number; jobsNew: number }> {
    const parser = new LinkedInParser();
    const result = await this.runParser(parser);
    return { jobsFound: result.jobsFound, jobsNew: result.jobsNew };
  }

  async runParser(
    parser: BaseParser,
  ): Promise<{ source: JobSource; jobsFound: number; jobsNew: number }> {
    const log = await prisma.parserLog.create({ data: { source: parser.source } });

    try {
      logger.info(`[${parser.source}] Запуск...`);
      const vacancies = await parser.parse();
      logger.info(`[${parser.source}] Знайдено ${vacancies.length}`);

      const result = await this.vacancyRepo.createMany(vacancies);

      await prisma.parserLog.update({
        where: { id: log.id },
        data: {
          finishedAt: new Date(),
          jobsFound: vacancies.length,
          jobsNew: result.count,
          jobsDuplicate: vacancies.length - result.count,
          status: 'success',
        },
      });

      return { source: parser.source, jobsFound: vacancies.length, jobsNew: result.count };
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error(`[${parser.source}] Помилка: ${errorMsg}`);
      await prisma.parserLog.update({
        where: { id: log.id },
        data: { finishedAt: new Date(), status: 'error', errorMsg },
      });
      return { source: parser.source, jobsFound: 0, jobsNew: 0 };
    }
  }
}
