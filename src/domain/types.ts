import {
  JobSource,
  JobCategory,
  ExperienceLevel,
  JobType,
  ApplicationStatus,
  EngLevel,
} from '@prisma/client';

export type { JobSource, JobCategory, ExperienceLevel, JobType, ApplicationStatus, EngLevel };

// ─── Raw vacancy from parser ──────────────────────────────────────────────────
export interface RawVacancy {
  title: string;
  company: string;
  location?: string;
  city?: string;
  country?: string;
  isRemote?: boolean;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  description?: string;
  requirements?: string;
  url: string;
  source: JobSource;
  category?: JobCategory;
  experienceLevel?: ExperienceLevel;
  jobType?: JobType;
  postedAt?: Date;
  tags?: string[];
  externalId?: string;
}

// ─── CV Match result from OpenAI ─────────────────────────────────────────────
export interface CvMatchResult {
  matchScore: number;
  matchReason: string;
  missingSkills: string[];
  coverLetter?: string;
  cvSummary?: string;
  outreachMsg?: string;
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────
export interface DashboardStats {
  jobsFoundToday: number;
  matchingJobs: number;
  savedJobs: number;
  appliedJobs: number;
}

// ─── Filter options for vacancy queries ───────────────────────────────────────
export interface VacancyFilter {
  keywords?: string[];
  city?: string;
  country?: string;
  isRemote?: boolean;
  salaryMin?: number;
  salaryMax?: number;
  categories?: JobCategory[];
  experienceLevels?: ExperienceLevel[];
  sources?: JobSource[];
  limit?: number;
  offset?: number;
  excludeApplied?: boolean;
  userId?: number;
}

// ─── Notification payload ─────────────────────────────────────────────────────
export interface NotificationPayload {
  userId: number;
  telegramId: bigint;
  vacancy: {
    id: number;
    title: string;
    company: string;
    location: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    currency: string | null;
    url: string;
    isRemote: boolean;
  };
  matchScore?: number;
  matchReason?: string;
}
