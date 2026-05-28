import type { ModelItem } from "../../../api/statistics";

export interface ModelRates {
  input: number;      // per token in USD
  cached: number;     // per token in USD
  output: number;     // per token in USD
}

// Pricing per 1M tokens in USD.
//
// NOTE: This table is the fallback used when an agent doesn't report
// `cost_amount` directly. Keep model keys SPECIFIC-FIRST — matching is
// substring-based and we sort by key length descending below, so listing
// "claude-3-5-sonnet" before "claude-3-sonnet" ensures the more-specific
// price wins. New models need to be added explicitly; otherwise they fall
// to DEFAULT_RATES (which under-estimates real costs).
const PRICING_PER_MILLION: Record<string, ModelRates> = {
  // Anthropic — current generation
  "claude-opus-4-7": { input: 15.00, cached: 1.50, output: 75.00 },
  "claude-opus-4-6": { input: 15.00, cached: 1.50, output: 75.00 },
  "claude-opus-4": { input: 15.00, cached: 1.50, output: 75.00 },
  "claude-sonnet-4-6": { input: 3.00, cached: 0.30, output: 15.00 },
  "claude-sonnet-4-5": { input: 3.00, cached: 0.30, output: 15.00 },
  "claude-sonnet-4": { input: 3.00, cached: 0.30, output: 15.00 },
  "claude-haiku-4-5": { input: 1.00, cached: 0.10, output: 5.00 },
  "claude-haiku-4": { input: 1.00, cached: 0.10, output: 5.00 },
  "claude-3-7-sonnet": { input: 3.00, cached: 0.30, output: 15.00 },
  "claude-3-5-sonnet": { input: 3.00, cached: 0.30, output: 15.00 },
  "claude-3-5-haiku": { input: 0.80, cached: 0.08, output: 4.00 },
  "claude-3-opus": { input: 15.00, cached: 1.50, output: 75.00 },
  "claude-3-haiku": { input: 0.25, cached: 0.03, output: 1.25 },
  // Google Gemini
  "gemini-2.5-pro": { input: 1.25, cached: 0.3125, output: 10.00 },
  "gemini-2.5-flash": { input: 0.30, cached: 0.075, output: 2.50 },
  "gemini-1.5-pro": { input: 1.25, cached: 0.3125, output: 5.00 },
  "gemini-1.5-flash": { input: 0.075, cached: 0.01875, output: 0.30 },
  // OpenAI — current generation
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2.00 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10.00 },
  "gpt-4.1-mini": { input: 0.40, cached: 0.10, output: 1.60 },
  "gpt-4.1": { input: 2.00, cached: 0.50, output: 8.00 },
  "gpt-4o-mini": { input: 0.150, cached: 0.075, output: 0.60 },
  "gpt-4o": { input: 2.50, cached: 1.25, output: 10.00 },
  "o3-mini": { input: 1.10, cached: 0.55, output: 4.40 },
  "o3": { input: 2.00, cached: 0.50, output: 8.00 },
  "o1-mini": { input: 3.00, cached: 0.50, output: 12.00 },
  "o1": { input: 15.00, cached: 7.50, output: 60.00 },
  // DeepSeek
  "deepseek-chat": { input: 0.14, cached: 0.014, output: 0.28 },
  "deepseek-coder": { input: 0.14, cached: 0.014, output: 0.28 },
};

// Sort keys by length descending so substring matching prefers the most
// specific entry — without this, `gpt-4o-mini` would match `gpt-4o` first
// (16× over-estimate on mini's cost) and `claude-sonnet-4-5` would match
// `claude-sonnet-4` first, etc.
const PRICING_KEYS_BY_LENGTH = Object.keys(PRICING_PER_MILLION).sort(
  (a, b) => b.length - a.length,
);

const DEFAULT_RATES: ModelRates = {
  input: 1.50 / 1_000_000,
  cached: 0.375 / 1_000_000,
  output: 6.00 / 1_000_000,
};

export function getModelRates(modelName: string): ModelRates {
  const name = modelName.toLowerCase();
  for (const key of PRICING_KEYS_BY_LENGTH) {
    if (name.includes(key)) {
      const rates = PRICING_PER_MILLION[key];
      return {
        input: rates.input / 1_000_000,
        cached: rates.cached / 1_000_000,
        output: rates.output / 1_000_000,
      };
    }
  }
  return DEFAULT_RATES;
}

export interface AverageRates {
  input: number;
  cached: number;
  output: number;
  total: number;
}

export function computeAverageRates(models: ModelItem[]): AverageRates {
  if (models.length === 0) {
    return {
      input: DEFAULT_RATES.input,
      cached: DEFAULT_RATES.cached,
      output: DEFAULT_RATES.output,
      // Mean of the three component rates — better than picking just `input`,
      // since AgentShare uses `tokens * averageRates.total` for the cost
      // estimate of agents that didn't report a cost.
      total: (DEFAULT_RATES.input + DEFAULT_RATES.cached + DEFAULT_RATES.output) / 3,
    };
  }

  let total_cost = 0;
  let total_tokens = 0;

  let total_input_tokens = 0;
  let total_input_cost = 0;

  let total_cached_tokens = 0;
  let total_cached_cost = 0;

  let total_output_tokens = 0;
  let total_output_cost = 0;

  for (const m of models) {
    const rates = getModelRates(m.model || m.agent);
    const cost_in = m.input_tokens * rates.input;
    const cost_cached = m.cached_tokens * rates.cached;
    const cost_out = m.output_tokens * rates.output;

    total_input_tokens += m.input_tokens;
    total_input_cost += cost_in;

    total_cached_tokens += m.cached_tokens;
    total_cached_cost += cost_cached;

    total_output_tokens += m.output_tokens;
    total_output_cost += cost_out;

    total_cost += cost_in + cost_cached + cost_out;
    total_tokens += m.input_tokens + m.cached_tokens + m.output_tokens;
  }

  return {
    input: total_input_tokens > 0 ? total_input_cost / total_input_tokens : DEFAULT_RATES.input,
    cached: total_cached_tokens > 0 ? total_cached_cost / total_cached_tokens : DEFAULT_RATES.cached,
    output: total_output_tokens > 0 ? total_output_cost / total_output_tokens : DEFAULT_RATES.output,
    total: total_tokens > 0
      ? total_cost / total_tokens
      : (DEFAULT_RATES.input + DEFAULT_RATES.cached + DEFAULT_RATES.output) / 3,
  };
}
