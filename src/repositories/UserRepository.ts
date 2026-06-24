import { User, UserSettings } from '@prisma/client';
import { prisma } from '../infrastructure/database';
import {
  IUserRepository,
  CreateUserDto,
  UpdateSettingsDto,
  UserWithSettings,
} from '../domain/interfaces/IUserRepository';

export class UserRepository implements IUserRepository {
  async findByTelegramId(telegramId: bigint): Promise<UserWithSettings | null> {
    return prisma.user.findUnique({
      where: { telegramId },
      include: { settings: true },
    });
  }

  async findById(id: number): Promise<UserWithSettings | null> {
    return prisma.user.findUnique({
      where: { id },
      include: { settings: true },
    });
  }

  async findAll(): Promise<UserWithSettings[]> {
    return prisma.user.findMany({ include: { settings: true } });
  }

  async findActive(): Promise<UserWithSettings[]> {
    return prisma.user.findMany({
      where: { isActive: true },
      include: { settings: true },
    });
  }

  async create(data: CreateUserDto): Promise<UserWithSettings> {
    return prisma.user.create({
      data: {
        telegramId: data.telegramId,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        settings: {
          create: {}, // default settings
        },
      },
      include: { settings: true },
    });
  }

  async upsert(data: CreateUserDto): Promise<UserWithSettings> {
    const existing = await this.findByTelegramId(data.telegramId);
    if (existing) {
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: {
          username: data.username,
          firstName: data.firstName,
          lastName: data.lastName,
          isActive: true,
        },
        include: { settings: true },
      });
      // Ensure settings exist
      if (!updated.settings) {
        await prisma.userSettings.create({ data: { userId: updated.id } });
        return (await this.findById(updated.id)) as UserWithSettings;
      }
      return updated;
    }
    return this.create(data);
  }

  async updateSettings(userId: number, data: UpdateSettingsDto): Promise<UserSettings> {
    return prisma.userSettings.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  async setActive(userId: number, active: boolean): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { isActive: active } });
  }
}
