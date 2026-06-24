import { CronJob } from 'cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { ParserManager } from '../parsers/parser.manager';
import { NotificationService } from '../services/notification.service';
import { logger } from '../infrastructure/logger';

export class Scheduler {
  private parserJob: CronJob;
  private notificationService: NotificationService;
  private parserManager: ParserManager;

  constructor(bot: Bot) {
    this.notificationService = new NotificationService(bot);
    this.parserManager = new ParserManager();

    this.parserJob = new CronJob(
      config.cron.schedule,
      () => this.runParserCycle(),
      null,
      false,
      'Europe/Warsaw',
    );
  }

  start(): void {
    this.parserJob.start();
    logger.info(`[Scheduler] Parser cron started: ${config.cron.schedule}`);

    // Run immediately on startup after a short delay
    setTimeout(() => this.runParserCycle(), 5000);
  }

  stop(): void {
    this.parserJob.stop();
    logger.info('[Scheduler] Cron stopped');
  }

  private async runParserCycle(): Promise<void> {
    const cycleStart = new Date();
    logger.info('[Scheduler] Starting parser cycle...');

    try {
      const { newJobs } = await this.parserManager.runAll();
      logger.info(`[Scheduler] Parser cycle done. New jobs: ${newJobs}`);

      if (newJobs > 0) {
        logger.info('[Scheduler] Sending notifications...');
        await this.notificationService.notifyUsersAboutNewJobs(cycleStart);
      }
    } catch (err) {
      logger.error(`[Scheduler] Cycle failed: ${(err as Error).message}`);
    }
  }
}
