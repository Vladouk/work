import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../infrastructure/logger';
import { CvMatchResult } from '../domain/types';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
});

// Strip markdown code fences Gemini sometimes wraps around JSON
function extractJson(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim();
}

// Classify error
function classifyError(err: unknown): 'quota_exhausted' | 'retryable' | 'fatal' {
  const msg = String((err as Error).message ?? '');
  if (msg.includes('limit: 0') || msg.includes('depleted') || msg.includes('AI_QUOTA_EXHAUSTED')) {
    return 'quota_exhausted';
  }
  if (msg.includes('429') || msg.includes('503') || msg.includes('overloaded')) {
    return 'retryable';
  }
  return 'fatal';
}

// Retry with exponential backoff for 429/503
async function withAiRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'quota_exhausted') {
        throw new Error('AI_QUOTA_EXHAUSTED');
      }
      if (kind === 'retryable' && i < retries - 1) {
        const wait = (i + 1) * 5000; // 5s, 10s — для 15 RPM достатньо
        logger.warn(`[AI] Rate limit, чекаю ${wait / 1000}s... (спроба ${i + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// User-friendly error text
export function aiErrorText(err: unknown): string {
  const msg = String((err as Error).message ?? '');
  if (msg === 'AI_QUOTA_EXHAUSTED') {
    return (
      '⚠️ *Денний ліміт Gemini API вичерпано*\n\n' +
      'Спробуй завтра, або підключи безлімітний AI:\n' +
      '1\\. Зареєструйся на [openrouter\\.ai](https://openrouter.ai)\n' +
      '2\\. Отримай ключ `sk-or-v1-...`\n' +
      '3\\. Вав мені в чат — я перемкну за 1 хвилину'
    );
  }
  return '❌ AI тимчасово недоступний\\. Спробуй пізніше\\.';
}

export class OpenAIService {
  private model = config.openai.model;

  // ── CV vs Vacancy match ────────────────────────────────────────────────────
  async matchCvToVacancy(
    cvText: string,
    vacancyTitle: string,
    vacancyDescription: string,
  ): Promise<CvMatchResult> {
    const prompt = `
You are an expert HR tech assistant. Analyze the CV and job vacancy below.

JOB VACANCY
Title: ${vacancyTitle}
Description: ${vacancyDescription}

CANDIDATE CV
${cvText.slice(0, 6000)}

TASK
Return ONLY a raw JSON object — no markdown, no explanation, no code fences.
Use exactly this structure:
{
  "matchScore": 75,
  "matchReason": "2-3 sentences explaining the match",
  "missingSkills": ["skill1", "skill2"],
  "coverLetter": "3-paragraph cover letter",
  "cvSummary": "3-4 sentence CV summary tailored to this vacancy",
  "outreachMsg": "brief LinkedIn outreach message to recruiter"
}
    `.trim();

    try {
      const completion = await withAiRetry(() =>
        openai.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2000,
        }),
      );
      const raw = completion.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(extractJson(raw)) as CvMatchResult;
      return {
        matchScore: Math.min(100, Math.max(0, Number(parsed.matchScore) || 0)),
        matchReason: parsed.matchReason ?? '',
        missingSkills: Array.isArray(parsed.missingSkills) ? parsed.missingSkills : [],
        coverLetter: parsed.coverLetter,
        cvSummary: parsed.cvSummary,
        outreachMsg: parsed.outreachMsg,
      };
    } catch (err) {
      logger.error(`[AI] matchCvToVacancy failed: ${(err as Error).message}`);
      return {
        matchScore: 0,
        matchReason: aiErrorText(err),
        missingSkills: [],
      };
    }
  }

  // ── Generate cover letter ──────────────────────────────────────────────────
  async generateCoverLetter(cvText: string, vacancyTitle: string, company: string): Promise<string> {
    const prompt = `
Write a professional, personalized cover letter for the position "${vacancyTitle}" at "${company}".
Use the following CV as context:

${cvText.slice(0, 4000)}

Requirements:
- 3 paragraphs, professional but warm tone
- Highlight relevant skills, show enthusiasm
- Max 250 words
Return only the cover letter text.
    `.trim();

    try {
      const completion = await withAiRetry(() =>
        openai.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 600,
        }),
      );
      return completion.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      logger.error(`[AI] generateCoverLetter failed: ${(err as Error).message}`);
      return aiErrorText(err);
    }
  }

  // ── Rewrite CV summary ─────────────────────────────────────────────────────
  async rewriteCvSummary(cvText: string, vacancyTitle: string, requirements: string): Promise<string> {
    const prompt = `
Rewrite the professional summary for the position: "${vacancyTitle}".
Job requirements: ${requirements.slice(0, 1000)}
Current CV: ${cvText.slice(0, 3000)}
Write 3-4 first-person sentences highlighting relevant skills and achievements.
Return only the summary text.
    `.trim();

    try {
      const completion = await withAiRetry(() =>
        openai.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.5,
          max_tokens: 300,
        }),
      );
      return completion.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      logger.error(`[AI] rewriteCvSummary failed: ${(err as Error).message}`);
      return aiErrorText(err);
    }
  }

  // ── Recruiter outreach ─────────────────────────────────────────────────────
  async generateOutreachMessage(candidateName: string, vacancyTitle: string, company: string): Promise<string> {
    const prompt = `
Write a brief LinkedIn outreach message from "${candidateName}" to a recruiter at "${company}" for "${vacancyTitle}".
Max 150 words, friendly and confident, clear call to action.
Return only the message text.
    `.trim();

    try {
      const completion = await withAiRetry(() =>
        openai.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 250,
        }),
      );
      return completion.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      logger.error(`[AI] generateOutreachMessage failed: ${(err as Error).message}`);
      return aiErrorText(err);
    }
  }

  // ── Missing skills ─────────────────────────────────────────────────────────
  async getMissingSkills(cvText: string, jobDescription: string): Promise<string[]> {
    const prompt = `
List the top 5 skills mentioned in the job description but missing from the CV.
CV: ${cvText.slice(0, 3000)}
Job: ${jobDescription.slice(0, 2000)}
Return ONLY a JSON array: ["skill1", "skill2"]
    `.trim();

    try {
      const completion = await withAiRetry(() =>
        openai.chat.completions.create({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 200,
        }),
      );
      const raw = completion.choices[0]?.message?.content ?? '[]';
      const parsed = JSON.parse(extractJson(raw));
      return Array.isArray(parsed) ? parsed : (parsed.skills ?? []);
    } catch (err) {
      logger.error(`[AI] getMissingSkills failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Vision: аналізуємо скріншот і знаходимо що клікати ──────────────────
  async analyzeScreenshot(
    screenshotBase64: string,
    task: string,
  ): Promise<{ action: string; selector?: string; text?: string; x?: number; y?: number; description: string }> {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${screenshotBase64}`,
                  detail: 'high',
                },
              },
              {
                type: 'text',
                text: `You are a browser automation assistant. Analyze this screenshot and ${task}

Return ONLY valid JSON (no markdown, no explanation):
{
  "action": "click" | "fill" | "submit" | "wait" | "done",
  "description": "what you see and what to do",
  "text": "button text to click (if action=click)",
  "selector": "CSS selector if identifiable",
  "x": pixel_x_coordinate,
  "y": pixel_y_coordinate
}

Rules:
- If you see a cookie banner: action="click", text="Accept all" or similar accept button
- If you see an Apply/Aplikuj button: action="click" with its text and coordinates
- If you see a form: action="fill", describe which fields are visible
- If form is filled and Submit is visible: action="submit"
- If already submitted/thank you page: action="done"
- x,y should be the CENTER of the element you want to click`,
              },
            ],
          },
        ],
        max_tokens: 300,
      });

      const raw = response.choices[0]?.message?.content ?? '{}';
      return JSON.parse(extractJson(raw));
    } catch (err) {
      logger.warn(`[AI Vision] Error: ${(err as Error).message}`);
      return { action: 'wait', description: 'Vision analysis failed' };
    }
  }
}

export const openaiService = new OpenAIService();
