import * as fs from 'fs';

interface CachedLog { signature: string; inode: string; size: number; offset: number; guard: Buffer; events: any[]; bytes: number; }
const logs = new Map<string, CachedLog>();
const CACHE_BYTES = 8 * 1024 * 1024;
const fields = (value: any, keys: string[]) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const usageFields = 'model responseModel modelDisplayName isAuto reasoningEffort contextTier initiator inputTokens outputTokens cacheReadTokens cacheWriteTokens reasoningTokens duration timeToFirstTokenMs interTokenLatencyMs finishReason maxPromptTokens cacheExpiresAt cacheTtlSeconds toolTokenCount availableToolCount isByok cost aiCreditsStatus accounting apiCallId serviceRequestId copilotUsage provider'.split(' ');

/** Cache billing and display metadata, never tool results, attachments or model prompts. */
function project(event: any): any {
    if (!event || typeof event.type !== 'string') { return undefined; }
    const d = event.data ?? {};
    let data: any = {};
    switch (event.type) {
        case 'user.message': data = { ...fields(d, ['parentToolCallId', 'source']), content: typeof d.content === 'string' ? d.content.slice(0, 128) : '' }; break;
        case 'assistant.message': data = { ...fields(d, ['turnId','apiCallId']), toolRequests: Array.isArray(d.toolRequests) ? d.toolRequests.map((t:any)=>({toolCallId:t.toolCallId})) : [] }; break;
        case 'tool.execution_start': {
            data = fields(d, ['toolName','toolTitle','toolCallId','turnId']);
            data.arguments = fields(d.arguments, ['command','filePath','path','pattern','query','description']);
            for (const key of Object.keys(data.arguments)) { if (typeof data.arguments[key] === 'string') { data.arguments[key] = data.arguments[key].slice(0, 512); } }
            break;
        }
        case 'tool.execution_complete': data = fields(d, ['toolCallId','success']); break;
        case 'session.usage_record': data = { usage: d.usage && fields(d.usage, usageFields) }; break;
        case 'assistant.usage': data = fields(d, usageFields); break;
        case 'session.compaction_complete': data = { success: d.success, compactionTokensUsed: d.compactionTokensUsed && fields(d.compactionTokensUsed, usageFields) }; break;
        case 'session.shutdown': case 'session.usage_checkpoint':
            data = fields(d, ['totalNanoAiu','totalPremiumRequests','totalPremiumRequestCost','totalApiDurationMs','codeChanges','modelMetrics','agentMetrics']);
            if (d.accountingSnapshot) { data.accountingSnapshot = fields(d.accountingSnapshot, ['totalNanoAiu','aiCreditsStatus','tokenDetails','modelMetrics','agentMetrics','codeChanges']); }
            break;
        default:
            if (event.type.startsWith('model.')) {
                data = fields(d, ['model','purpose','modelCallDurationMs','usage']);
                data.modelCall = fields(d.modelCall, ['model','purpose','retry_attempt','usage']);
                if (d.responseChunk?.usage) { data.responseChunk = { usage: fields(d.responseChunk.usage, ['prompt_tokens','completion_tokens','prompt_tokens_details','completion_tokens_details']) }; }
                data.modelInfo = { billing: d.modelInfo?.billing };
                if (d.requestMessages) {
                    try {
                        const messages = typeof d.requestMessages === 'string' ? JSON.parse(d.requestMessages) : d.requestMessages;
                        if (Array.isArray(messages) && messages.some((m:any)=>m.role==='system' && typeof m.content==='string' && /^(You judge one proposed developer-tool action\.|You are the permission judge\b)/.test(m.content))) { data.purpose = 'permission'; }
                    } catch {}
                }
            } else {
                data = fields(d, 'selectedModel autoTier reasoningEffort contextTier title turnId chosenModel selectionReason categoryScores candidateModels availableModels routingMethod fallback endToEndLatencyMs toolCallId agentName agentDisplayName agentType model modelSelectionSource executionMode durationMs totalToolCalls totalTokens firstDispatchedModel newModel source hookInvocationId'.split(' '));
            }
    }
    return { ...fields(event, ['type','id','timestamp','parentId','agentId']), data };
}

/** Reuse complete lines; a torn last line stays outside the cache until it completes. */
export function readUsageEvents(file: string, onValue: (value: any) => void): void {
    const stat = fs.statSync(file, { bigint: true });
    const inode = `${stat.dev}:${stat.ino}`, size = Number(stat.size), signature = `${inode}:${size}:${stat.mtimeNs}`;
    let cached = logs.get(file);
    logs.delete(file); // LRU ordering
    if (cached?.signature === signature && cached.offset === size) {
        logs.set(file, cached); cached.events.forEach(onValue); return;
    }
    const fd = fs.openSync(file, 'r');
    const readGuard = (offset: number) => { const b = Buffer.alloc(Math.min(64, offset)); fs.readSync(fd, b, 0, b.length, offset-b.length); return b; };
    try {
        const appended = cached && inode === cached.inode && (size > cached.size || signature === cached.signature) && cached.offset <= size && readGuard(cached.offset).equals(cached.guard);
        if (!appended) { cached = { signature, inode, size, offset: 0, guard: Buffer.alloc(0), events: [], bytes: 0 }; }
        cached!.events.forEach(onValue);
        const chunk = Buffer.alloc(64 * 1024);
        let position = cached!.offset, lineStart = position, parts: Buffer[] = [], cacheable = true;
        const consume = (line: Buffer, complete: boolean) => {
            let value: any; try { value = project(JSON.parse(line.toString('utf8'))); } catch { return; }
            if (!value) { return; }
            onValue(value);
            if (complete && cacheable) {
                cached!.bytes += Buffer.byteLength(JSON.stringify(value));
                if (cached!.bytes > CACHE_BYTES) { cacheable = false; cached!.events = []; }
                else { cached!.events.push(value); }
            }
        };
        while (position < size) {
            const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size-position), position);
            if (!count) { break; }
            let start = 0, end: number;
            while ((end = chunk.indexOf(10, start)) >= 0 && end < count) {
                const part = chunk.subarray(start, end);
                consume(parts.length ? Buffer.concat([...parts, part]) : part, true);
                parts = []; start = end + 1; lineStart = position + start;
            }
            if (start < count) { parts.push(Buffer.from(chunk.subarray(start, count))); }
            position += count;
        }
        if (parts.length) { consume(Buffer.concat(parts), false); }
        cached!.offset = lineStart; cached!.guard = readGuard(lineStart); cached!.signature = signature; cached!.size = size;
        if (cacheable) {
            logs.set(file, cached!);
            let total = [...logs.values()].reduce((n,c)=>n+c.bytes,0);
            while (logs.size > 16 || total > CACHE_BYTES) { const key = logs.keys().next().value!; total -= logs.get(key)!.bytes; logs.delete(key); }
        }
    } finally { fs.closeSync(fd); }
}
