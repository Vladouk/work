import { CvFile, CvMatch } from '@prisma/client';

export interface ICreateCvDto {
  userId: number;
  fileId: string;
  fileName: string;
  extractedText?: string;
}

export interface ICvRepository {
  create(data: ICreateCvDto): Promise<CvFile>;
  findActiveByUser(userId: number): Promise<CvFile | null>;
  findById(id: number): Promise<CvFile | null>;
  deactivateAll(userId: number): Promise<void>;
  saveMatch(data: {
    vacancyId: number;
    cvFileId: number;
    matchScore: number;
    matchReason?: string;
    missingSkills?: string[];
    coverLetter?: string;
    cvSummary?: string;
    outreachMsg?: string;
  }): Promise<CvMatch>;
  findMatch(vacancyId: number, cvFileId: number): Promise<CvMatch | null>;
}
