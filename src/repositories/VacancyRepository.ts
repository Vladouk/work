import { Prisma, Vacancy } from '@prisma/client';
import { prisma } from '../infrastructure/database';
import { IVacancyRepository } from '../domain/interfaces/IVacancyRepository';
import { RawVacancy, VacancyFilter } from '../domain/types';
import { logger } from '../infrastructure/logger';

export class VacancyRepository implements IVacancyRepository {
  async create(data: RawVacancy): Promise<Vacancy> {
    return prisma.vacancy.create({
      data: {
        title: data.title,
        company: data.company,
        location: data.location,
        city: data.city,
        country: data.country ?? 'Poland',
        isRemote: data.isRemote ?? false,
        salaryMin: data.salaryMin,
        salaryMax: data.salaryMax,
        currency: data.currency,
        description: data.description,
        requirements: data.requirements,
        url: data.url,
        source: data.source,
        category: data.category ?? 'OTHER',
        experienceLevel: data.experienceLevel ?? 'JUNIOR',
        jobType: data.jobType ?? 'ONSITE',
        postedAt: data.postedAt,
        tags: data.tags ?? [],
        externalId: data.externalId,
      },
    });
  }

  async createMany(data: RawVacancy[]): Promise<{ count: number }> {
    // Filter out duplicates by URL
    const existingUrls = await prisma.vacancy.findMany({
      where: { url: { in: data.map((v) => v.url) } },
      select: { url: true },
    });
    const existingUrlSet = new Set(existingUrls.map((v) => v.url));
    const newVacancies = data.filter((v) => !existingUrlSet.has(v.url));

    if (newVacancies.length === 0) return { count: 0 };

    const result = await prisma.vacancy.createMany({
      data: newVacancies.map((v) => ({
        title: v.title,
        company: v.company,
        location: v.location,
        city: v.city,
        country: v.country ?? 'Poland',
        isRemote: v.isRemote ?? false,
        salaryMin: v.salaryMin,
        salaryMax: v.salaryMax,
        currency: v.currency,
        description: v.description,
        requirements: v.requirements,
        url: v.url,
        source: v.source,
        category: v.category ?? 'OTHER',
        experienceLevel: v.experienceLevel ?? 'JUNIOR',
        jobType: v.jobType ?? 'ONSITE',
        postedAt: v.postedAt,
        tags: v.tags ?? [],
        externalId: v.externalId,
      })),
      skipDuplicates: true,
    });

    logger.debug(`VacancyRepository.createMany: saved ${result.count}/${data.length}`);
    return result;
  }

  async findByUrl(url: string): Promise<Vacancy | null> {
    return prisma.vacancy.findUnique({ where: { url } });
  }

  async findById(id: number): Promise<Vacancy | null> {
    return prisma.vacancy.findUnique({ where: { id } });
  }

  async findMany(filter: VacancyFilter): Promise<Vacancy[]> {
    const where = this.buildWhereClause(filter);
    
    // Exclude already applied vacancies if requested
    if (filter.excludeApplied && filter.userId) {
      const applied = await prisma.application.findMany({
        where: { userId: filter.userId },
        select: { vacancyId: true },
      });
      const appliedIds = new Set(applied.map((a) => a.vacancyId));
      
      return prisma.vacancy.findMany({
        where: { ...where, id: { notIn: Array.from(appliedIds) } },
        orderBy: { scrapedAt: 'desc' },
        take: filter.limit ?? 20,
        skip: filter.offset ?? 0,
      });
    }
    
    return prisma.vacancy.findMany({
      where,
      orderBy: { scrapedAt: 'desc' },
      take: filter.limit ?? 20,
      skip: filter.offset ?? 0,
    });
  }

  async findNew(since: Date, filter?: VacancyFilter): Promise<Vacancy[]> {
    const where = this.buildWhereClause(filter ?? {});
    return prisma.vacancy.findMany({
      where: { ...where, scrapedAt: { gte: since } },
      orderBy: { scrapedAt: 'desc' },
    });
  }

  async count(filter?: VacancyFilter): Promise<number> {
    const f = filter ?? {};
    const where = this.buildWhereClause(f);
    
    // Exclude already applied vacancies if requested
    if (f.excludeApplied && f.userId) {
      const applied = await prisma.application.findMany({
        where: { userId: f.userId },
        select: { vacancyId: true },
      });
      const appliedIds = new Set(applied.map((a) => a.vacancyId));
      return prisma.vacancy.count({ where: { ...where, id: { notIn: Array.from(appliedIds) } } });
    }
    
    return prisma.vacancy.count({ where });
  }

  async markInactive(id: number): Promise<void> {
    await prisma.vacancy.update({ where: { id }, data: { isActive: false } });
  }

  async existsByUrl(url: string): Promise<boolean> {
    const count = await prisma.vacancy.count({ where: { url } });
    return count > 0;
  }

  private buildWhereClause(filter: VacancyFilter): Prisma.VacancyWhereInput {
    const where: Prisma.VacancyWhereInput = { isActive: true };

    if (filter.keywords?.length) {
      where.OR = filter.keywords.map((kw) => ({
        OR: [
          { title: { contains: kw, mode: 'insensitive' } },
          { description: { contains: kw, mode: 'insensitive' } },
          { tags: { has: kw.toLowerCase() } },
        ],
      }));
    }

    if (filter.city) {
      where.city = { contains: filter.city, mode: 'insensitive' };
    }

    if (filter.country) {
      where.country = { contains: filter.country, mode: 'insensitive' };
    }

    if (filter.isRemote === true) {
      where.isRemote = true;
    }

    if (filter.salaryMin !== undefined) {
      where.salaryMax = { gte: filter.salaryMin };
    }

    if (filter.salaryMax !== undefined) {
      where.salaryMin = { lte: filter.salaryMax };
    }

    if (filter.categories?.length) {
      where.category = { in: filter.categories };
    }

    if (filter.experienceLevels?.length) {
      where.experienceLevel = { in: filter.experienceLevels };
    }

    if (filter.sources?.length) {
      where.source = { in: filter.sources };
    }

    return where;
  }
}
