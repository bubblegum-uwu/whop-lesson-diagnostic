import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

export interface CreateUsageRecordInput {
  analysisId: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  videoDurationSeconds: number | null;
  estimatedCost: number | null;
  pricingVersion: string;
  processingDurationSeconds: number | null;
}

export async function createUsageRecord(db: Queryable, input: CreateUsageRecordInput): Promise<void> {
  await db.query(
    `INSERT INTO usage_records (
       analysis_id, model, input_tokens, output_tokens, thinking_tokens,
       video_duration_seconds, estimated_cost, pricing_version, processing_duration_seconds
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.analysisId,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.thinkingTokens,
      input.videoDurationSeconds,
      input.estimatedCost,
      input.pricingVersion,
      input.processingDurationSeconds,
    ],
  );
}
