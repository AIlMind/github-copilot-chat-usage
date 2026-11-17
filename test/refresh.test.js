const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { RefreshScheduler } = require('../out/refreshScheduler');

class Clock {
  time = 0; next = 0; timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => { const id = ++this.next; this.timers.set(id, { at: this.time + delay, callback }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      await Promise.resolve(); await Promise.resolve();
      const next = [...this.timers].sort((a,b) => a[1].at-b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = end;
    await Promise.resolve(); await Promise.resolve();
  }
}
function deferred() { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; }
const unexpected = error => { throw error; };

test('continuous log writes refresh at most every 30 seconds without waiting for quiet', async () => {
  const clock = new Clock(), starts = [];
  const scheduler = new RefreshScheduler(30000, async () => { starts.push(clock.now()); }, unexpected, clock);
  scheduler.request(true); await clock.advance(0);
  for (let i=0;i<95;i++) { await clock.advance(1000); scheduler.request(); }
  assert.deepEqual(starts,[0,30000,60000,90000]);
  await clock.advance(25000); assert.deepEqual(starts,[0,30000,60000,90000,120000]);
  await clock.advance(60000); assert.equal(starts.length,5,'idle logs do not trigger scans');
  scheduler.dispose();
});

test('a burst refreshes the latest totals at the original deadline, including the last write', async () => {
  const clock=new Clock(), values=[]; let latest=0;
  const scheduler=new RefreshScheduler(30000,async()=>{values.push(latest);},unexpected,clock);
  for (let i=1;i<=29;i++) {await clock.advance(1000);latest=i;scheduler.request();}
  assert.deepEqual(values,[]);
  await clock.advance(1000);assert.deepEqual(values,[29]);
  await clock.advance(1000);latest=30;scheduler.request();
  await clock.advance(29000);assert.deepEqual(values,[29,30]);scheduler.dispose();
});

test('slow scans never overlap and writes received during a scan get one following refresh', async () => {
  const clock=new Clock(), gate=deferred(), starts=[];let active=0,maxActive=0;
  const scheduler=new RefreshScheduler(30000,async()=>{active++;maxActive=Math.max(maxActive,active);starts.push(clock.now());if(starts.length===1)await gate.promise;active--;},unexpected,clock);
  scheduler.request(true);await clock.advance(0);
  for(let i=0;i<40;i++){await clock.advance(1000);scheduler.request();}
  assert.deepEqual(starts,[0]);gate.resolve();await clock.advance(0);
  assert.deepEqual(starts,[0,40000]);assert.equal(maxActive,1);scheduler.dispose();
});

test('manual refresh bypasses the delay and resets the automatic refresh deadline', async () => {
  const clock=new Clock(), starts=[];
  const scheduler=new RefreshScheduler(30000,async()=>{starts.push(clock.now());},unexpected,clock);
  scheduler.request(true);await clock.advance(0);scheduler.request();
  await clock.advance(10000);scheduler.request(true);await clock.advance(0);assert.deepEqual(starts,[0,10000]);
  scheduler.request();await clock.advance(29999);assert.equal(starts.length,2);
  await clock.advance(1);assert.deepEqual(starts,[0,10000,40000]);scheduler.dispose();
});

test('a failed scan does not strand the next refresh', async () => {
  const clock=new Clock(), errors=[];let calls=0;
  const scheduler=new RefreshScheduler(30000,async()=>{if(++calls===1)throw new Error('temporary read failure');},e=>errors.push(e.message),clock);
  scheduler.request(true);await clock.advance(0);assert.deepEqual(errors,['temporary read failure']);
  scheduler.request();await clock.advance(30000);assert.equal(calls,2);scheduler.dispose();
});

test('disposal cancels the queued refresh even if the active scan finishes later', async () => {
  const clock=new Clock(), gate=deferred();let calls=0;
  const scheduler=new RefreshScheduler(30000,async()=>{calls++;await gate.promise;},unexpected,clock);
  scheduler.request(true);await clock.advance(0);scheduler.request();scheduler.dispose();gate.resolve();
  await clock.advance(60000);scheduler.request(true);await clock.advance(0);assert.equal(calls,1);
});

// Exercise the production tree renderer with only VS Code's value objects stubbed.
const originalLoad = Module._load;
let UsageTreeProvider;
try {
  Module._load = function(id, ...args) {
    if(id==='vscode') return {
      Uri:{parse:s=>s}, env:{language:'en-NZ'},
      workspace:{getConfiguration:()=>({get:()=>true})},
      EventEmitter:class{event=()=>({dispose(){}});fire(){}},
      TreeItem:class{constructor(label,collapsibleState){this.label=label;this.collapsibleState=collapsibleState;}},
      ThemeIcon:class{constructor(id){this.id=id;}},
      TreeItemCollapsibleState:{None:0,Collapsed:1,Expanded:2},
    };
    return originalLoad.call(this,id,...args);
  };
  ({UsageTreeProvider}=require('../out/extension'));
} finally {Module._load=originalLoad;}
const bucket=(label,nanoAiu)=>({label,nanoAiu,inputTokens:1200,outputTokens:80,cachedTokens:900,requestCount:1,sessionCount:1});
const summary=()=>({today:bucket('Today',0),week:bucket('Last 7 days',1500000000),month:bucket('Last 30 days',2000000000),generatedAt:Date.now(),scannedFiles:1,notes:['A long coverage explanation.']});

test('existing totals, including zero, stay visible throughout refresh and after an error', () => {
  const view=new UsageTreeProvider();view.setSpendSummary(summary());view.setSpendRefreshing('full');
  const root=view.getChildren()[0], children=view.getChildren(root);
  assert.match(view.getTreeItem(root).description,/today 0\.00 AIC/);
  const descriptions=children.filter(n=>n.kind==='spendBucket').map(n=>view.getTreeItem(n).description);
  assert.match(descriptions[0],/^0\.00 AIC/);assert.match(descriptions[1],/^1\.50 AIC/);assert.match(descriptions[2],/^2\.00 AIC/);
  assert(!JSON.stringify(descriptions).includes('refreshing'));
  assert(!children.some(n=>n.kind==='spendLoading'));
  view.finishSpendRefresh();assert.match(view.getTreeItem(view.getChildren()[0]).description,/today 0\.00 AIC/);
});

test('loading appears only for data that has never been loaded, and ends on failure', () => {
  const view=new UsageTreeProvider();view.setSpendRefreshing('today');
  assert.equal(view.getChildren()[0].kind,'spendLoading');
  const data=summary();delete data.week;delete data.month;view.setSpendSummary(data);
  view.setFullSpendSummaryLoader(()=>view.setSpendRefreshing('full'));view.requestSpendHistory();
  let children=view.getChildren(view.getChildren()[0]);
  assert.equal(children.find(n=>n.kind==='spendLoading').history,true);
  assert.match(view.getTreeItem(children[0]).description,/^0\.00 AIC/);
  view.finishSpendRefresh();children=view.getChildren(view.getChildren()[0]);
  assert(!children.some(n=>n.kind==='spendLoading'));
});

test('coverage explanations are removed from visible rows without discarding diagnostics', () => {
  const view=new UsageTreeProvider(), data=summary();view.setSpendSummary(data);
  const session={sessionId:'test',sourceType:'background',usageNotes:['A long session warning.'],userMessages:[],totalNanoAiu:1500000000,totalTokens:1280,totalInputTokens:1200,totalOutputTokens:80,totalCachedTokens:900,modelTurnCount:1,toolCallCount:0};
  view.setSummary(session);
  for(const root of view.getChildren()) {
    assert(!view.getChildren(root).some(n=>n.label==='Usage coverage'));
    assert(!String(view.getTreeItem(root).tooltip).includes('A long'));
  }
  assert.deepEqual(data.notes,['A long coverage explanation.']);assert.deepEqual(session.usageNotes,['A long session warning.']);
});

test('background diagnostics show missing metrics honestly and split cache writes from input',()=>{
 const {parseEntries}=require('../out/parser');
 const entries=[{sid:'s',type:'user_message',ts:1,spanId:'u',attrs:{content:'Test'}},
  {sid:'s',type:'llm_request',ts:2,dur:8000,spanId:'call',name:'call',attrs:{userMessageId:'u',model:'m',usageKind:'call',durationKnown:true,ttft:1200,contextKnown:false,inputTokens:100,cachedTokens:30,cacheWriteTokens:60,outputTokens:10,tokenDetails:[{tokenType:'cache_write',tokenCount:60,costPerBatch:1e9,batchSize:100}]}},
  {sid:'s',type:'llm_request',ts:3,dur:0,spanId:'saved',name:'saved',attrs:{userMessageId:'u',usageKind:'saved',durationKnown:false,contextKnown:false,copilotUsageNanoAiu:200}}];
 const s=parseEntries(entries);s.sourceType='background';const view=new UsageTreeProvider();view.setSummary(s);const message=s.userMessages[0];
 assert.equal(view.getChildren({kind:'userMessage',message,index:0}).find(c=>c.label==='Context at Start').value,'Not saved');
 const details=view.getChildren({kind:'modelTurn',turn:message.modelTurns[0],turnIndex:0,msgIndex:0});
 assert.match(details.find(c=>c.label==='Input breakdown').value,/30 cache read · 60 cache write · 10 normal input/);
 assert.match(details.find(c=>c.label==='Cost: cache_write').value,/0.60 AIC/);
 assert.equal(view.getChildren({kind:'modelTurn',turn:message.modelTurns[1],turnIndex:1,msgIndex:0}).find(c=>c.label==='Duration / TTFT').value,'Not saved / Not saved');
 assert.match(view.getTreeItem({kind:'turnsGroup',message,msgIndex:0}).label,/1 call \+ 1 saved usage/);
 assert.equal(view.getTreeItem({kind:'turnToolCall',call:{displayLabel:'bash',durationMs:0,status:'interrupted'}}).description,'Interrupted');
});

test('background messages expose separate Fusion and named subagent branches without changing the parent sum',()=>{
 const {parseEntries}=require('../out/parser');const s=parseEntries([{sid:'s',type:'user_message',ts:1,spanId:'u',attrs:{content:'test'}},...[['main',undefined,true,70],['child','child',false,100]].map(([id,agentId,isAuto,cost],i)=>({sid:'s',type:'llm_request',ts:2+i,dur:100,spanId:id,attrs:{userMessageId:'u',usageKind:'call',agentId,isAuto,model:'m',durationKnown:true,ttft:50,copilotUsageNanoAiu:cost}}))]);
 s.sourceType='background';s.routing=[{timestamp:1,chosenModel:'m',tier:'balance',candidates:['m']}];s.agents=[{id:'child',name:'Reviewer',type:'explore',durationMs:500,modelSelectionSource:'agent_definition_default'}];s.permissionChecks=[{id:'check',owner:'u',model:'judge',durationMs:20,failed:false,retry:false}];const view=new UsageTreeProvider();view.setSummary(s);
 const children=view.getChildren({kind:'userMessage',message:s.userMessages[0],index:0}),groups=children.filter(c=>c.kind==='agentGroup');assert.equal(groups.length,2);assert.match(view.getTreeItem(groups[0]).label,/Main · Fusion \(balance\)/);assert.match(view.getTreeItem(groups[1]).label,/Reviewer/);assert.equal(groups.reduce((n,g)=>n+g.turns.reduce((n,t)=>n+t.nanoAiu,0),0),s.userMessages[0].totalNanoAiu);assert(children.some(c=>c.kind==='permissionGroup'));
});

test('unknown, partial and recorded-zero tokens are distinct in the production renderer',()=>{
 const {parseEntries}=require('../out/parser');const view=new UsageTreeProvider();
 function parse(tokensKnown,inputTokens=0){return parseEntries([{sid:'s',type:'user_message',ts:1,spanId:'u',attrs:{content:'test'}},{sid:'s',type:'llm_request',ts:2,dur:0,spanId:'c',attrs:{tokensKnown,inputTokens,outputTokens:0,copilotUsageNanoAiu:100}}]);}
 for(const [known,input,expected] of [[false,0,'Not saved'],[false,100,'100 recorded'],[true,0,'0']]){
  const s=parse(known,input),m=s.userMessages[0],turn=m.modelTurns[0];view.setSummary(s);
  const token=view.getChildren({kind:'modelTurn',turn,turnIndex:0,msgIndex:0}).find(c=>c.label==='Tokens');assert(token.value.includes(expected));
  const item=view.getTreeItem({kind:'session',summary:s});assert(item.tooltip.includes(`Total Tokens: ${expected}`));
  const b={...bucket('Today',100),tokensKnown:known,inputTokens:input,outputTokens:0,cachedTokens:0};assert(view.getTreeItem({kind:'spendBucket',bucket:b}).tooltip.includes(`Input tokens: ${expected}`));
  assert.equal(s.totalNanoAiu,100);
 }
});

test('model visibility shows mixed prompts and routing evidence without naming an unproven orchestration mode',()=>{
 const {parseEntries}=require('../out/parser');const s=parseEntries([{sid:'s',type:'user_message',ts:1,spanId:'u',attrs:{content:'test'}},...[
 {model:'luna',modelDisplayName:'Luna',isAuto:true,reasoningEffort:'medium'},
 {model:'opus',modelDisplayName:'Opus',isAuto:true,reasoningEffort:'high',tokenDetails:[{model:'opus',tokenType:'input',tokenCount:1},{model:'luna',tokenType:'output',tokenCount:1}]},
 {model:'haiku',modelDisplayName:'Haiku',agentId:'child',reasoningEffort:'low'}].map((attrs,i)=>({sid:'s',type:'llm_request',ts:2+i,dur:10,spanId:'c'+i,attrs:{userMessageId:'u',usageKind:'call',copilotUsageNanoAiu:100,...attrs}}))]);
 s.sourceType='background';s.modelSelections=[{timestamp:1,model:'auto',autoTier:'balance',source:'session.start'}];s.routing=[{timestamp:1,owner:'u',chosenModel:'luna',tier:'balance',candidates:['luna']}];
 const view=new UsageTreeProvider();view.setSummary(s);const m=s.userMessages[0];
 assert.match(view.getTreeItem({kind:'session',summary:s}).description,/Fusion \(balance\)/);
 assert.match(view.getTreeItem({kind:'userMessage',message:m,index:0}).description,/Fusion → Luna → Opus \+ Haiku \(subagents\)/);
 assert.match(view.getTreeItem({kind:'modelTurn',turn:m.modelTurns[1],turnIndex:1,msgIndex:0}).label,/Opus · high/);
 const routing=view.getChildren({kind:'userMessage',message:m,index:0}).find(n=>n.kind==='routingGroup');assert.equal(routing.signals.length,2);
 assert(!JSON.stringify(view.getChildren(routing)).match(/Cascade|Critique/));assert.equal(s.totalNanoAiu,300);
});

test('model estimates are marked and unattributed credits are a footer, not a model',()=>{
 const view=new UsageTreeProvider(),model={...bucket('Claude Sonnet 5.5',700),key:'claude-sonnet-5.5',estimated:true},unattributed={...bucket('Unattributed usage',100),key:'unattributed-usage'};
 const element={kind:'spendModelSummary',models:[model],unattributed};
 assert.equal(view.getTreeItem(element).description,'1 model');const children=view.getChildren(element);assert.equal(children[1].kind,'stat');assert.equal(children[1].label,'Unattributed usage');assert.match(view.getTreeItem(children[0]).description,/^≈/);assert.match(view.getTreeItem(children[0]).tooltip,/estimated model allocation/);
});
