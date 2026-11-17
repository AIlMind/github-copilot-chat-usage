const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {readBackgroundSession,backgroundHasUsage}=require('../out/background');
const {parseCopilotSessionFile,setBackgroundCliRoots}=require('../out/parser');
const {computeSpendSummaryFromChatSessionDirs}=require('../out/spend');
const {SessionGraph}=require('../out/graph');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-detail-'));t.after(()=>{setBackgroundCliRoots([]);fs.rmSync(root,{recursive:true,force:true});});return root;}
function event(type,id,ts,data={},agentId,parentId){return {type,id,timestamp:new Date(ts).toISOString(),data,agentId,parentId};}
function write(root,events){const f=path.join(root,'session/events.jsonl');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,events.map(e=>JSON.stringify(e)).join('\n')+'\n');return f;}
function call(id,cost,input=100,extra={}){return {accounting:{usageId:id},model:'m',inputTokens:input,outputTokens:10,cacheReadTokens:40,copilotUsage:{totalNanoAiu:cost},...extra};}
function db(root,rows){const file=path.join(root,'session/session.db');fs.mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);db.exec('CREATE TABLE turns(id TEXT,event_id TEXT);CREATE TABLE turn_usage(turn_id TEXT,usage TEXT)');for(const [id,u] of rows){db.prepare('INSERT INTO turns VALUES(?,?)').run(id,id);db.prepare('INSERT INTO turn_usage VALUES(?,?)').run(id,JSON.stringify(u));}db.close();return file;}
function saved(cost,total,input=100){return {_meta:{turnTokenTotals:[{model:'m',inputTokens:input,outputTokens:10,cachedTokens:40}],copilotUsage:{totalNanoAiu:cost,sessionTotalNanoAiu:total}}};}
function spend(file,now){return computeSpendSummaryFromChatSessionDirs('full',[],{now,usageFiles:[{file,dir:path.dirname(file),kind:'background',sessionId:'session',workspaceKey:'w',workspaceLabel:'w'}]});}
const now=new Date(2026,10,17,12).getTime();

test('calls retain timing, cache writes, costs and correct tool ownership with inclusive saved usage',t=>{
 const root=fixture(t),file=write(root,[event('user.message','u',now-10000,{content:'test'}),
 event('assistant.turn_start','start1',now-9000,{turnId:'1'}),event('assistant.message','m1',now-8100,{turnId:'1',apiCallId:'api1'}),
 event('session.usage_record','c1',now-8000,{usage:call('a',100,100,{apiCallId:'api1',duration:1000,timeToFirstTokenMs:300,cacheWriteTokens:50,reasoningTokens:4,reasoningEffort:'high',finishReason:'tool_calls',maxPromptTokens:200,toolTokenCount:20,availableToolCount:3,copilotUsage:{totalNanoAiu:100,tokenDetails:[{tokenType:'cache_write',tokenCount:50,batchSize:100,costPerBatch:200}]}})},undefined,'start1'),
 event('tool.execution_start','tool',now-7900,{toolCallId:'t',toolName:'bash',turnId:'1'}),event('tool.execution_complete','done',now-7000,{toolCallId:'t',success:true}),
 event('assistant.turn_start','start2',now-6000,{turnId:'2'}),event('session.usage_record','c2',now-5000,{usage:call('b',200,100,{duration:500,timeToFirstTokenMs:100})},undefined,'start2')]);
 db(root,[['u',saved(400,400,250)]]);
 const s=parseCopilotSessionFile(file).summary,m=s.userMessages[0];
 assert.equal(s.modelTurnCount,2);assert.equal(m.modelTurns.length,3);assert.equal(s.totalNanoAiu,400);assert.equal(s.totalNanoAiu,s.userMessages.reduce((n,m)=>n+m.totalNanoAiu,0));
 assert.equal(s.totalInputTokens,250);assert.equal(m.modelTurns[0].durationMs,1000);assert.equal(m.modelTurns[0].ttftMs,300);assert.equal(m.modelTurns[0].freshTokens,10);assert.equal(m.modelTurns[0].cacheWriteTokens,50);assert.equal(m.modelTurns[0].toolCalls[0].durationMs,900);assert.equal(m.modelTurns[1].toolCalls.length,0);assert.equal(m.modelTurns[2].usageKind,'saved');assert.equal(m.modelTurns[2].durationKnown,false);assert.equal(m.contextKnown,false);
 const g=new SessionGraph(s).messages;assert.equal(g[0].turns[0].tokenDetails[0].costPerBatch,200);
});

