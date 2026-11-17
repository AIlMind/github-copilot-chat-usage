import type { ModelTurnSummary } from './parser';

export interface RoutingDecision {
    timestamp: number;
    owner?: string;
    agentId?: string;
    chosenModel?: string;
    tier?: string;
    reason?: string;
    scores?: Record<string, number>;
    candidates: string[];
    latencyMs?: number;
    method?: string;
    availableModels?: string[];
    fallback?: boolean;
}
export interface ModelSelection { timestamp: number; model: string; agentId?: string; owner?: string; source: string; reasoningEffort?: string; contextTier?: string; autoTier?: string; }
export interface AgentDetails {
    id: string;
    owner?: string;
    name: string;
    type?: string;
    model?: string;
    modelSelectionSource?: string;
    startedAt?: number;
    durationMs?: number;
    toolCalls?: number;
    tokens?: number;
    completed?: boolean;
    reasoningEffort?: string;
    contextTier?: string;
}
export interface PermissionCheck {
    id: string;
    owner?: string;
    timestamp: number;
    model: string;
    durationMs?: number;
    failed: boolean;
    retry: boolean;
    listedFree?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
}
export interface CatalogPrice {
    timestamp: number;
    model: string;
    contextMax?: number;
    rates: Record<string, number | undefined>; // nano-AIU per token
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** VS Code agentModelPricing.ts: tiered/SDK prices are AIC; legacy flat snake_case is nano-AIU. */
export function catalogPrices(model: string, timestamp: number, billing: any): CatalogPrice[] {
    const raw = billing?.tokenPrices ?? billing?.token_prices;
    if (!raw || typeof raw !== 'object') { return []; }
    const batch = raw.batchSize ?? raw.batch_size ?? 1_000_000;
    if (!finite(batch) || batch <= 0) { return []; }
    const result: CatalogPrice[] = [];
    for (const [tier, legacy] of [[raw.default ?? raw, !raw.default], [raw.longContext ?? raw.long_context, false]] as const) {
        if (!tier || typeof tier !== 'object') { continue; }
        const value = (camel: string[], snake: string[]): number | undefined => {
            const c = camel.map(k => tier[k]).find(finite);
            if (c !== undefined) { return c * 1e9 / batch; }
            const s = snake.map(k => tier[k]).find(finite);
            return s === undefined ? undefined : s * (legacy ? 1 : 1e9) / batch;
        };
        result.push({ model, timestamp, contextMax: tier.maxPromptTokens ?? tier.contextMax ?? tier.max_prompt_tokens ?? tier.context_max,
            rates: { input: value(['inputPrice'], ['input_price']), cache_read: value(['cacheReadPrice', 'cachePrice'], ['cache_read_price', 'cache_price']), cache_write: value(['cacheWritePrice'], ['cache_write_price']), output: value(['outputPrice'], ['output_price']) } });
    }
    return result;
}

/** Cache lifetime is recorded per call; it does not alter billed credits. */
export function applyPricingDiagnostics(calls: ModelTurnSummary[], _catalog: CatalogPrice[]): void {
    const previousExpiry = new Map<string, number>();
    for (const call of [...calls].sort((a, b) => a.timestamp - b.timestamp)) {
        const key = `${call.agentId ?? 'main'}:${call.model}`;
        const previous = previousExpiry.get(key);
        if (previous !== undefined && call.timestamp >= previous) { call.cachePreviouslyExpired = true; }
        const expiry = Date.parse(call.cacheExpiresAt ?? '');
        if (Number.isFinite(expiry)) { previousExpiry.set(key, expiry); }
    }
}
