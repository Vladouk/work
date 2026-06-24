import { Vacancy } from '@prisma/client';
import { RawVacancy, VacancyFilter } from '../types';

export interface IVacancyRepository {
  create(data: RawVacancy): Promise<Vacancy>;
  createMany(data: RawVacancy[]): Promise<{ count: number }>;
  findByUrl(url: string): Promise<Vacancy | null>;
  findById(id: number): Promise<Vacancy | null>;
  findMany(filter: VacancyFilter): Promise<Vacancy[]>;
  findNew(since: Date, filter?: VacancyFilter): Promise<Vacancy[]>;
  count(filter?: VacancyFilter): Promise<number>;
  markInactive(id: number): Promise<void>;
  existsByUrl(url: string): Promise<boolean>;
}