test('stale shutdown and saved turn totals never clamp a resumed call ledger',t=>{
 const root=fixture(t),file=write(root,[event('session.start','s',now-10000),event('user.message','u1',now-9000,{content:'old'}),event('session.usage_record','a',now-8000,{usage:call('a',174)}),event('session.shutdown','stop',now-7000,{totalNanoAiu:174}),event('user.message','u2',now-5000,{content:'resumed'}),event('session.usage_record','b',now-4000,{usage:call('b',122)})]);
 db(root,[['u1',saved(174,174)]]);const s=parseCopilotSessionFile(file).summary;assert.equal(s.totalNanoAiu,296);assert.equal(s.userMessages.reduce((n,m)=>n+m.totalNanoAiu,0),296);assert.equal(spend(file,now).today.nanoAiu,296);
});

test('checkpoint deltas recover missing history once and exclude intervals crossing midnight from today',t=>{
 const root=fixture(t),midnight=new Date(2026,10,17).getTime(),file=write(root,[event('session.start','start',midnight-2000),event('session.usage_checkpoint','p1',midnight-1000,{totalNanoAiu:100}),event('session.usage_checkpoint','p2',midnight+1000,{totalNanoAiu:200}),event('session.usage_checkpoint','p3',midnight+2000,{totalNanoAiu:250}),event('session.shutdown','p4',midnight+3000,{totalNanoAiu:250})]);
 const s=parseCopilotSessionFile(file).summary;assert.equal(s.totalNanoAiu,250);assert.equal(s.modelTurnCount,0);const totals=spend(file,now);assert.equal(totals.today.nanoAiu,50);assert.equal(totals.week.nanoAiu,250);
});

test('an undated initial checkpoint is not added again by each later checkpoint',t=>{
 const root=fixture(t),file=write(root,[event('session.usage_checkpoint','p1',now-1000,{totalNanoAiu:100}),event('session.usage_checkpoint','p2',now-500,{totalNanoAiu:120})]);
 const s=parseCopilotSessionFile(file).summary;assert.equal(s.totalNanoAiu,120);assert.equal(spend(file,now).today.nanoAiu,20);
});

test('partial call records are preserved alongside saved remainders and checkpoints',t=>{
 const root=fixture(t),file=write(root,[event('session.start','s',now-10000),event('user.message','u1',now-9000),event('session.usage_record','c',now-8000,{usage:call('a',100)}),event('session.usage_checkpoint','p1',now-7000,{totalNanoAiu:300}),event('user.message','u2',now-5000),event('session.usage_checkpoint','p2',now-4000,{totalNanoAiu:500})]);
 db(root,[['u1',saved(250,500)],['u2',saved(100,500)]]);const data=readBackgroundSession(file),s=parseCopilotSessionFile(file).summary;assert.equal(data.usageRecordCount,1);assert.equal(s.totalNanoAiu,500);assert.equal(s.modelTurnCount,1);assert.equal(spend(file,now).today.nanoAiu,500);
});

test('tools without completion distinguish terminal interruption from still unrecorded completion',t=>{
 const root=fixture(t),events=[event('user.message','u',now-1000),event('session.usage_record','c',now-900,{usage:call('a',100)}),event('tool.execution_start','tool',now-800,{toolName:'bash',toolCallId:'tool'})];let file=write(root,events);assert.equal(parseCopilotSessionFile(file).summary.userMessages[0].toolCalls[0].status,'pending');events.push(event('session.shutdown','end',now-700,{totalNanoAiu:100}));write(root,events);assert.equal(parseCopilotSessionFile(file).summary.userMessages[0].toolCalls[0].status,'interrupted');
});

test('empty stores stay out of discovery and appear as soon as usage is saved',t=>{
 const root=fixture(t),file=db(root,[]);assert.equal(backgroundHasUsage(file,[],[]),false);const events=write(root,[event('session.title_changed','title',now-1000,{title:'Empty title'})]);assert.equal(backgroundHasUsage(file,[],[]),false);fs.appendFileSync(events,JSON.stringify(event('session.usage_record','call',now-500,{usage:call('a',0)}))+'\n');assert.equal(backgroundHasUsage(file,[],[]),true);
});

