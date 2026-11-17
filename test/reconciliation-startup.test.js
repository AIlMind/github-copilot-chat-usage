const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readBackgroundSession } = require('../out/background');
const { parseCopilotSessionFile, setBackgroundCliRoots } = require('../out/parser');
const { computeSpendSummaryFromChatSessionDirs } = require('../out/spend');
const { scanner } = require('../out/scanner');
const now = new Date(2026, 10, 17, 12).getTime();
function temporary(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-086-'));
 t.after(() => { setBackgroundCliRoots([]); fs.rmSync(root, {recursive:true, force:true}); });
 return root;
}
function event(type, id, ts, data = {}, parentId) { return {type,id,timestamp:new Date(ts).toISOString(),data,parentId}; }
function call(id, ts, cost) { return event('session.usage_record',id,ts,{usage:{model:'m',inputTokens:100,outputTokens:10,copilotUsage:{totalNanoAiu:cost}}},'user'); }
function fixture(t, events, cost, balance) {
 const root = temporary(t), dir = path.join(root,'session'); fs.mkdirSync(dir);
 const file = path.join(dir,'events.jsonl'); fs.writeFileSync(file,events.map(JSON.stringify).join('\n')+'\n');
 const db = new DatabaseSync(path.join(dir,'session.db'));
 db.exec('CREATE TABLE turns(id TEXT,event_id TEXT); CREATE TABLE turn_usage(turn_id TEXT,usage TEXT)');
 // LEFT JOIN cannot find this turn at all, as in the reported failing stores.
 db.prepare('INSERT INTO turn_usage VALUES (?,?)').run('orphan',JSON.stringify({_meta:{copilotUsage:{totalNanoAiu:cost,sessionTotalNanoAiu:balance},turnTokenTotals:[{model:'m',inputTokens:200,outputTokens:20,cachedTokens:0}]}})); db.close();
 return file;
}
function summary(file) {
 const parsed = parseCopilotSessionFile(file).summary;
 assert.equal(parsed.totalNanoAiu,parsed.userMessages.reduce((n,m)=>n+m.totalNanoAiu,0),'header equals children');
 return parsed;
}
function spend(file) { return computeSpendSummaryFromChatSessionDirs('full',[],{now,usageFiles:[{file,dir:path.dirname(file),kind:'background',sessionId:'session',workspaceKey:'w',workspaceLabel:'w'}]}); }
const start = () => [event('session.start','s',now-10000),event('user.message','user',now-9000)];

test('unlinked saved turn is covered once by its cumulative checkpoint balance',t=>{
 const file = fixture(t,[...start(),call('call',now-8000,106),event('session.usage_checkpoint','cp',now-1000,{totalNanoAiu:1000})],894,1000);
 assert.equal(summary(file).totalNanoAiu,1000);
 assert.equal(spend(file).today.nanoAiu,1000);
 const saved = readBackgroundSession(file).usage.find(u=>u.id==='orphan');
 assert.equal(saved.nanoAiu,894); assert.equal(saved.intervalStart,now-10000); assert.equal(saved.intervalEnd,now-1000);
});

test('unlinked rows use their own earlier balance instead of the final checkpoint',t=>{
 const file = fixture(t,[...start(),call('first',now-8000,100),event('session.usage_checkpoint','cp1',now-7000,{totalNanoAiu:100}),event('session.usage_checkpoint','cp2',now-5000,{totalNanoAiu:300}),call('last',now-3000,200),event('session.usage_checkpoint','cp3',now-1000,{totalNanoAiu:500})],200,300);
 assert.equal(summary(file).totalNanoAiu,500);
 const saved = readBackgroundSession(file).usage.find(u=>u.id==='orphan'); assert.equal(saved.intervalStart,now-7000); assert.equal(saved.intervalEnd,now-5000);
});

test('unlinked rows without a cumulative balance replace checkpoint gaps but remain undated',t=>{
 const file = fixture(t,[...start(),call('call',now-8000,106),event('session.usage_checkpoint','cp',now-1000,{totalNanoAiu:1000})],894);
 assert.equal(summary(file).totalNanoAiu,1000); assert.equal(spend(file).today.nanoAiu,106);
 assert.equal(readBackgroundSession(file).usage.find(u=>u.id==='orphan').timestamp,undefined);
});

