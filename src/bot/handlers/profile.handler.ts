import { Context } from 'grammy';
import { prisma } from '../../infrastructure/database';
import { UserRepository } from '../../repositories/UserRepository';
import { profileMenuKeyboard } from '../keyboards';
import { logger } from '../../infrastructure/logger';

const userRepo = new UserRepository();

// Multi-step profile wizard state
const profileWizard = new Map<number, { step: string; data: Record<string, string> }>();

const STEPS = [
  { key: 'fullName',    question: '👤 Як тебе звати? (Ім\'я та прізвище)\n\nПриклад: `Іван Петренко`' },
  { key: 'email',       question: '📧 Твій email:\n\nПриклад: `ivan@gmail.com`' },
  { key: 'phone',       question: '📞 Твій номер телефону:\n\nПриклад: `+380501234567`' },
  { key: 'linkedin',    question: '💼 Посилання на LinkedIn (або `-` якщо немає):' },
  { key: 'github',      question: '🐙 Посилання на GitHub (або `-` якщо немає):' },
  { key: 'position',    question: '💻 Бажана посада:\n\nПриклад: `Junior Node.js Developer`' },
  { key: 'experience',  question: '📅 Скільки місяців досвіду? (0 якщо без досвіду)\n\nПриклад: `6`' },
  { key: 'skills',      question: '🛠 Твої навички через кому:\n\nПриклад: `JavaScript, TypeScript, Node.js, React, Git`' },
  { key: 'languages',   question: '🌐 Мови (рівень):\n\nПриклад: `Українська (рідна), Англійська (B2), Польська (A2)`' },
  { key: 'location',    question: '📍 Твоє місто:\n\nПриклад: `Wrocław` або `Remote`' },
  { key: 'salary',      question: '💰 Бажана зарплата (PLN/місяць):\n\nПриклад: `5000-8000`' },
  { key: 'coverNote',   question: '✍️ Коротка інформація про себе для супровідного листа (2-3 речення):' },
];

export async function handleProfile(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return;

  const profile = await prisma.userProfile.findUnique({ where: { userId: user.id } });

  if (!profile) {
    await ctx.reply(
      `👤 *Профіль не заповнено*\n\n` +
        `Заповни профіль — він використовується для:\n` +
        `• 🤖 Автоматичного відправлення CV на вакансії\n` +
        `• ✍️ Генерації персоналізованих супровідних листів\n` +
        `• 📊 Підбору вакансій за твоїми навичками\n\n` +
        `Натисни кнопку нижче щоб почати:`,
      { parse_mode: 'Markdown', reply_markup: profileMenuKeyboard },
    );
    return;
  }

  const text = [
    `👤 *Твій профіль*`,
    ``,
    `🧑 Ім'я: ${profile.fullName ?? '—'}`,
    `📧 Email: ${profile.email ?? '—'}`,
    `📞 Телефон: ${profile.phone ?? '—'}`,
    `💼 LinkedIn: ${profile.linkedin ?? '—'}`,
    `🐙 GitHub: ${profile.github ?? '—'}`,
    `💻 Посада: ${profile.position ?? '—'}`,
    `📅 Досвід: ${profile.experienceMonths ?? 0} міс.`,
    `🛠 Навички: ${profile.skills ?? '—'}`,
    `🌐 Мови: ${profile.languages ?? '—'}`,
    `📍 Місто: ${profile.location ?? '—'}`,
    `💰 Зарплата: ${profile.salaryExpectation ?? '—'} PLN`,
  ].join('\n');

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: profileMenuKeyboard,
  });
}

export async function startProfileWizard(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  await ctx.answerCallbackQuery?.();

  profileWizard.set(from.id, { step: STEPS[0].key, data: {} });

  await ctx.reply(
    `📝 *Заповнення профілю*\n\nВідповідай на запитання. Це займе ~2 хвилини.\n\n` +
      `(${1}/${STEPS.length}) ${STEPS[0].question}`,
    { parse_mode: 'Markdown' },
  );
}

export async function handleProfileInput(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  if (!from) return false;

  const wizard = profileWizard.get(from.id);
  if (!wizard) return false;

  const text = ctx.message?.text ?? '';
  const currentStepIndex = STEPS.findIndex((s) => s.key === wizard.step);

  // Save current answer
  wizard.data[wizard.step] = text === '-' ? '' : text;

  // Move to next step
  const nextStep = STEPS[currentStepIndex + 1];

  if (!nextStep) {
    // Wizard complete — save profile
    profileWizard.delete(from.id);
    await saveProfile(ctx, from.id, wizard.data);
    return true;
  }

  wizard.step = nextStep.key;
  profileWizard.set(from.id, wizard);

  await ctx.reply(
    `(${currentStepIndex + 2}/${STEPS.length}) ${nextStep.question}`,
    { parse_mode: 'Markdown' },
  );

  return true;
}

async function saveProfile(ctx: Context, telegramId: number, data: Record<string, string>): Promise<void> {
  try {
    const user = await userRepo.findByTelegramId(BigInt(telegramId));
    if (!user) return;

    const expMonths = parseInt(data.experience ?? '0', 10);

    await prisma.userProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        linkedin: data.linkedin || null,
        github: data.github || null,
        position: data.position,
        experienceMonths: isNaN(expMonths) ? 0 : expMonths,
        skills: data.skills,
        languages: data.languages,
        location: data.location,
        salaryExpectation: data.salary,
        coverNote: data.coverNote,
      },
      update: {
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        linkedin: data.linkedin || null,
        github: data.github || null,
        position: data.position,
        experienceMonths: isNaN(expMonths) ? 0 : expMonths,
        skills: data.skills,
        languages: data.languages,
        location: data.location,
        salaryExpectation: data.salary,
        coverNote: data.coverNote,
      },
    });

    await ctx.reply(
      `✅ *Профіль збережено!*\n\n` +
        `Тепер ти можеш:\n` +
        `• Натиснути "📨 Авто-відгук" на будь-якій вакансії\n` +
        `• Бот автоматично заповнить форму та відправить CV\n\n` +
        `Переглянути профіль: /profile`,
      { parse_mode: 'Markdown' },
    );

    logger.info(`[Profile] Профіль збережено для user ${user.id}`);
  } catch (err) {
    logger.error(`[Profile] Помилка збереження: ${(err as Error).message}`);
    await ctx.reply('❌ Помилка збереження профілю. Спробуй ще раз: /profile');
  }
}

export async function clearProfile(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  await ctx.answerCallbackQuery?.();
  const user = await userRepo.findByTelegramId(BigInt(from.id));
  if (!user) return;

  await prisma.userProfile.deleteMany({ where: { userId: user.id } });
  await ctx.reply('🗑 Профіль видалено.');
}
