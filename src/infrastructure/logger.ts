import winston from 'winston';
import { config } from '../config';
import { prisma } from './database';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
  return `[${ts}] ${level}: ${stack || message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: config.app.logLevel,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    config.app.isDev ? colorize() : winston.format.uncolorize(),
    logFormat,
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

// Custom transport to also persist logs to DB
class PrismaTransport extends winston.transports.Stream {
  constructor() {
    const { Writable } = require('stream');
    const stream = new Writable({
      write(chunk: Buffer, _enc: string, callback: () => void) {
        callback();
      },
    });
    super({ stream });
  }

  log(info: { level: string; message: string; [key: string]: unknown }, callback: () => void): void {
    setImmediate(() => {
      const { level, message, ...meta } = info;
      if (level === 'error' || level === 'warn') {
        prisma.appLog
          .create({ data: { level, message, meta: meta as object ?? undefined } })
          .catch(() => {
            // Silently ignore DB log errors to avoid infinite loops
          });
      }
      callback();
    });
  }
}

logger.add(new PrismaTransport());
