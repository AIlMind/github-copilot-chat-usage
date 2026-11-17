import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface DiscoveryOptions {
    storagePath?: string;
    globalStoragePath?: string;
    searchRoots?: string[];
    maxDepth?: number;
    home?: string;
    env?: NodeJS.ProcessEnv;
    defaults?: boolean;
}

export interface UsageDirectories {
    debug: string[];
    chat: string[];
    cli: string[];
    agent: string[];
}

function directories(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
    } catch { return []; }
}

/** Probe known storage layouts; never recursively crawl a user's home by default. */
export function discoverUsageDirectories(options: DiscoveryOptions = {}): UsageDirectories {
    const result: UsageDirectories = { debug: [], chat: [], cli: [], agent: [] };
    const seen = new Set<string>();
    const env = options.env ?? process.env;
    const home = options.home ?? os.homedir();
    const add = (kind: keyof UsageDirectories, dir: string) => {
        try {
            if (!fs.statSync(dir).isDirectory()) { return; }
            const real = fs.realpathSync.native(dir);
            const key = `${kind}:${process.platform === 'win32' ? real.toLowerCase() : real}`;
            if (!seen.has(key)) { seen.add(key); result[kind].push(real); }
        } catch { /* Missing and unreadable stores are normal. */ }
    };
    const probeExtension = (base: string) => {
        // Extension ids on disk differ in case between workspace and global storage.
        for (const dir of directories(base)) {
            if (path.basename(dir).toLowerCase() === 'github.copilot-chat') { add('debug', path.join(dir, 'debug-logs')); }
        }
    };
    const probeUser = (user: string, profiles = true) => {
        for (const workspace of directories(path.join(user, 'workspaceStorage'))) {
            add('chat', path.join(workspace, 'chatSessions'));
            probeExtension(workspace);
        }
        add('chat', path.join(user, 'globalStorage', 'emptyWindowChatSessions'));
        probeExtension(path.join(user, 'globalStorage'));
        add('agent', path.join(path.dirname(user), 'agentSessionData'));
        if (profiles) {
            for (const profile of directories(path.join(user, 'profiles'))) { probeUser(profile, false); }
        }
    };
    if (options.defaults !== false) {
        const configBases = [env.APPDATA, path.join(home, 'Library', 'Application Support'), env.XDG_CONFIG_HOME || path.join(home, '.config')];
        for (const base of configBases) {
            if (!base) { continue; }
            for (const product of ['Code', 'Code - Insiders', 'Code - OSS', 'VSCodium', 'Cursor']) { probeUser(path.join(base, product, 'User')); }
        }
        for (const product of ['.vscode-server', '.vscode-server-insiders']) { probeUser(path.join(home, product, 'data', 'User')); }
        add('cli', path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'session-state'));
    }
    const probeContextUser = (user: string) => {
        probeUser(user);
        if (path.basename(path.dirname(user)) === 'profiles') { probeUser(path.dirname(path.dirname(user))); }
    };
    if (options.storagePath) {
        const workspace = path.dirname(options.storagePath);
        probeExtension(workspace);
        add('chat', path.join(workspace, 'chatSessions'));
        probeContextUser(path.dirname(path.dirname(workspace)));
    }
    if (options.globalStoragePath) { probeContextUser(path.dirname(path.dirname(options.globalStoragePath))); }

    const visit = (dir: string, depth: number) => {
        const base = path.basename(dir);
        const kind = ({ 'debug-logs': 'debug', chatSessions: 'chat', emptyWindowChatSessions: 'chat', 'session-state': 'cli', agentSessionData: 'agent' } as const)[base];
        if (kind) { add(kind, dir); return; }
        if (depth <= 0) { return; }
        for (const child of directories(dir)) {
            if (!['node_modules', '.git', 'Cache', 'CachedData', 'logs'].includes(path.basename(child))) { visit(child, depth - 1); }
        }
    };
    for (const root of options.searchRoots ?? []) { visit(root, options.maxDepth ?? 6); }
    return result;
}
