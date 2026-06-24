import { InlineKeyboard } from 'grammy';

export const mainMenuKeyboard = new InlineKeyboard()
  .text('🔍 Вакансії', 'menu_jobs')
  .text('🔎 Пошук', 'menu_search')
  .row()
  .text('⚙️ Налаштування', 'menu_settings')
  .text('📄 Моє CV', 'menu_cv')
  .row()
  .text('👤 Профіль', 'menu_profile')
  .text('📊 Статистика', 'menu_stats');

export const settingsKeyboard = new InlineKeyboard()
  .text('🔑 Ключові слова', 'settings_keywords')
  .text('📍 Місто', 'settings_location')
  .row()
  .text('🏠 Тільки Remote', 'settings_remote')
  .text('💰 Зарплата', 'settings_salary')
  .row()
  .text('🔔 Сповіщення', 'settings_notify')
  .text('🎯 Мін. збіг %', 'settings_minscore')
  .row()
  .text('◀ Назад', 'menu_main');

export const cvMenuKeyboard = new InlineKeyboard()
  .text('📤 Завантажити CV', 'cv_upload')
  .row()
  .text('🔍 Перевірити збіг', 'cv_match_jobs')
  .text('📋 Інфо про CV', 'cv_info')
  .row()
  .text('◀ Назад', 'menu_main');

export const profileMenuKeyboard = new InlineKeyboard()
  .text('✏️ Заповнити профіль', 'profile_fill')
  .row()
  .text('👁 Переглянути', 'profile_view')
  .text('🗑 Очистити', 'profile_clear')
  .row()
  .text('◀ Назад', 'menu_main');

export function jobActionsKeyboard(jobId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('💾 Зберегти', `save_job_${jobId}`)
    .text('✅ Відправив', `applied_job_${jobId}`)
    .row()
    .text('🤖 Супровідний лист', `cover_letter_${jobId}`)
    .text('📝 Повідомлення', `outreach_${jobId}`)
    .row()
    .text('📨 Авто-відгук', `auto_apply_${jobId}`)
    .row()
    .text('❌ Приховати', `hide_job_${jobId}`);
}

export function paginationKeyboard(
  currentPage: number,
  totalPages: number,
  prefix: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (currentPage > 1) kb.text('◀ Назад', `${prefix}_page_${currentPage - 1}`);
  kb.text(`${currentPage}/${totalPages}`, 'noop');
  if (currentPage < totalPages) kb.text('Далі ▶', `${prefix}_page_${currentPage + 1}`);
  return kb;
}

export const statsKeyboard = new InlineKeyboard()
  .text('📅 Сьогодні', 'stats_today')
  .text('📆 Цього тижня', 'stats_week')
  .row()
  .text('◀ Назад', 'menu_main');

export const autoApplyConfirmKeyboard = (jobId: number) =>
  new InlineKeyboard()
    .text('✅ Так, відправити', `confirm_apply_${jobId}`)
    .text('❌ Скасувати', `hide_job_${jobId}`);
