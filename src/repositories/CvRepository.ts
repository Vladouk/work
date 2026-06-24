import { CvFile, CvMatch } from '@prisma/client';
import { prisma } from '../infrastructure/database';
import { ICvRepository, ICreateCvDto } from '../domain/interfaces/ICvRepository';

export class CvRepository implements ICvRepository {
  async create(data: ICreateCvDto): Promise<CvFile> {
    return prisma.cvFile.create({ data });
  }

  async findActiveByUser(userId: number): Promise<CvFile | null> {
    return prisma.cvFile.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: number): Promise<CvFile | null> {
    return prisma.cvFile.findUnique({ where: { id } });
  }

  async deactivateAll(userId: number): Promise<void> {
    await prisma.cvFile.updateMany({
      where: { userId },
      data: { isActive: false },
    });
  }

  async saveMatch(data: {
    vacancyId: number;
    cvFileId: number;
    matchScore: number;
    matchReason?: string;
    missingSkills?: string[];
    coverLetter?: string;
    cvSummary?: string;
    outreachMsg?: string;
  }): Promise<CvMatch> {
    return prisma.cvMatch.upsert({
      where: {
        vacancyId_cvFileId: {
          vacancyId: data.vacancyId,
          cvFileId: data.cvFileId,
        },
      },
      create: data,
      update: data,
    });
  }

  async findMatch(vacancyId: number, cvFileId: number): Promise<CvMatch | null> {
    return prisma.cvMatch.findUnique({
      where: { vacancyId_cvFileId: { vacancyId, cvFileId } },
    });
  }
}
