const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { prepareBackgroundIndex, resolveBackgroundFiles } = require('../out/backgroundIdentity');
const { computeSpendSummaryFromChatSessionDirs, usageFileSignature } = require('../out/spend');
const { withDatabaseSnapshot } = require('../out/sqliteSnapshot');
const { UsageClient } = require('../out/usageClient');
function temporary(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-perf-')); t.after(() => fs.rmSync(p, { force: true, recursive: true })); return p; }
function create(file, id) {
 fs.mkdirSync(path.dirname(file), { recursive: true });
 const db = new DatabaseSync(file);
 db.exec('CREATE TABLE session_metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE turn_usage(turn_id TEXT PRIMARY KEY,usage TEXT)');
 if (id) { db.prepare('INSERT INTO session_metadata VALUES (?,?)').run('defaultChatProviderData', JSON.stringify({sdkSessionId:id})); }
 return db;
}
function source(file, id) { return {file, dir:path.dirname(file), kind:'background', sessionId:id, workspaceKey:'test', workspaceLabel:'Test'}; }
function fingerprint(file) {
 return ['', '-wal', '-shm'].map(suffix => {
  try { const f = file + suffix, s = fs.statSync(f, {bigint:true}); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`; }
  catch (error) { if(error.code === 'ENOENT') return 'missing'; throw error; }
 });
}

test('2,204 stores: one linear identity scan, negative hits cached, warm spend performs no SQLite copies', async t => {
 const root=temporary(t), agents=path.join(root,'agentSessionData');
 const template=path.join(root,'template.db'); create(template).close();
 const files=[];
 for(let i=0;i<2204;i++) {
  const file=path.join(agents,`owner-${i}`,'session.db'); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.copyFileSync(template,file);
  if(i<261) {const db=new DatabaseSync(file);db.prepare('INSERT INTO session_metadata VALUES (?,?)').run('defaultChatProviderData',JSON.stringify({sdkSessionId:`sdk-${i}`}));db.close();}
  files.push(source(file,i<261?`sdk-${i}`:`owner-${i}`));
 }
 const copy=fs.copyFileSync, readDir=fs.readdirSync;
 let copies=0, folders=0;
 fs.copyFileSync=(...args)=>{if(args[0].endsWith('/session.db'))copies++;return copy(...args);};
 fs.readdirSync=(...args)=>{if(args[0]===agents)folders++;return readDir(...args);};
 try {
  let start=performance.now();prepareBackgroundIndex([agents]);
  for(const f of files)assert.equal(resolveBackgroundFiles(f.file,[],[agents]).sessionId,f.sessionId);
  assert.equal(copies,0);assert.equal(folders,1);
  const coldIndexMs=performance.now()-start;
  copies=0;folders=0;start=performance.now();prepareBackgroundIndex([agents]);
  for(const f of files)assert.equal(resolveBackgroundFiles(f.file,[],[agents]).sessionId,f.sessionId);
  assert.equal(copies,0);assert.equal(folders,1);
  const warmIndexMs=performance.now()-start;
  const options={agentRoots:[agents],usageFiles:files,cacheFilePath:path.join(root,'cache.json')};
  start=performance.now(); const cold=computeSpendSummaryFromChatSessionDirs('full',[],options); const coldSpendMs=performance.now()-start;
  copies=0;start=performance.now();const warm=computeSpendSummaryFromChatSessionDirs('full',[],options);const warmSpendMs=performance.now()-start;
  assert.equal(copies,0);assert.deepEqual(warm.today,cold.today);assert.equal(warm.scannedFiles,2204);
  t.diagnostic(JSON.stringify({coldIndexMs,warmIndexMs,coldSpendMs,warmSpendMs}));
 } finally {fs.copyFileSync=copy;fs.readdirSync=readDir;}
 const client=new UsageClient({defaults:false,searchRoots:[agents]});
 let ticks=0,maxGap=0,last=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},5);
 try {
  const start=performance.now();const result=await client.request('list');
  assert.equal(result.sessions.length,0);assert(ticks>2,`host heartbeat ran ${ticks} times`);assert(maxGap<500,`host blocked for ${maxGap} ms`);
  t.diagnostic(JSON.stringify({workerListMs:performance.now()-start,heartbeatTicks:ticks,maxHostGapMs:maxGap}));
  await assert.rejects(client.request('parse',{mainJsonl:null}),/path/);
  assert.equal((await client.request('list',3)).sessions.length,0,'worker accepts requests after a failed parse');
 } finally {clearInterval(heartbeat);client.dispose();}
});

test('WAL content is included without changing live DB/WAL/SHM; ctime-only changes keep spend cached', t => {
 const root=temporary(t), file=path.join(root,'owner/session.db'), writer=create(file,'sdk');
 writer.exec('PRAGMA journal_mode=WAL');
 const usage=n=>JSON.stringify({timestamp:Date.now()-1000,model:'model',_meta:{turnTokenTotals:[{model:'model',inputTokens:n,outputTokens:2,cachedTokens:0}],copilotUsage:{totalNanoAiu:n*1000}}});
 writer.prepare('INSERT INTO turn_usage VALUES (?,?)').run('turn',usage(100));
 try {
  const f=source(file,'sdk'), options={usageFiles:[f],cacheFilePath:path.join(root,'cache.json')};
  const before=fingerprint(file), main=fs.readFileSync(file);
  assert.equal(computeSpendSummaryFromChatSessionDirs('full',[],options).today.inputTokens,100);
  assert.deepEqual(fingerprint(file),before,'source bytes and timestamps stay unchanged');
  const sig=usageFileSignature(f);fs.chmodSync(file+'-wal',0o600);
  assert.equal(usageFileSignature(f),sig,'permission metadata is not usage');
  const copy=fs.copyFileSync;let copies=0;fs.copyFileSync=(...args)=>{copies++;return copy(...args);};
  try {assert.equal(computeSpendSummaryFromChatSessionDirs('full',[],options).today.inputTokens,100);assert.equal(copies,0);}
  finally {fs.copyFileSync=copy;}
  writer.prepare('UPDATE turn_usage SET usage=?').run(usage(200));
  assert.deepEqual(fs.readFileSync(file),main,'usage changed only in WAL');
  assert.notEqual(usageFileSignature(f),sig);
  const changed=fingerprint(file);
  assert.equal(computeSpendSummaryFromChatSessionDirs('full',[],options).today.inputTokens,200);
  assert.deepEqual(fingerprint(file),changed);
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(computeSpendSummaryFromChatSessionDirs('full',[],options).today.inputTokens,200,'checkpoint does not double count');
 } finally {writer.close();}
});

test('snapshot retries a write during copy and reads the new committed WAL', t => {
 const root=temporary(t), file=path.join(root,'owner/session.db'), writer=create(file,'before');writer.exec('PRAGMA journal_mode=WAL');writer.prepare('INSERT INTO session_metadata VALUES (?,?)').run('forceWal','true');
 const copy=fs.copyFileSync;let changed=false;
 fs.copyFileSync=(...args)=>{const result=copy(...args);if(args[0]===file&&!changed){changed=true;writer.prepare('UPDATE session_metadata SET value=?').run(JSON.stringify({sdkSessionId:'after'}));}return result;};
 try {assert.equal(withDatabaseSnapshot(file,db=>JSON.parse(db.prepare('SELECT value FROM session_metadata').get().value).sdkSessionId),'after');}
 finally {fs.copyFileSync=copy;writer.close();}
});

test('failed snapshots are retried rather than cached as zero usage', t => {
 const root=temporary(t), file=path.join(root,'owner/session.db'), db=create(file);db.prepare('INSERT INTO turn_usage VALUES (?,?)').run('t',JSON.stringify({timestamp:Date.now()-1000,_meta:{turnTokenTotals:[{model:'m',inputTokens:10,outputTokens:1}],copilotUsage:{totalNanoAiu:100}}}));db.close();
 const walMode=new DatabaseSync(file);walMode.exec('PRAGMA journal_mode=WAL');walMode.exec("UPDATE turn_usage SET usage=usage || ' '");
 const options={usageFiles:[source(file,'owner')],cacheFilePath:path.join(root,'cache.json')};
 const copy=fs.copyFileSync;fs.copyFileSync=()=>{throw new Error('temporary read failure');};
 try {assert.equal(computeSpendSummaryFromChatSessionDirs('full',[],options).today.inputTokens,0);}finally{fs.copyFileSync=copy;}
 try { assert.equal(computeSpendSummaryFromChatSessionDirs('full',[],options).today.inputTokens,10); } finally {walMode.close();}
});

test('disposing during a scan rejects pending requests and never leaves a busy promise', async t => {
 const client=new UsageClient({defaults:false});const pending=client.request('list');client.dispose();await assert.rejects(pending,/disposed/);await assert.rejects(client.request('list'),/disposed/);
});

test('a second window reuses unchanged identity metadata without copying SQLite databases',t=>{
 const {spawnSync}=require('node:child_process');const root=temporary(t),agents=path.join(root,'agentSessionData'),file=path.join(agents,'owner/session.db');create(file,'sdk').close();const storage=path.join(root,'cache');
 const program=`const fs=require('fs'),m=require(${JSON.stringify(require.resolve('../out/backgroundIdentity'))});let copies=0;const snapshots=require(${JSON.stringify(require.resolve('../out/sqliteSnapshot'))});const read=snapshots.withDatabaseSnapshot;snapshots.withDatabaseSnapshot=(...a)=>{copies++;return read(...a);};m.configureIdentityCache(${JSON.stringify(storage)});m.prepareBackgroundIndex([${JSON.stringify(agents)}]);console.log(copies);`;
 const first=spawnSync(process.execPath,['-e',program],{encoding:'utf8'}),second=spawnSync(process.execPath,['-e',program],{encoding:'utf8'});assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);assert.equal(first.stdout.trim(),'1');assert.equal(second.stdout.trim(),'0');
});

test('rollback readers leave live files and timestamps unchanged without copying',t=>{
 const root=temporary(t),file=path.join(root,'owner/session.db');create(file,'sdk').close();
 const before=fingerprint(file),copy=fs.copyFileSync;let copies=0;fs.copyFileSync=(...args)=>{copies++;return copy(...args);};
 try{assert.equal(withDatabaseSnapshot(file,db=>db.prepare('SELECT COUNT(*) AS n FROM session_metadata').get().n),1);assert.equal(copies,0);assert.deepEqual(fingerprint(file),before);}finally{fs.copyFileSync=copy;}
});

test('today skips old sources before reading SQLite, but a recent WAL keeps usage eligible',t=>{
 const root=temporary(t),file=path.join(root,'owner/session.db'),db=create(file);db.prepare('INSERT INTO turn_usage VALUES (?,?)').run('u',JSON.stringify({timestamp:Date.now()-1000,_meta:{copilotUsage:{totalNanoAiu:100}}}));db.close();
 const old=new Date(Date.now()-3*86400000);fs.utimesSync(file,old,old);
 const snapshots=require('../out/sqliteSnapshot'),read=snapshots.withDatabaseSnapshot;let reads=0;snapshots.withDatabaseSnapshot=(...a)=>{reads++;return read(...a);};
 try {const result=computeSpendSummaryFromChatSessionDirs('today',[],{usageFiles:[source(file,'owner')]});assert.equal(result.today.nanoAiu,0);assert.equal(reads,1,'only identity is read; spend parse is skipped');}finally{snapshots.withDatabaseSnapshot=read;}
});

test('first session paint avoids indexing thousands of unrelated stores',async t=>{
 const root=temporary(t),agents=path.join(root,'agentSessionData'),template=path.join(root,'template.db');create(template).close();
 const old=new Date(Date.now()-86400000);
 for(let i=0;i<300;i++){const file=path.join(agents,'empty-'+i,'session.db');fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(template,file);fs.utimesSync(file,old,old);}
 const file=path.join(agents,'active','session.db'),writer=create(file);writer.prepare('INSERT INTO turn_usage VALUES (?,?)').run('u',JSON.stringify({timestamp:Date.now()-1000,_meta:{copilotUsage:{totalNanoAiu:100}}}));writer.close();
 const {scanner}=require('../out/scanner'),snapshots=require('../out/sqliteSnapshot'),read=snapshots.withDatabaseSnapshot;let reads=0;snapshots.withDatabaseSnapshot=(...a)=>{reads++;return read(...a);};
 try {scanner.configure({defaults:false,searchRoots:[agents]});const loaded=scanner.autoLoad();assert.equal(loaded.parsed.summary.totalNanoAiu,100);assert(reads<=2,`read ${reads} databases before first paint`);}finally{snapshots.withDatabaseSnapshot=read;}
});

test('Windows cache path identity ignores drive and directory case',()=>{
 const {filePathKey}=require('../out/sqliteSnapshot');assert.equal(filePathKey('C:\\Users\\User\\.copilot\\session-state','win32'),filePathKey('c:\\users\\user\\.copilot\\session-state','win32'));
});

test('saved first paint is read without source access and does not leak yesterday into today',t=>{
 const root=temporary(t),file=path.join(root,'spend.json'),{scanner}=require('../out/scanner');
 const summary={today:{label:'Today',nanoAiu:123},generatedAt:Date.now(),scannedFiles:8};
 fs.writeFileSync(file+'.summary-v12',JSON.stringify(summary));const stat=fs.statSync;fs.statSync=()=>{throw Error('source access before paint');};
 try{assert.deepEqual(scanner.cachedSpend(file).today,summary.today);}finally{fs.statSync=stat;}
 summary.generatedAt=new Date(new Date().setHours(-1,0,0,0)).getTime();fs.writeFileSync(file+'.summary-v12',JSON.stringify(summary));assert.equal(scanner.cachedSpend(file),undefined);
});

test('today checks linked SDK and WAL changes even if the main DB is old',t=>{
 const root=temporary(t),file=path.join(root,'session.db'),db=create(file,'sdk');db.exec('PRAGMA journal_mode=WAL');db.prepare('INSERT INTO turn_usage VALUES (?,?)').run('u',JSON.stringify({timestamp:Date.now()-1000,_meta:{copilotUsage:{totalNanoAiu:101}}}));
 try {const old=new Date(Date.now()-3*86400000);fs.utimesSync(file,old,old);const summary=computeSpendSummaryFromChatSessionDirs('today',[],{usageFiles:[source(file,'sdk')]});assert.equal(summary.today.nanoAiu,101);}finally{db.close();}
});

test('fast SDK first paint reconciles saved inclusive totals after the first spend index',t=>{
 const root=temporary(t),agents=path.join(root,'agentSessionData'),file=path.join(agents,'owner','session.db'),db=create(file,'sdk');
 db.exec('CREATE TABLE turns(id TEXT,event_id TEXT)');db.prepare('INSERT INTO turns VALUES (?,?)').run('turn','user');db.prepare('INSERT INTO turn_usage VALUES (?,?)').run('turn',JSON.stringify({_meta:{copilotUsage:{totalNanoAiu:200},turnTokenTotals:[{model:'m',inputTokens:200,outputTokens:20,cachedTokens:0}]}}));db.close();const old=new Date(Date.now()-86400000);fs.utimesSync(file,old,old);
 const events=path.join(root,'session-state/sdk/events.jsonl');fs.mkdirSync(path.dirname(events),{recursive:true});fs.writeFileSync(events,[{type:'user.message',id:'user',timestamp:new Date().toISOString(),data:{content:'test'}},{type:'session.usage_record',id:'call',timestamp:new Date().toISOString(),parentId:'user',data:{usage:{model:'m',inputTokens:100,outputTokens:10,copilotUsage:{totalNanoAiu:100}}}}].map(JSON.stringify).join('\n')+'\n');
 const {scanner}=require('../out/scanner');scanner.configure({defaults:false,searchRoots:[root]});const first=scanner.autoLoad();assert.equal(first.parsed.summary.totalNanoAiu,100);assert.equal(scanner.spend('today',true).today.nanoAiu,100);scanner.indexHistory();assert.equal(scanner.parse(first.candidate).summary.totalNanoAiu,200);assert.equal(scanner.spend('today',true).today.nanoAiu,200);
});
