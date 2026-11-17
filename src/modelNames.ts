import type { ModelTurnSummary, SessionSummary } from './parser';

export function stripModelProvider(value: string): string {
    return value.trim().replace(/^@provider-[^:]+:/i, '').replace(/^copilot\//i, '');
}
export function canonicalModelId(value: string): string {
    return stripModelProvider(value).toLowerCase().replace(/\s+/g, '-') || 'unknown-model';
}

export function fallbackModelLabel(value: string): string {
    const clean = stripModelProvider(value);
    if (!clean.includes('-')) { return clean || 'Unknown model'; }
    return clean.split('-').map(part => /^(gpt|oai|ai)$/i.test(part) ? part.toUpperCase() : /^\d/.test(part) ? part : part.charAt(0).toUpperCase()+part.slice(1)).join(' ').replace(/^GPT (\d)/, 'GPT-$1');
}

/** Learn aliases before aggregation so scan order cannot split a model into two rows. */
export class ModelNames {
    private readonly aliases = new Map<string, Set<string>>();
    private readonly labels = new Map<string, string>();
    learn(model: string, displayName?: string): void {
        if (!displayName?.trim()) { return; }
        const id = canonicalModelId(model), alias = canonicalModelId(displayName);
        const ids = this.aliases.get(alias) ?? new Set<string>(); ids.add(id); this.aliases.set(alias, ids);
        this.labels.set(id, displayName.trim());
    }
    resolve(model: string): { key: string; label: string } {
        const raw = canonicalModelId(model), aliases = this.aliases.get(raw);
        const key = aliases?.size === 1 ? [...aliases][0] : raw;
        return { key, label: this.labels.get(key) ?? fallbackModelLabel(model) };
    }
}

export function modelLabel(turn: Pick<ModelTurnSummary, 'model' | 'modelDisplayName'>): string {
    return turn.modelDisplayName || fallbackModelLabel(turn.model);
}

export function modelSequence(turns: ModelTurnSummary[]): string {
    const labels: string[] = [];
    for (const t of [...turns].sort((a,b)=>a.timestamp-b.timestamp)) {
        const label = modelLabel(t);
        if (labels[labels.length - 1] !== label) { labels.push(label); }
    }
    return labels.join(' → ');
}

export function modelCostMix(turns: ModelTurnSummary[]): string {
    const names = new ModelNames(); turns.forEach(t => names.learn(t.model, t.modelDisplayName));
    const totals = new Map<string, { label: string; cost: number }>();
    for (const t of turns) {
        const model = names.resolve(t.model), existing = totals.get(model.key) ?? { label: model.label, cost: 0 };
        existing.cost += t.nanoAiu; totals.set(model.key, existing);
    }
    const total = [...totals.values()].reduce((n,m)=>n+m.cost,0);
    return [...totals.values()].sort((a,b)=>b.cost-a.cost).map(m => `${m.label}${total > 0 ? ` ${(m.cost / total * 100).toFixed(0)}%` : ''}`).join(' · ');
}

/** Debug subagents have separate summaries; SDK subagent calls are already inline. */
export function sessionModelTurns(summary: SessionSummary): ModelTurnSummary[] {
    return summary.userMessages.flatMap(m => m.modelTurns.flatMap(t => [t, ...t.toolCalls.flatMap(tool => tool.subagentSummary ? sessionModelTurns(tool.subagentSummary) : [])]));
}
