import fs from 'fs';
import path from 'path';
import axios from 'axios';
import pdfParse from 'pdf-parse';
import { CvRepository } from '../repositories/CvRepository';
import { openaiService } from './openai.service';
import { logger } from '../infrastructure/logger';
import { CvMatchResult } from '../domain/types';
import { Vacancy } from '@prisma/client';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

export class CvService {
  private cvRepo: CvRepository;

  constructor() {
    this.cvRepo = new CvRepository();
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  async processCvUpload(
    userId: number,
    fileId: string,
    fileName: string,
    fileUrl: string,
  ): Promise<{ extractedText: string; cvFileId: number }> {
    // Download file from Telegram
    const localPath = path.join(UPLOADS_DIR, `${userId}_${Date.now()}.pdf`);

    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(localPath, response.data as Buffer);

    let extractedText = '';
    try {
      const dataBuffer = fs.readFileSync(localPath);
      const pdfData = await pdfParse(dataBuffer);
      extractedText = pdfData.text;
    } catch (err) {
      logger.warn(`[CvService] PDF parse failed for ${fileName}: ${(err as Error).message}`);
    } finally {
      // Clean up local file after extraction
      fs.unlink(localPath, () => undefined);
    }

    // Deactivate previous CVs
    await this.cvRepo.deactivateAll(userId);

    // Save new CV
    const cvFile = await this.cvRepo.create({
      userId,
      fileId,
      fileName,
      extractedText,
    });

    logger.info(`[CvService] CV uploaded for user ${userId}, extracted ${extractedText.length} chars`);
    return { extractedText, cvFileId: cvFile.id };
  }

  async matchCvToVacancy(
    userId: number,
    vacancy: Vacancy,
  ): Promise<CvMatchResult | null> {
    const cv = await this.cvRepo.findActiveByUser(userId);
    if (!cv || !cv.extractedText) return null;

    // Check cache
    const existing = await this.cvRepo.findMatch(vacancy.id, cv.id);
    if (existing) {
      return {
        matchScore: existing.matchScore,
        matchReason: existing.matchReason ?? '',
        missingSkills: existing.missingSkills,
        coverLetter: existing.coverLetter ?? undefined,
        cvSummary: existing.cvSummary ?? undefined,
        outreachMsg: existing.outreachMsg ?? undefined,
      };
    }

    const result = await openaiService.matchCvToVacancy(
      cv.extractedText,
      vacancy.title,
      vacancy.description ?? '',
    );

    // Cache result
    await this.cvRepo.saveMatch({
      vacancyId: vacancy.id,
      cvFileId: cv.id,
      ...result,
    });

    return result;
  }

  async getActiveCv(userId: number) {
    return this.cvRepo.findActiveByUser(userId);
  }
}

export const cvService = new CvService();