test('snapshot token totals are not assigned to the last credit interval',t=>{
 const root=fixture(t),file=write(root,[event('session.start','s',now-10000),event('session.usage_checkpoint','p1',now-5000,{totalNanoAiu:100}),event('session.shutdown','p2',now-1000,{totalNanoAiu:200,modelMetrics:{m:{usage:{inputTokens:300,outputTokens:30,cacheReadTokens:40}}}})]);const s=parseCopilotSessionFile(file).summary;assert.equal(s.totalInputTokens,300);assert.equal(spend(file,now).today.inputTokens,0);assert.equal(spend(file,now).today.nanoAiu,200);
});

test('reused turn numbers and interleaved agents do not duplicate or misassign tools',t=>{
 const root=fixture(t),file=write(root,[event('user.message','u',now-10000),
 event('assistant.turn_start','s1',now-9000,{turnId:'0'}),event('session.usage_record','c1',now-8000,{usage:call('c1',100,100,{apiCallId:'api1',duration:100})},undefined,'s1'),event('assistant.message','m1',now-7999,{turnId:'0',apiCallId:'api1',toolRequests:[{toolCallId:'tool1'}]}),event('tool.execution_start','t1',now-7990,{toolCallId:'tool1',toolName:'task',turnId:'0'}),
 event('subagent.started','agent',now-7900,{toolCallId:'tool1'},'child'),event('assistant.turn_start','child-start',now-7000,{turnId:'0'},'child'),
 event('assistant.turn_start','s2',now-6000,{turnId:'0'}),event('session.usage_record','c2',now-5000,{usage:call('c2',200,100,{apiCallId:'api2',duration:200})},undefined,'child-start'),event('assistant.message','m2',now-4999,{turnId:'0',apiCallId:'api2',toolRequests:[{toolCallId:'tool2'}]},undefined,'child-start'),event('tool.execution_start','t2',now-4990,{toolCallId:'tool2',toolName:'bash',turnId:'0'})]);
 const s=parseCopilotSessionFile(file).summary,turns=s.userMessages[0].modelTurns;assert.equal(turns[0].timestamp,now-9000);assert.equal(turns[1].timestamp,now-6000);assert.deepEqual(turns.map(t=>t.toolCalls.map(t=>t.toolCallId)),[['tool1'],['tool2']]);assert.equal(s.toolCallCount,2);
});

test('a cached empty event log still checks newly saved legacy credits',t=>{
 const root=fixture(t),file=write(root,[]);assert.equal(backgroundHasUsage(file,[],[]),false);fs.writeFileSync(path.join(path.dirname(file),'vscode.requests.metadata.json'),JSON.stringify([{creditsUsed:1}]));assert.equal(backgroundHasUsage(file,[],[]),true);
});

test('another window cannot erase a cache entry written after this scan began',t=>{
 const root=fixture(t),a=db(path.join(root,'a'),[['u',{timestamp:now-1000,...saved(100)}]]),b=db(path.join(root,'b'),[['u',{timestamp:now-1000,...saved(200)}]]),cache=path.join(root,'cache.json');
 const options=f=>({now,cacheFilePath:cache,usageFiles:[{file:f,dir:path.dirname(f),kind:'background',sessionId:f,workspaceKey:'w',workspaceLabel:'w'}]});
 computeSpendSummaryFromChatSessionDirs('full',[],options(a));const read=fs.readFileSync;let inject=true;
 fs.readFileSync=function(f,...args){const result=read.call(this,f,...args);if(f===cache&&inject){inject=false;computeSpendSummaryFromChatSessionDirs('full',[],options(b));}return result;};
 try {fs.utimesSync(a,new Date(),new Date());computeSpendSummaryFromChatSessionDirs('full',[],options(a));}finally{fs.readFileSync=read;}
 assert.equal(Object.keys(JSON.parse(read(cache)).entries).length,2);
});

