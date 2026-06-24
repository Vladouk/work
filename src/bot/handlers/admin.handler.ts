import { Context } from 'grammy';
import { prisma } from '../../infrastructure/database';
import { UserRepository } from '../../repositories/UserRepository';
import { config } from '../../config';
import { logger } from '../../infrastructure/logger';
import { ParserManager } from '../../parsers/parser.manager';

const userRepo = new UserRepository();

function isAdmin(telegramId: number): boolean {
  return config.telegram.adminIds.includes(telegramId);
}

export async function handleAdmin(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || !isAdmin(from.id)) {
    await ctx.reply('❌ Access denied.');
    return;
  }

  const [userCount, vacancyCount, logCount] = await Promise.all([
    prisma.user.count(),
    prisma.vacancy.count(),
    prisma.parserLog.count(),
  ]);

  await ctx.reply(
    `🛠 *Admin Panel*\n\n` +
      `👥 Users: ${userCount}\n` +
      `💼 Vacancies: ${vacancyCount}\n` +
      `📋 Parser Runs: ${logCount}\n\n` +
      `*Commands:*\n` +
      `/admin_users - View all users\n` +
      `/admin_jobs - View recent jobs\n` +
      `/admin_parsers - Parser status\n` +
      `/admin_run - Run parsers now\n` +
      `/admin_logs - View recent logs`,
    { parse_mode: 'Markdown' },
  );
}

export async function handleAdminUsers(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || !isAdmin(from.id)) return;

  const users = await userRepo.findAll();
  const lines = users.map((u, i) =>
    `${i + 1}. ${u.firstName ?? '-'} @${u.username ?? '-'} | Active: ${u.isActive} | TG: ${u.telegramId}`,
  );

  const text = `👥 *Users (${users.length})*\n\n${lines.slice(0, 30).join('\n')}`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleAdminJobs(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || !isAdmin(from.id)) return;

  const vacancies = await prisma.vacancy.findMany({
    orderBy: { scrapedAt: 'desc' },
    take: 10,
  });

  const lines = vacancies.map(
    (v) => `• *${v.title}* @ ${v.company}\n  Source: ${v.source} | ${v.scrapedAt.toLocaleDateString()}`,
  );

  await ctx.reply(`💼 *Recent Jobs*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
}

export async function handleAdminParsers(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || !isAdmin(from.id)) return;

  const logs = await prisma.parserLog.findMany({
    orderBy: { startedAt: 'desc' },
    take: 20,
  });

  const sourceGroups: Record<string, typeof logs> = {};
  for (const log of logs) {
    if (!sourceGroups[log.source]) sourceGroups[log.source] = [];
    sourceGroups[log.source].push(log);
  }

  const lines = Object.entries(sourceGroups).map(([source, sourceLogs]) => {
    const latest = sourceLogs[0];
    const statusEmoji = latest.status === 'success' ? '✅' : latest.status === 'error' ? '❌' : '⏳';
    return (
      `${statusEmoji} *${source}*\n` +
      `  Last run: ${latest.startedAt.toLocaleString()}\n` +
      `  Found: ${latest.jobsFound} | New: ${latest.jobsNew} | Errors: ${latest.status === 'error' ? 1 : 0}`
    );
  });

  await ctx.reply(`🤖 *Parser Status*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
}

export async function handleAdminRunParsers(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || !isAdmin(from.id)) return;

  const msg = await ctx.reply('⏳ Running all parsers...');
  try {
    const manager = new ParserManager();
    const { total, newJobs } = await manager.runAll();

    await ctx.api.editMessageText(
      from.id,
      msg.message_id,
      `✅ *Parsers complete!*\n\nTotal found: ${total}\nNew jobs: ${newJobs}`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error(`[Admin] Run parsers error: ${(err as Error).message}`);
    await ctx.api
      .editMessageText(from.id, msg.message_id, '❌ Parser run failed.')
      .catch(() => undefined);
  }
}

export async function handleAdminLogs(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || !isAdmin(from.id)) return;

  const logs = await prisma.appLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  if (logs.length === 0) {
    await ctx.reply('No error logs found.');
    return;
  }

  const lines = logs.map(
    (l) => `[${l.level.toUpperCase()}] ${l.createdAt.toLocaleString()}\n${l.message}`,
  );

  // Split into chunks to avoid Telegram message length limit
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length > 3500) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n\n';
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(`📋 *Recent Logs*\n\n\`\`\`\n${chunk}\n\`\`\``, { parse_mode: 'Markdown' });
  }
}