test('partial or lagging backend totals never cap independently saved usage',t=>{
 const file = fixture(t,[...start(),call('call',now-8000,1000),event('session.usage_checkpoint','cp',now-1000,{totalNanoAiu:1000,aiCreditsStatus:'partial'})],174,1000);
 const data=readBackgroundSession(file); assert.equal(summary(file).totalNanoAiu,1174);
 assert.equal(data.usage.find(u=>u.kind==='call').nanoAiu,1000);
 assert.equal(data.usage.find(u=>u.id==='orphan').nanoAiu,174);
});

test('orphan reconciliation never clamps resumed calls to a stale shutdown',t=>{
 const file = fixture(t,[...start(),event('session.shutdown','cp',now-5000,{totalNanoAiu:100}),call('resumed',now-1000,200)],100,100);
 assert.equal(summary(file).totalNanoAiu,300); assert.equal(spend(file).today.nanoAiu,300);
});

test('a saved balance newer than the last checkpoint remains additional undated usage',t=>{
 const file = fixture(t,[...start(),call('first',now-8000,100),event('session.shutdown','cp',now-5000,{totalNanoAiu:100})],200,300);
 assert.equal(summary(file).totalNanoAiu,300); assert.equal(spend(file).today.nanoAiu,100);
});

test('orphan checkpoint placement does not date an unknown prefix or cross-midnight interval as Today',t=>{
 const file = fixture(t,[event('session.start','s',now-86400000),event('session.usage_checkpoint','cp',now-1000,{totalNanoAiu:100})],100,100);
 assert.equal(summary(file).totalNanoAiu,100); assert.equal(spend(file).today.nanoAiu,0); assert.equal(spend(file).week.nanoAiu,100);
 const second=fixture(t,[event('session.usage_checkpoint','cp',now-1000,{totalNanoAiu:100})],100,100);
 assert.equal(summary(second).totalNanoAiu,100); assert.equal(spend(second).today.nanoAiu,0);
});

function template(file, wal = false) {
 const db=new DatabaseSync(file); db.exec('CREATE TABLE session_metadata(key TEXT,value TEXT); CREATE TABLE turn_usage(turn_id TEXT,usage TEXT)');
 if(wal)db.exec('PRAGMA journal_mode=WAL'); db.close();
}

test('cold Today indexes only recent stores; full history is deferred and still complete',t=>{
 const root=temporary(t),agents=path.join(root,'agentSessionData');fs.mkdirSync(agents);
 const plain=path.join(root,'plain.db'),wal=path.join(root,'wal.db');template(plain);template(wal,true);
 const old=new Date(Date.now()-3*86400000),recent=new Set();
 for(let i=0;i<2225;i++){
  const file=path.join(agents,'owner-'+i,'session.db');fs.mkdirSync(path.dirname(file));fs.copyFileSync(i<613?wal:plain,file);
  if(i<58){recent.add(fs.realpathSync(file));const db=new DatabaseSync(file);db.prepare('INSERT INTO turn_usage VALUES (?,?)').run('u',JSON.stringify({timestamp:Date.now()-1000,_meta:{copilotUsage:{totalNanoAiu:100}}}));db.close();}
  else fs.utimesSync(file,old,old);
 }
 const snapshots=require('../out/sqliteSnapshot'),read=snapshots.withDatabaseSnapshot;let oldReads=0,recentReads=0;
 snapshots.withDatabaseSnapshot=(file,...args)=>{recent.has(fs.realpathSync(file))?recentReads++:oldReads++;return read(file,...args);};
 try{
  scanner.configure({defaults:false,searchRoots:[agents],globalStoragePath:path.join(root,'cache')});
  const begun=performance.now(),first=scanner.spend('today',true,path.join(root,'spend.json')),coldMs=performance.now()-begun;
  t.diagnostic(JSON.stringify({coldTodayMs:coldMs,historicalDatabaseReads:oldReads,recentDatabaseReads:recentReads}));
  assert.equal(first.today.nanoAiu,5800);assert.equal(oldReads,0,'no historical DB opened before Today is returned');assert.equal(recentReads,116,'identity + usage for 58 recent stores only');
  const beforeIndex=performance.now();scanner.indexHistory();const fullIndexMs=performance.now()-beforeIndex;
  assert.equal(oldReads,2167,'deferred index discovers the rest');
  oldReads=recentReads=0;const warmStart=performance.now();const warm=scanner.spend('today',true,path.join(root,'spend.json'));
  assert.deepEqual(warm.today,first.today);assert.equal(oldReads,0);assert.equal(recentReads,0);
  t.diagnostic(JSON.stringify({stores:2225,recent:58,coldTodayMs:coldMs,deferredIndexMs:fullIndexMs,warmTodayMs:performance.now()-warmStart}));
 }finally{snapshots.withDatabaseSnapshot=read;}
});

