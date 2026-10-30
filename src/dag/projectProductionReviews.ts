import {
  readProductionReview,
  recordProductionReview,
  type ReviewScope,
  type RecordProductionReviewInput,
} from './productionReviews.js';
import { resolveProjectProductionReviewScope } from './walker.js';
export async function readProjectProductionReview(input: ReviewScope) {
  try {
    const scope = await resolveProjectProductionReviewScope(input);
    return { ...(await readProductionReview(scope)), authoritative: true as const };
  } catch (error) {
    return {
      status: 'unavailable' as const,
      authoritative: true as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
export async function recordProjectProductionReview(input: RecordProductionReviewInput) {
  const scope = await resolveProjectProductionReviewScope(input);
  return {
    ...(await recordProductionReview({ ...input, ...scope }, () =>
      resolveProjectProductionReviewScope(input)
    )),
    authoritative: true as const,
  };
}
