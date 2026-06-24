import { User, UserSettings } from '@prisma/client';
import { EngLevel, JobCategory } from '../types';

export interface CreateUserDto {
  telegramId: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface UpdateSettingsDto {
  keywords?: string[];
  country?: string;
  city?: string | null;
  remoteOnly?: boolean;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string;
  englishLevel?: EngLevel;
  notifyEnabled?: boolean;
  minMatchScore?: number;
  categories?: JobCategory[];
}

export type UserWithSettings = User & { settings: UserSettings | null };

export interface IUserRepository {
  findByTelegramId(telegramId: bigint): Promise<UserWithSettings | null>;
  findById(id: number): Promise<UserWithSettings | null>;
  findAll(): Promise<UserWithSettings[]>;
  findActive(): Promise<UserWithSettings[]>;
  create(data: CreateUserDto): Promise<UserWithSettings>;
  upsert(data: CreateUserDto): Promise<UserWithSettings>;
  updateSettings(userId: number, data: UpdateSettingsDto): Promise<UserSettings>;
  setActive(userId: number, active: boolean): Promise<void>;
}
