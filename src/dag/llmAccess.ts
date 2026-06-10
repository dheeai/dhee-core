import type {
  LLMAccess,
  LLMAccessMessage,
  LLMAccessTier,
  LLMGenerateTextOptions,
  LLMGenerateTextResult,
} from '@dhee/runner-sdk';
import { getLLMConfig } from '../core/llm/config.js';
import type { LLMPurpose } from '../core/llm/purposes.js';
import { isLLMPurpose } from '../core/llm/purposes.js';
import { buildRouter } from '../core/llm/router.js';

const TIER_REPRESENTATIVE_PURPOSE: Record<LLMAccessTier, LLMPurpose> = {
  heavy: 'content.story',
  medium: 'structured.scene_breakdown',
  light: 'utility.image_review',
};

export function resolvePurpose(opts: LLMGenerateTextOptions): LLMPurpose {
  if (opts.purpose !== undefined) {
    if (!isLLMPurpose(opts.purpose)) {
      throw new Error(`unknown LLM purpose '${opts.purpose}'`);
    }
    return opts.purpose;
  }
  return TIER_REPRESENTATIVE_PURPOSE[opts.tier ?? 'medium'];
}

export function normalizeMessages(messages: LLMAccessMessage[]): LLMAccessMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

export function createRunnerLLMAccess(projectDir: string): LLMAccess {
  const router = buildRouter(getLLMConfig(), projectDir);

  return {
    async generateText(opts: LLMGenerateTextOptions): Promise<LLMGenerateTextResult> {
      const purpose = resolvePurpose(opts);
      const client = router.getClient(purpose);
      const resp = await client.generate({
        messages: normalizeMessages(opts.messages),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
      return {
        content: resp.content ?? undefined,
        model: client.getModel(),
        ...(resp.usage ? { metadata: { usage: resp.usage } } : {}),
      };
    },
  };
}
