import { PrismaClient } from '@prisma/client';
import { config } from '../config';

declare global {
  // Allow global `prisma` in development to prevent too many connections
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log:
      config.app.isDev
        ? [{ emit: 'event', level: 'query' }, 'info', 'warn', 'error']
        : ['warn', 'error'],
    datasources: {
      db: {
        url: config.database.url,
      },
    },
  });
}

export const prisma: PrismaClient =
  config.app.isDev
    ? (global.__prisma ??= createPrismaClient())
    : createPrismaClient();

if (config.app.isDev) {
  global.__prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
