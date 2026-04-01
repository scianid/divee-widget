import { computeCostUsd } from '../ai-costs.ts';

export type TokenUsageData = {
  projectId: string;
  conversationId?: string;
  visitorId?: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  endpoint: 'chat' | 'suggestions';
  metadata?: Record<string, any>;
};

/**
 * Records token usage to the database
 */
export async function insertTokenUsage(
  supabase: any,
  data: TokenUsageData
): Promise<boolean> {
  try {
    console.log('tokenUsageDao: attempting insert', {
      projectId: data.projectId,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      endpoint: data.endpoint
    });

    const cost_usd = computeCostUsd(data.model, data.inputTokens, data.outputTokens);

    const { error } = await supabase
      .from('token_usage')
      .insert({
        project_id: data.projectId,
        conversation_id: data.conversationId || null,
        visitor_id: data.visitorId || null,
        session_id: data.sessionId || null,
        input_tokens: data.inputTokens,
        output_tokens: data.outputTokens,
        model: data.model,
        cost_usd,
        endpoint: data.endpoint,
        metadata: data.metadata || null
      });

    if (error) {
      console.error('tokenUsageDao: insert error', error);
      return false;
    }

    console.log('tokenUsageDao: ✓ usage recorded', {
      projectId: data.projectId,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      total: data.inputTokens + data.outputTokens
    });

    return true;
  } catch (error) {
    console.error('tokenUsageDao: unexpected error', error);
    return false;
  }
}

/**
 * Get daily token usage summary for a project within a date range
 */
export async function getTokenUsageSummary(
  supabase: any,
  projectId: string,
  startDate?: string,
  endDate?: string
) {
  try {
    let query = supabase
      .from('token_usage_daily')
      .select('*')
      .eq('project_id', projectId);

    if (startDate) {
      query = query.gte('usage_date', startDate);
    }
    if (endDate) {
      query = query.lte('usage_date', endDate);
    }

    const { data, error } = await query.order('usage_date', { ascending: false });

    if (error) {
      console.error('tokenUsageDao: summary query error', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('tokenUsageDao: unexpected error in summary', error);
    return null;
  }
}
