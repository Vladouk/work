-- CreateEnum
CREATE TYPE "JobSource" AS ENUM ('LINKEDIN', 'NOFLUFFJOBS', 'JUSTJOINIT', 'PRACUJPL', 'BULLDOGJOB');

-- CreateEnum
CREATE TYPE "JobCategory" AS ENUM ('BACKEND', 'FULLSTACK', 'NODEJS', 'JAVASCRIPT', 'TYPESCRIPT', 'REACT', 'QA', 'IT_SUPPORT', 'PROJECT_COORDINATOR', 'OTHER');

-- CreateEnum
CREATE TYPE "ExperienceLevel" AS ENUM ('INTERN', 'JUNIOR', 'TRAINEE');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('REMOTE', 'HYBRID', 'ONSITE');

-- CreateEnum
CREATE TYPE "EngLevel" AS ENUM ('ANY', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SAVED', 'APPLIED', 'INTERVIEW', 'REJECTED', 'OFFER');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY['junior', 'node.js', 'javascript']::TEXT[],
    "country" TEXT NOT NULL DEFAULT 'Poland',
    "city" TEXT,
    "remoteOnly" BOOLEAN NOT NULL DEFAULT false,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'PLN',
    "englishLevel" "EngLevel" NOT NULL DEFAULT 'ANY',
    "notifyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minMatchScore" INTEGER NOT NULL DEFAULT 60,
    "categories" "JobCategory"[] DEFAULT ARRAY[]::"JobCategory"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cv_files" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "extractedText" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cv_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacancies" (
    "id" SERIAL NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Poland',
    "isRemote" BOOLEAN NOT NULL DEFAULT false,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "currency" TEXT,
    "description" TEXT,
    "requirements" TEXT,
    "url" TEXT NOT NULL,
    "source" "JobSource" NOT NULL,
    "category" "JobCategory" NOT NULL DEFAULT 'OTHER',
    "experienceLevel" "ExperienceLevel" NOT NULL DEFAULT 'JUNIOR',
    "jobType" "JobType" NOT NULL DEFAULT 'ONSITE',
    "postedAt" TIMESTAMP(3),
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "vacancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cv_matches" (
    "id" SERIAL NOT NULL,
    "vacancyId" INTEGER NOT NULL,
    "cvFileId" INTEGER NOT NULL,
    "matchScore" INTEGER NOT NULL,
    "matchReason" TEXT,
    "missingSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverLetter" TEXT,
    "cvSummary" TEXT,
    "outreachMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cv_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "vacancyId" INTEGER NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SAVED',
    "notes" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "vacancyId" INTEGER NOT NULL,
    "matchScore" INTEGER,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "errorMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_sessions" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "query" TEXT NOT NULL,
    "resultsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parser_logs" (
    "id" SERIAL NOT NULL,
    "source" "JobSource" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "jobsFound" INTEGER NOT NULL DEFAULT 0,
    "jobsNew" INTEGER NOT NULL DEFAULT 0,
    "jobsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorMsg" TEXT,
    CONSTRAINT "parser_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_logs" (
    "id" SERIAL NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_logs_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");
CREATE UNIQUE INDEX "user_settings_userId_key" ON "user_settings"("userId");
CREATE UNIQUE INDEX "vacancies_url_key" ON "vacancies"("url");
CREATE UNIQUE INDEX "cv_matches_vacancyId_cvFileId_key" ON "cv_matches"("vacancyId", "cvFileId");
CREATE UNIQUE INDEX "applications_userId_vacancyId_key" ON "applications"("userId", "vacancyId");

-- CreateIndex
CREATE INDEX "vacancies_source_idx" ON "vacancies"("source");
CREATE INDEX "vacancies_scrapedAt_idx" ON "vacancies"("scrapedAt");
CREATE INDEX "vacancies_isActive_idx" ON "vacancies"("isActive");
CREATE INDEX "vacancies_city_idx" ON "vacancies"("city");
CREATE INDEX "vacancies_isRemote_idx" ON "vacancies"("isRemote");
CREATE INDEX "app_logs_level_idx" ON "app_logs"("level");
CREATE INDEX "app_logs_createdAt_idx" ON "app_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cv_files" ADD CONSTRAINT "cv_files_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cv_matches" ADD CONSTRAINT "cv_matches_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "vacancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "applications" ADD CONSTRAINT "applications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "applications" ADD CONSTRAINT "applications_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "vacancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "vacancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "search_sessions" ADD CONSTRAINT "search_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
