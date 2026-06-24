import * as fs from 'fs';
import axios from 'axios';
import { Vacancy } from '@prisma/client';
import { prisma } from '../infrastructure/database';
import { openaiService } from './openai.service';
import { browserService } from './browser.service';
import { logger } from '../infrastructure/logger';

export interface AutoApplyResult {
  success: boolean;
  method: string;
  message: string;
  coverLetter?: string;
  screenshotBase64?: string;
}

export interface UserProfileData {
  fullName: string;
  email: string;
  phone: string;
  linkedin?: string | null;
  github?: string | null;
  position: string;
  experienceMonths: number;
  skills: string;
  languages: string;
  location: string;
  salaryExpectation?: string | null;
  coverNote?: string | null;
}

export class AutoApplyService {

  async applyToVacancy(
    userId: number,
    vacancy: Vacancy,
    cvText: string,
    cvFileId: string,
    profile: UserProfileData,
    cvLocalPath?: string,
  ): Promise<AutoApplyResult> {
    const url = vacancy.url;
    logger.info(`[AutoApply] ${vacancy.title} @ ${vacancy.company} — ${url}`);

    const nameParts = profile.fullName.trim().split(/\s+/);
    const firstName = nameParts[0] ?? profile.fullName;
    const lastName = nameParts.slice(1).join(' ') || '-';

    // Generate cover letter only for browser apply
    let coverLetter = '';
    try {
      coverLetter = await openaiService.generateCoverLetter(cvText, vacancy.title, vacancy.company);
    } catch {
      coverLetter = `Dear Hiring Team, I am applying for the ${vacancy.title} position. Please find my CV attached. Best regards, ${profile.fullName}`;
    }

    const browserProfile = {
      fullName: profile.fullName,
      firstName,
      lastName,
      email: profile.email,
      phone: profile.phone,
      linkedin: profile.linkedin,
      github: profile.github,
      position: profile.position,
      skills: profile.skills,
      languages: profile.languages,
      location: profile.location,
      experienceMonths: profile.experienceMonths,
      salaryExpectation: profile.salaryExpectation,
      coverLetter,
      cvLocalPath,
    };

    // JustJoinIT — try API first
    if (url.includes('justjoin.it')) {
      const apiResult = await this.applyJustJoinITApi(vacancy, profile, coverLetter);
      if (apiResult.success) return apiResult;
      logger.info('[AutoApply] JustJoinIT API failed, спробую браузер...');
    }

    // NoFluffJobs — try API first
    if (url.includes('nofluffjobs.com')) {
      const apiResult = await this.applyNoFluffJobsApi(vacancy, profile, coverLetter);
      if (apiResult.success) return apiResult;
      logger.info('[AutoApply] NoFluffJobs API failed, спробую браузер...');
    }

    // ALL OTHER SITES (including pracuj.pl) → Browser
    logger.info(`[AutoApply] Браузер для: ${url}`);
    try {
      const browserResult = await browserService.applyOnExternalSite(url, browserProfile);
      return {
        success: browserResult.success,
        method: browserResult.method,
        message: browserResult.message,
        coverLetter: browserResult.success ? coverLetter : undefined,
        screenshotBase64: browserResult.screenshotBase64,
      };
    } catch (err) {
      logger.error(`[AutoApply] Browser error: ${(err as Error).message}`);
      return {
        success: false,
        method: 'Browser',
        message:
          `⚠️ Помилка браузера\\.\n\n` +
          `📋 Дані:\n*Ім'я:* ${profile.fullName}\n` +
          `*Email:* ${profile.email}\n*Телефон:* ${profile.phone}\n` +
          `\n🔗 [Відкрити вакансію](${url})`,
        coverLetter,
      };
    }
  }

  private async applyJustJoinITApi(vacancy: Vacancy, profile: UserProfileData, coverLetter: string): Promise<AutoApplyResult> {
    try {
      const offerId = vacancy.url.split('/job-offer/')[1]?.split('?')[0]
        ?? vacancy.url.split('/offers/')[1]?.split('?')[0];
      if (!offerId) throw new Error('No offer ID');

      await axios.post(
        `https://justjoin.it/api/offers/${offerId}/applications`,
        {
          firstName: profile.fullName.split(' ')[0],
          lastName: profile.fullName.split(' ').slice(1).join(' ') || '-',
          email: profile.email,
          phone: profile.phone,
          message: coverLetter,
          linkedin: profile.linkedin ?? '',
          github: profile.github ?? '',
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
      );
      return { success: true, method: 'JustJoinIT API', message: '✅ Відгук відправлено через JustJoinIT\\!', coverLetter };
    } catch {
      return { success: false, method: 'JustJoinIT API', message: '' };
    }
  }

  private async applyNoFluffJobsApi(vacancy: Vacancy, profile: UserProfileData, coverLetter: string): Promise<AutoApplyResult> {
    try {
      const slug = vacancy.url.split('/praca-it/')[1]?.split('?')[0]
        ?? vacancy.url.split('/job/')[1]?.split('?')[0];
      if (!slug) throw new Error('No slug');

      await axios.post(
        'https://nofluffjobs.com/api/candidate/application',
        { name: profile.fullName, email: profile.email, phone: profile.phone, message: coverLetter, posting: slug },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
      );
      return { success: true, method: 'NoFluffJobs API', message: '✅ Відгук відправлено через NoFluffJobs\\!', coverLetter };
    } catch {
      return { success: false, method: 'NoFluffJobs API', message: '' };
    }
  }

  async recordAutoApply(userId: number, vacancyId: number, success: boolean): Promise<void> {
    await prisma.application.upsert({
      where: { userId_vacancyId: { userId, vacancyId } },
      create: { userId, vacancyId, status: success ? 'APPLIED' : 'SAVED', notes: `auto-apply:${success ? 'success' : 'manual'}`, appliedAt: success ? new Date() : undefined },
      update: { status: success ? 'APPLIED' : 'SAVED', notes: `auto-apply:${success ? 'success' : 'manual'}`, appliedAt: success ? new Date() : undefined },
    });
  }
}

export const autoApplyService = new AutoApplyService();
