export type ModelId = string;

export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'gpt-5.2': { input: 1.75, output: 14.00 },
};

/**
 * Computes the USD cost for a given model and token counts.
 * Prices are per 1,000,000 tokens.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const costs = MODEL_COSTS[model];
  if (!costs) {
    console.warn(`ai-costs: unknown model "${model}", cost recorded as 0`);
    return 0;
  }
  return (inputTokens / 1_000_000) * costs.input +
         (outputTokens / 1_000_000) * costs.output;
}

/**
 * Convenience wrapper: computes cost and inserts a token_usage row.
 * Prefer this over calling insertTokenUsage directly.
 */
export async function recordTokenUsage(
  supabase: any,
  data: {
    project_id: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    endpoint: string;
    conversation_id?: string;
    visitor_id?: string;
    session_id?: string;
    metadata?: Record<string, any>;
  }
): Promise<boolean> {
  const cost_usd = computeCostUsd(data.model, data.input_tokens, data.output_tokens);
  try {
    const { error } = await supabase.from('token_usage').insert({
      project_id: data.project_id,
      conversation_id: data.conversation_id ?? null,
      visitor_id: data.visitor_id ?? null,
      session_id: data.session_id ?? null,
      input_tokens: data.input_tokens,
      output_tokens: data.output_tokens,
      model: data.model,
      cost_usd,
      endpoint: data.endpoint,
      metadata: data.metadata ?? null,
    });
    if (error) {
      console.error('ai-costs: recordTokenUsage insert error', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('ai-costs: recordTokenUsage unexpected error', err);
    return false;
  }
}
