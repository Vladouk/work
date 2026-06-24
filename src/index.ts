import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from './infrastructure/database';
import { logger } from './infrastructure/logger';
import { createBot } from './bot/bot';
import { Scheduler } from './jobs/scheduler';

async function bootstrap(): Promise<void> {
  logger.info('🚀 Starting Telegram Job Hunter Bot...');

  // Connect to database
  try {
    await connectDatabase();
    logger.info('✅ Database connected');
  } catch (err) {
    logger.error(`❌ Database connection failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Create and start bot
  const bot = createBot();
  const scheduler = new Scheduler(bot);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`[Shutdown] Received ${signal}, shutting down...`);
    scheduler.stop();
    await bot.stop();
    await disconnectDatabase();
    logger.info('[Shutdown] Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error(`[Fatal] Uncaught exception: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`[Fatal] Unhandled rejection: ${String(reason)}`);
  });

  // Start scheduler
  scheduler.start();

  // Start bot polling
  await bot.start({
    onStart: (info) => {
      logger.info(`✅ Bot started: @${info.username}`);
    },
  });
}

bootstrap().catch((err) => {
  logger.error(`[Bootstrap] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