test('credit-only reconciliation does not demote detailed background usage below a duplicate debug log',t=>{
 const root=fixture(t),file=write(root,[event('user.message','u',now-1000),event('session.usage_record','c',now-500,{usage:call('a',100)})]);db(root,[['u',saved(100,150)]]);
 const debug=path.join(root,'debug/session/main.jsonl');fs.mkdirSync(path.dirname(debug),{recursive:true});fs.writeFileSync(debug,JSON.stringify({sid:'session',type:'user_message',ts:now-1000,spanId:'u',attrs:{content:'test'}})+'\n'+JSON.stringify({sid:'session',type:'llm_request',ts:now-500,spanId:'l',attrs:{inputTokens:100,outputTokens:10,copilotUsageNanoAiu:100}})+'\n');
 const entry=(f,kind)=>({file:f,kind,dir:path.dirname(f),sessionId:'session',workspaceKey:'w',workspaceLabel:'w'});
 const summary=computeSpendSummaryFromChatSessionDirs('full',[],{now,usageFiles:[entry(file,'background'),entry(debug,'debug')]});assert.equal(summary.today.nanoAiu,100);assert.equal(summary.undatedRequests,1);
 setBackgroundCliRoots([root],[],[path.join(root,'debug')]);const parsed=parseCopilotSessionFile(file).summary;assert.equal(parsed.sourceType,'background');assert.equal(parsed.totalNanoAiu,150);
});

test('Fusion preserves billed charges without exposing rate comparisons',t=>{
 const {applyPricingDiagnostics,catalogPrices}=require('../out/backgroundDiagnostics');
 const detail=price=>[{model:'m',tokenType:'input',tokenCount:100,batchSize:100,costPerBatch:price}];
 const base={model:'m',provider:'copilot',maxPromptTokens:1000,timestamp:now,inputTokens:100,outputTokens:0,durationMs:1};
 const main={...base,isAuto:true,nanoAiu:70,tokenDetails:detail(70)},child={...base,isAuto:false,agentId:'child',nanoAiu:100,tokenDetails:detail(100)};
 applyPricingDiagnostics([main,child],[]);assert.equal(main.savingsNanoAiu,undefined);assert.equal(main.referenceNanoAiu,undefined);assert.equal(main.nanoAiu,70);assert.equal(child.nanoAiu,100);
 const unknown={...base,isAuto:true,nanoAiu:70,tokenDetails:detail(70),maxPromptTokens:2000};applyPricingDiagnostics([unknown,child],[]);assert.equal(unknown.savingsNanoAiu,undefined);
 const conflict={...child,tokenDetails:detail(90)};const uncertain={...base,isAuto:true,nanoAiu:70,tokenDetails:detail(70)};applyPricingDiagnostics([uncertain,child,conflict],[]);assert.equal(uncertain.savingsNanoAiu,undefined);
 const tiered=catalogPrices('m',now-1,{token_prices:{batch_size:1000000,default:{input_price:10,cache_read_price:1,cache_write_price:12.5,output_price:50,max_prompt_tokens:1000},long_context:{input_price:20,max_prompt_tokens:2000}}});assert.equal(tiered[0].rates.input,10000);assert.equal(tiered[1].rates.input,20000);
 const legacy=catalogPrices('m',now,{token_prices:{batch_size:1000000,input_price:10000000000}});assert.equal(legacy[0].rates.input,10000);
});

