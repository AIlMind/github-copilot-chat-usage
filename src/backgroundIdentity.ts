import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { databaseSignature, withDatabaseSnapshot, filePathKey } from './sqliteSnapshot';

interface AgentIdentity { hasUsage?: boolean; sdkSessionId?: string; workspace?: string; workspaces?: string[]; workspaceless?: boolean; selectedModel?: string; autoTier?: string; title?: string; }
const identityCache = new Map<string, { signature: string; identity: AgentIdentity }>();

let identityDirectory: string | undefined;
export function configureIdentityCache(storagePath?: string): void {
    identityDirectory = storagePath ? path.join(storagePath, 'agent-identities-v2') : undefined;
}

function safeId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
}

/** VS Code session/chat ids and Copilot SDK ids are separate identities. */
function agentIdentity(file: string): AgentIdentity {
    const key = databaseSignature(file);
    const cached = identityCache.get(filePathKey(file));
    if (cached?.signature === key) { return cached.identity; }
    const diskFile = identityDirectory && path.join(identityDirectory, createHash('sha256').update(filePathKey(file)).digest('hex') + '.json');
    if (diskFile) {
        try {
            const saved = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
            if (saved.signature === key && saved.identity && typeof saved.identity === 'object') {
                identityCache.set(filePathKey(file), saved); return saved.identity;
            }
        } catch { /* Cache is optional. */ }
    }
    const identity: AgentIdentity = {};
    try {
        withDatabaseSnapshot(file, db => {
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='turn_usage'").get()) { identity.hasUsage = !!db.prepare('SELECT 1 FROM turn_usage LIMIT 1').get(); }
            else { identity.hasUsage = false; }
            const columns = db.prepare('PRAGMA table_info(session_metadata)').all();
            if (!columns.length) { return; } // Valid provider stores can have no identity table.
            const scoped = columns.some((c: any) => c.name === 'turn_id') ? ' AND turn_id IS NULL' : '';
            const rows = db.prepare(`SELECT key, value FROM session_metadata WHERE key IN ('defaultChatProviderData', 'copilot.workingDirectory', 'copilot.workingDirectories', 'agentHost.workspaceless', 'copilot.model', 'customTitle')${scoped}`).all();
            for (const row of rows) {
                let value: any;
                try { value = JSON.parse(row.value); } catch { value = row.value; }
                if (row.key === 'defaultChatProviderData' && safeId(value?.sdkSessionId)) { identity.sdkSessionId = value.sdkSessionId; }
                if (row.key === 'copilot.workingDirectory' && typeof value === 'string') { identity.workspace = value; }
                if (row.key === 'copilot.workingDirectories' && Array.isArray(value)) { identity.workspaces = value.filter(v => typeof v === 'string'); }
                if (row.key === 'agentHost.workspaceless') { identity.workspaceless = value === true; }
                if (row.key === 'copilot.model') { identity.selectedModel = typeof value === 'string' ? value : value?.id; identity.autoTier = value?.config?.tier; }
                if (row.key === 'customTitle' && typeof value === 'string') { identity.title = value; }
            }
        });
    } catch { return identity; /* Retry unreadable/changing stores on the next scan. */ }
    // Do not cache an identity against a signature that changed during the snapshot.
    if (databaseSignature(file) !== key) { return identity; }
    const saved = { signature: key, identity };
    identityCache.set(filePathKey(file), saved);
    if (diskFile) {
        const temp = `${diskFile}.${randomUUID()}.tmp`;
        try { fs.mkdirSync(identityDirectory!, { recursive: true }); fs.writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 }); fs.renameSync(temp, diskFile); }
        catch { /* Another window can still discover this store independently. */ }
        finally { try { fs.rmSync(temp, { force: true }); } catch {} }
    }
    return identity;
}

let deferIndex = false;
/** First paint resolves a few recent stores without scanning the entire history. */
export function withoutFullBackgroundIndex<T>(read: () => T): T {
    const previous = deferIndex; deferIndex = true;
    try { return read(); } finally { deferIndex = previous; }
}
let indexRoots = '';
let indexExpiresAt = 0;
let sdkIndex = new Map<string, string>();

/** One O(N) pass, including negative identities, instead of N full folder scans. */
export function prepareBackgroundIndex(agentRoots: string[], force = true): void {
    if (deferIndex) { return; }
    const roots = JSON.stringify(agentRoots.map(r => filePathKey(r)));
    if (!force && indexRoots === roots && indexExpiresAt > Date.now()) { return; }
    const next = new Map<string, string>();
    const present = new Set<string>();
    for (const root of agentRoots) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (!entry.isDirectory()) { continue; }
            const file = path.join(root, entry.name, 'session.db');
            if (!fs.existsSync(file)) { continue; }
            present.add(filePathKey(file));
            const id = agentIdentity(file).sdkSessionId;
            if (id && !next.has(id)) { next.set(id, file); }
        }
    }
    // Prune removed stores, not the first 1,024 identities in a larger live history.
    for (const file of identityCache.keys()) { if (!present.has(file)) { identityCache.delete(file); } }
    sdkIndex = next;
    indexRoots = roots;
    indexExpiresAt = Date.now() + 30_000;
}

export interface BackgroundFiles {
    hasSavedUsage?: boolean;
    sessionId: string;
    ownerSessionId: string;
    dbFile?: string;
    eventsFile?: string;
    dirs: string[];
    workspace?: string;
    workspaces?: string[];
    workspaceless?: boolean;
    selectedModel?: string;
    autoTier?: string;
    title?: string;
}

export function resolveBackgroundFiles(file: string, cliRoots: string[], agentRoots: string[]): BackgroundFiles {
    const ownerSessionId = path.basename(path.dirname(file));
    let dbFile = path.basename(file) === 'session.db' ? file : undefined;
    let identity: AgentIdentity = dbFile ? agentIdentity(dbFile) : {};
    if (!identity.sdkSessionId) {
        prepareBackgroundIndex(agentRoots, false);
        const matched = indexRoots === JSON.stringify(agentRoots.map(r => filePathKey(r))) ? sdkIndex.get(ownerSessionId) : undefined;
        if (matched) { dbFile = matched; identity = agentIdentity(matched); }
        dbFile ??= [path.join(path.dirname(file), 'session.db'), ...agentRoots.map(root => path.join(root, ownerSessionId, 'session.db'))].find(fs.existsSync);
    }
    if (dbFile && !identity.sdkSessionId) { identity = agentIdentity(dbFile); }
    const sessionId = identity.sdkSessionId ?? ownerSessionId;
    const dirs = [...new Set([
        path.dirname(file), ...(dbFile ? [path.dirname(dbFile)] : []),
        ...cliRoots.flatMap(root => [...new Set([sessionId, ownerSessionId])].map(id => path.join(root, id))),
    ])];
    const eventsFile = path.basename(file) === 'events.jsonl' ? file : dirs.map(dir => path.join(dir, 'events.jsonl')).find(fs.existsSync);
    return { hasSavedUsage: identity.hasUsage, sessionId, ownerSessionId: dbFile ? path.basename(path.dirname(dbFile)) : ownerSessionId, dbFile, eventsFile, dirs, workspace: identity.workspace ?? identity.workspaces?.[0], workspaces: identity.workspaces, workspaceless: identity.workspaceless, selectedModel: identity.selectedModel, autoTier: identity.autoTier, title: identity.title };
}