test('recent WAL is included by the cold Today identity filter and SDK/DB usage is deduplicated',t=>{
 const root=temporary(t),agents=path.join(root,'agentSessionData'),dir=path.join(agents,'owner');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'session.db');template(file);
 const writer=new DatabaseSync(file);writer.exec('PRAGMA journal_mode=WAL');writer.prepare('INSERT INTO session_metadata VALUES (?,?)').run('defaultChatProviderData',JSON.stringify({sdkSessionId:'sdk'}));writer.prepare('INSERT INTO turn_usage VALUES (?,?)').run('user',JSON.stringify({timestamp:Date.now()-1000,_meta:{copilotUsage:{totalNanoAiu:200,sessionTotalNanoAiu:200}}}));
 const events=path.join(root,'session-state/sdk/events.jsonl');fs.mkdirSync(path.dirname(events),{recursive:true});const at=Date.now()-1000;fs.writeFileSync(events,[event('user.message','user',at),call('c',at+1,100)].map(JSON.stringify).join('\n')+'\n');
 const old=new Date(Date.now()-3*86400000);fs.utimesSync(file,old,old);
 try{scanner.configure({defaults:false,searchRoots:[root]});const result=scanner.spend('today',true);assert.equal(result.today.nanoAiu,200);assert.equal(result.scannedFiles,1);}finally{writer.close();}
});

function savedRows(t, rows, checkpoint, status) {
 const file=fixture(t,[...start(),...rows.map((r,i)=>event('user.message',r.owner,now-8000+i*1000)),event('session.usage_checkpoint','cp',now-1000,{totalNanoAiu:checkpoint,aiCreditsStatus:status})],0,0);
 const db=new DatabaseSync(path.join(path.dirname(file),'session.db'));
 db.exec('DELETE FROM turn_usage');
 for(const [i,row] of rows.entries()){
  db.prepare('INSERT INTO turns VALUES (?,?)').run('row'+i,row.owner);
  db.prepare('INSERT INTO turn_usage VALUES (?,?)').run('row'+i,JSON.stringify({_meta:{copilotUsage:{totalNanoAiu:row.cost,sessionTotalNanoAiu:row.balance,sessionAiCreditsStatus:status},turnTokenTotals:[{model:'m',inputTokens:row.cost,outputTokens:10,cachedTokens:0}]}}));
 }
 db.close();return file;
}

test('strictly regressed saved balances exclude repeated credits, even on the same prompt',t=>{
 const file=savedRows(t,[{owner:'old',cost:2000,balance:2000},{owner:'prompt',cost:100,balance:2100},{owner:'prompt',cost:200,balance:1990}],2070,'partial');
 const data=readBackgroundSession(file);assert.equal(data.sessionNanoAiu,2100);assert.equal(summary(file).totalNanoAiu,2100);
 assert.equal(data.usage.find(u=>u.id==='row1').nanoAiu,100);
 assert(data.usage.filter(u=>u.owner==='prompt').every(u=>u.nanoAiu<=100));
 assert.equal(spend(file).today.nanoAiu,2100,'partial checkpoint is a floor, not a cap');
});

test('equal cumulative balances preserve lagged prompt charges',t=>{
 const file=savedRows(t,[{owner:'one',cost:100,balance:100},{owner:'two',cost:30,balance:100},{owner:'three',cost:20,balance:150}],150);
 const data=readBackgroundSession(file);assert.equal(summary(file).totalNanoAiu,150);
 assert.equal(data.usage.find(u=>u.id==='row1').nanoAiu,30);assert.equal(data.usage.filter(u=>u.kind==='adjustment').length,0);
});