test('routing, subagent lifecycle and permission judge traces retain diagnostics without adding costs',t=>{
 const root=fixture(t),file=write(root,[event('session.auto_mode_resolved','route',now-10000,{chosenModel:'m',autoTier:'balance',selectionReason:'best available',candidateModels:['m'],categoryScores:{reasoning:0.5},endToEndLatencyMs:100}),
 event('user.message','u',now-9000,{content:'Review the app'}),event('session.usage_record','main',now-8000,{usage:call('main',70,100,{isAuto:true})}),event('tool.execution_start','tool',now-7000,{toolCallId:'tool',toolName:'task'}),event('subagent.started','child-start',now-6900,{toolCallId:'tool',agentDisplayName:'Reviewer',agentType:'explore',model:'m',modelSelectionSource:'agent_definition_default'},'child'),
 event('session.usage_record','child-call',now-6000,{usage:call('child',100,100,{isAuto:false})},'child'),event('subagent.completed','child-end',now-5000,{toolCallId:'tool',durationMs:1900,totalTokens:110,totalToolCalls:2}),
 event('model.model_call_started','permission-start',now-4000,{model:'judge',modelInfo:{billing:{token_prices:{default:{input_price:0,output_price:0,cache_read_price:0,cache_write_price:0}}}}}),
 event('model.captured_assignment_context','context',now-3900,{},undefined,'permission-start'),event('model.model_call_failure','failure',now-3000,{purpose:'permission',modelCallDurationMs:1000,modelCall:{model:'judge',retry_attempt:0}},undefined,'context'),
 event('model.model_call_started','retry-start',now-2000,{model:'judge'}),event('model.model_call_completed','success',now-1000,{purpose:'permission',modelCallDurationMs:1000,modelCall:{model:'judge',retry_attempt:1}},undefined,'retry-start')]);
 const s=parseCopilotSessionFile(file).summary;assert.equal(s.totalNanoAiu,170);assert.equal(s.title,'Review the app');assert.equal(s.routing[0].tier,'balance');assert.equal(s.agents[0].name,'Reviewer');assert.equal(s.agents[0].durationMs,1900);assert.equal(s.agents[0].modelSelectionSource,'agent_definition_default');assert.equal(s.permissionChecks.length,2);assert.equal(s.permissionChecks[0].listedFree,true);assert.equal(s.permissionChecks[1].retry,true);
 assert(new SessionGraph(s).serialize().includes('Permission checks: 2 attempts, 1 retries, 1 failures'));assert(!JSON.stringify(s).includes('requestMessages'));
});

test('cache expiry uses each recorded timestamp, without assuming a fixed five-minute TTL',()=>{
 const {applyPricingDiagnostics}=require('../out/backgroundDiagnostics');const calls=[{model:'m',timestamp:now-3600000,cacheExpiresAt:new Date(now-1800000).toISOString()},{model:'m',timestamp:now-2000000},{model:'m',timestamp:now-1000000}];applyPricingDiagnostics(calls,[]);assert.equal(calls[1].cachePreviouslyExpired,undefined);assert.equal(calls[2].cachePreviouslyExpired,true);
});

test('picker falls back to the first user prompt when a background title is absent',t=>{
 const root=fixture(t),file=write(path.join(root,'session-state'),[event('user.message','u',now-1000,{content:'  First prompt\nwith spacing  '}),event('session.usage_record','c',now-500,{usage:call('a',0)})]);const {scanner}=require('../out/scanner');scanner.configure({defaults:false,searchRoots:[root]});const sessions=scanner.list().sessions;assert.equal(sessions.length,1);assert.equal(sessions[0].title,'First prompt with spacing');
});

test('credit-only checkpoints preserve unknown token counts through parser, graph and spend cache',t=>{
 const root=fixture(t),file=write(root,[event('session.start','s',now-10000),event('session.usage_checkpoint','p',now-1000,{totalNanoAiu:123})]);
 const s=parseCopilotSessionFile(file).summary;
 assert.equal(s.totalNanoAiu,123);assert.equal(s.tokensKnown,false);assert.equal(s.userMessages[0].tokensKnown,false);
 assert(s.userMessages.flatMap(m=>m.modelTurns).every(t=>t.tokensKnown===false));assert.equal(new SessionGraph(s).stats.tokensKnown,false);
 const options={now,cacheFilePath:path.join(root,'cache.json'),usageFiles:[{file,dir:path.dirname(file),kind:'background',sessionId:'session',workspaceKey:'w',workspaceLabel:'w'}]};
 for(let i=0;i<2;i++){const result=computeSpendSummaryFromChatSessionDirs('full',[],options);assert.equal(result.today.nanoAiu,123);assert.equal(result.today.tokensKnown,false);assert.equal(result.today.unattributed.tokensKnown,false);assert.equal(result.today.workspaces[0].tokensKnown,false);}
});

test('partial token history retains its counts without presenting them as a complete total',t=>{
 const root=fixture(t),file=write(root,[event('session.start','s',now-10000),event('user.message','u',now-9000),event('session.usage_record','c',now-8000,{usage:call('a',100)}),event('session.usage_checkpoint','p',now-7000,{totalNanoAiu:300})]);
 const s=parseCopilotSessionFile(file).summary;assert.equal(s.tokensKnown,false);assert.equal(s.totalTokens,110);assert.equal(s.totalNanoAiu,300);
 const totals=spend(file,now);assert.equal(totals.today.tokensKnown,false);assert.equal(totals.today.inputTokens,100);assert.equal(totals.today.nanoAiu,300);
});

