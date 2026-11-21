import { z } from 'zod';
import {
  aiShadowAgents, buildAiShadowReview, normalizeAiShadowEvidence, summarizeAiShadowReviews, validateAiShadowDecision,
  type AiShadowEvidence,
} from './ai-shadow';

const provider = z.enum(['GEMINI', 'CLAUDE', 'OPENAI']);
export type AiShadowProvider = z.infer<typeof provider>;
type Agent = (typeof aiShadowAgents)[number];
type Review = ReturnType<typeof buildAiShadowReview>;
type FixtureOracle = (review: Review, signal: AbortSignal) => Promise<unknown>;

const modelName = z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/)
  .refine((value) => !/^(sk-|AIza|key[-_])/i.test(value));
const configSchema = z.strictObject({
  mode: z.enum(['off', 'fixture']),
  models: z.partialRecord(provider, modelName),
  timeoutMs: z.number().int().min(100).max(5000),
  runTimeoutMs: z.number().int().min(100).max(20000),
  maxAttempts: z.number().int().min(1).max(12),
});
type Config = z.infer<typeof configSchema>;

/** Activation requires a separately reviewed provider path. This configuration only supports local fixtures. */
export function loadAiShadowConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const mode = env.SMARTEXIT_AI_SHADOW_MODE ?? 'off';
  const models = Object.fromEntries(provider.options.flatMap((name) => {
    const model = env[`SMARTEXIT_AI_${name}_MODEL`];
    return model === undefined ? [] : [[name, model]];
  }));
  const parseNumber = (key: string, fallback: number) => {
    const value = env[key];
    if (value === undefined) return fallback;
    return /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  };
  const result = configSchema.safeParse({
    mode, models,
    timeoutMs: parseNumber('SMARTEXIT_AI_SHADOW_TIMEOUT_MS', 2500),
    runTimeoutMs: parseNumber('SMARTEXIT_AI_SHADOW_RUN_TIMEOUT_MS', 10000),
    maxAttempts: parseNumber('SMARTEXIT_AI_SHADOW_MAX_ATTEMPTS', 6),
  });
  if (!result.success) throw new Error('Invalid AI shadow configuration.');
  return result.data;
}

const assignmentSchema = z.array(z.strictObject({
  agent: z.enum(aiShadowAgents), provider, promptVersion: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/),
})).max(aiShadowAgents.length);
type Assignment = z.infer<typeof assignmentSchema>[number];
type FailureCode = 'BUDGET_EXHAUSTED' | 'MODEL_NOT_CONFIGURED' | 'MOCK_ERROR' | 'MOCK_TIMEOUT' | 'INVALID_DECISION';

/** A synthetic fixture may explicitly request one controlled retry. Arbitrary errors are never retryable. */
export class RetryableAiShadowFixtureError extends Error {}
class AiShadowFixtureTimeout extends Error {}

async function withFixtureDeadline(oracle: FixtureOracle, payload: Review, timeoutMs: number) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => oracle(payload, abort.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new AiShadowFixtureTimeout());
          abort.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runAiShadowFixture(input: {
  config: Config; evidence: AiShadowEvidence; assignments: readonly Assignment[]; oracle: FixtureOracle;
}) {
  const config = configSchema.safeParse(input.config);
  if (!config.success) throw new Error('Invalid AI shadow configuration.');
  const evidence = normalizeAiShadowEvidence(input.evidence);
  const result = () => summarizeAiShadowReviews(evidence, []);
  if (config.data.mode === 'off') {
    return { ...result(), status: 'DISABLED' as const, source: 'OFFLINE_FIXTURE' as const, attempts: 0, failures: [] };
  }
  const assignments = assignmentSchema.parse(input.assignments);
  if (new Set(assignments.map(({ agent }) => agent)).size !== assignments.length) throw new Error('Duplicate AI shadow assignment.');
  const failures: { agent: Agent; code: FailureCode }[] = [];
  const validated: Parameters<typeof summarizeAiShadowReviews>[1][number][] = [];
  let attempts = 0;
  const started = performance.now();
  for (const assignment of assignments) {
    const model = config.data.models[assignment.provider];
    if (!model) {
      failures.push({ agent: assignment.agent, code: 'MODEL_NOT_CONFIGURED' });
      continue;
    }
    const identity = { ...assignment, model };
    const payload = buildAiShadowReview(evidence, identity);
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = Math.floor(config.data.runTimeoutMs - (performance.now() - started));
      if (attempts >= config.data.maxAttempts || remaining <= 0) {
        failures.push({ agent: assignment.agent, code: 'BUDGET_EXHAUSTED' });
        break;
      }
      attempts++;
      let response: unknown;
      try {
        response = await withFixtureDeadline(input.oracle, payload, Math.min(remaining, config.data.timeoutMs));
      } catch (error) {
        if (error instanceof RetryableAiShadowFixtureError && attempt === 0) continue;
        failures.push({ agent: assignment.agent, code: error instanceof AiShadowFixtureTimeout ? 'MOCK_TIMEOUT' : 'MOCK_ERROR' });
        break;
      }
      try {
        validated.push({ identity, response: validateAiShadowDecision(response, evidence, identity) });
      } catch {
        failures.push({ agent: assignment.agent, code: 'INVALID_DECISION' });
      }
      break;
    }
  }
  const summary = summarizeAiShadowReviews(evidence, validated);
  return { ...summary, status: summary.missingAgents.length ? 'PARTIAL' as const : 'COMPLETE' as const,
    source: 'OFFLINE_FIXTURE' as const, attempts, failures };
}