test('a missing or partial-zero balance cannot identify replayed saved usage',t=>{
 const file=savedRows(t,[{owner:'one',cost:100,balance:100},{owner:'two',cost:30},{owner:'three',cost:20,balance:0}],100,'partial');
 assert.equal(summary(file).totalNanoAiu,150);
 const data=readBackgroundSession(file);assert.equal(data.usage.find(u=>u.id==='row2').nanoAiu,20);
});

test('regressed saved aggregates do not remove their independently recorded calls',t=>{
 const file=savedRows(t,[{owner:'one',cost:100,balance:100},{owner:'two',cost:30,balance:90}],100,'partial');
 fs.appendFileSync(file,JSON.stringify(event('session.usage_record','real',now-3000,{usage:{model:'m',inputTokens:10,outputTokens:1,copilotUsage:{totalNanoAiu:30}}},'two'))+'\n');
 assert.equal(summary(file).totalNanoAiu,130);
});

function fingerprint(file) {
 return ['', '-wal', '-shm', '-journal'].map(suffix=>{
  try{const p=file+suffix,stat=fs.statSync(p,{bigint:true});return [stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,require('node:crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex')].join(':');}
  catch(error){if(error.code==='ENOENT')return 'missing';throw error;}
 });
}
test('inactive WAL-mode stores use immutable reads without creating sidecars or copies',t=>{
 const root=temporary(t),file=path.join(root,'spaces # and ?.db');template(file,true);
 const {withDatabaseSnapshot}=require('../out/sqliteSnapshot');
 for(const emptyWal of [false,true]){
  if(emptyWal)fs.writeFileSync(file+'-wal','');
  const before=fingerprint(file),copy=fs.copyFileSync;let copies=0;fs.copyFileSync=(...args)=>{copies++;return copy(...args);};
  try{assert.equal(withDatabaseSnapshot(file,db=>db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n),2);assert.equal(copies,0);assert.deepEqual(fingerprint(file),before);}
  finally{fs.copyFileSync=copy;}
 }
});

test('a concurrent WAL write invalidates the immutable read and retries from a snapshot',t=>{
 const root=temporary(t),file=path.join(root,'session.db');template(file,true);
 const {withDatabaseSnapshot}=require('../out/sqliteSnapshot');let writer,reads=0;
 try{
  const count=withDatabaseSnapshot(file,db=>{
   const result=db.prepare('SELECT count(*) AS n FROM session_metadata').get().n;
   if(++reads===1){writer=new DatabaseSync(file);writer.prepare('INSERT INTO session_metadata VALUES (?,?)').run('key','value');}
   return result;
  });
  assert.equal(count,1);assert.equal(reads,2);
 }finally{writer?.close();}
});

test('failed immutable reads fall back to snapshots and active rollback journals remain unreadable',t=>{
 const root=temporary(t),file=path.join(root,'session.db');template(file,true);
 const {withDatabaseSnapshot}=require('../out/sqliteSnapshot');let reads=0;
 assert.equal(withDatabaseSnapshot(file,db=>{if(++reads===1)throw Error('read changed');return db.prepare('SELECT count(*) AS n FROM session_metadata').get().n;}),0);assert.equal(reads,2);
 fs.writeFileSync(file+'-journal','active writer');
 assert.throws(()=>withDatabaseSnapshot(file,()=>{throw Error('must not read');}),/active rollback journal/);
});


test('multiple saved remainders for one prompt retain distinct spend identities',t=>{
 const file=savedRows(t,[{owner:'one',cost:100,balance:100},{owner:'one',cost:150,balance:150}],150);
 assert.equal(summary(file).totalNanoAiu,150);assert.equal(spend(file).today.nanoAiu,150);
});


test('an orphan with a partial-zero baseline remains undated',t=>{
 const file=fixture(t,[...start(),event('session.usage_checkpoint','cp',now-1000,{totalNanoAiu:100})],100,0);
 const db=new DatabaseSync(path.join(path.dirname(file),'session.db'));
 const usage=JSON.parse(db.prepare('SELECT usage FROM turn_usage').get().usage);usage._meta.copilotUsage.sessionAiCreditsStatus='partial';
 db.prepare('UPDATE turn_usage SET usage=?').run(JSON.stringify(usage));db.close();
 const data=readBackgroundSession(file);assert.equal(data.sessionNanoAiu,100);assert.equal(data.usage.find(u=>u.id==='orphan').timestamp,undefined);
});