test('multi-day saved prompts do not count intermediate checkpoint credits twice',t=>{
 const root=fixture(t),start=now-3*86400000;
 const events=[event('session.start','s',start),event('user.message','u',start+1)];
 for(let i=1;i<=63;i++)events.push(event('session.usage_checkpoint','cp'+i,start+i*3600000,{totalNanoAiu:i*100}));
 events.push(event('session.usage_record','last',start+64*3600000,{usage:call('last',100)}),event('session.shutdown','end',start+65*3600000,{totalNanoAiu:8000}));
 const file=write(root,events);db(root,[['u',saved(8000,8000)]]);
 const data=readBackgroundSession(file);assert.equal(data.sessionNanoAiu,8000);assert.equal(data.usage.filter(u=>u.kind==='adjustment').length,0);
 const s=parseCopilotSessionFile(file).summary;assert.equal(s.totalNanoAiu,8000);assert.equal(s.userMessages.reduce((n,m)=>n+m.totalNanoAiu,0),8000);assert.equal(spend(file,now).week.nanoAiu,8000);
});

test('queued prompt owns its call even when turn_start preceded the user message',t=>{
 const root=fixture(t),file=write(root,[event('user.message','first',now-10000),event('assistant.turn_start','early',now-9004,{turnId:4},undefined,'first'),event('user.message','queued',now-9000,{content:'queued'},undefined,'early'),event('assistant.message','response',now-8000,{turnId:4,apiCallId:'api'},undefined,'queued'),event('session.usage_record','usage',now-7000,{usage:call('call',203,100,{apiCallId:'api',duration:23500})},undefined,'response')]);
 db(root,[['queued',saved(203,203)]]);
 const data=readBackgroundSession(file);assert.equal(data.sessionNanoAiu,203);assert.equal(data.usage.length,1);assert.equal(data.usage[0].owner,'queued');
 const s=parseCopilotSessionFile(file).summary;assert.equal(s.userMessages.find(m=>m.spanId==='queued').modelTurns.length,1);
});

test('permission responseChunk tokens survive projection; frustration classifier stays excluded',t=>{
 const root=fixture(t),usage={prompt_tokens:123,completion_tokens:9,prompt_tokens_details:{cached_tokens:100,cache_write_tokens:4}};
 const file=write(root,[event('user.message','u',now-5000),event('model.model_call_success','judge',now-4000,{requestMessages:[{role:'system',content:'You are the permission judge. Private prompt'}],responseChunk:{usage,content:'private response'}}),event('model.model_call_success','classifier',now-3000,{requestMessages:[{role:'system',content:'Task: Detect whether the CURRENT MESSAGE expresses frustration'}],responseChunk:{usage}})]);
 for(let i=0;i<2;i++){const data=readBackgroundSession(file);assert.equal(data.permissionChecks.length,1);assert.equal(data.permissionChecks[0].inputTokens,123);assert.equal(data.permissionChecks[0].cachedTokens,100);assert.equal(data.permissionChecks[0].cacheWriteTokens,4);assert.equal(data.sessionNanoAiu,0);assert(!JSON.stringify(data).includes('private response'));}
});

test('mixed saved model buckets allocate exact totals with explicit estimates and no synthetic model',t=>{
 const root=fixture(t),file=db(root,[['u',{timestamp:now-1000,_meta:{copilotUsage:{totalNanoAiu:101},turnTokenTotals:[{model:'claude-sonnet-5.5',inputTokens:30,outputTokens:0,cachedTokens:5},{model:'@provider-vscode-proxy:gpt-6.1-terra',inputTokens:70,outputTokens:0,cachedTokens:10}]}}]]);
 const result=spend(file,now).today;assert.equal(result.nanoAiu,101);assert.equal(result.models.reduce((n,m)=>n+m.nanoAiu,0),101);assert.equal(result.models.length,2);assert(result.models.every(m=>m.estimated));assert.deepEqual(result.models.map(m=>m.label).sort(),['Claude Sonnet 5.5','GPT-6.1 Terra']);assert.equal(result.models.reduce((n,m)=>n+m.inputTokens,0),100);
});
