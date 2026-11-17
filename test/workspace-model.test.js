const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeWorkspacePath,WorkspaceIndex,readWorkspaceIdentity,readEventWorkspace}=require('../out/workspaces');
const {ModelNames,modelSequence,modelCostMix}=require('../out/modelNames');
const {scanner}=require('../out/scanner');
const {parseCopilotSessionFile}=require('../out/parser');
const {computeSpendSummaryFromChatSessionDirs}=require('../out/spend');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-workspaces-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data));return file;}
const now=Date.now();
const event=(type,id,data={},offset=0,agentId,parentId)=>({type,id,timestamp:new Date(now-10000+offset).toISOString(),data,agentId,parentId});
function events(file,values){return write(file,values.map(v=>JSON.stringify(v)).join('\n')+'\n');}
const usage=(model,cost=100,extra={})=>({model,inputTokens:100,outputTokens:10,copilotUsage:{totalNanoAiu:cost},...extra});

test('Windows paths, percent-encoded file URIs and UNC roots normalize without merging remote authorities',()=>{
 assert.equal(normalizeWorkspacePath('file:///c%3A/Users/Me/Repo/'),'c:/users/me/repo');
 assert.equal(normalizeWorkspacePath('C:\\Users\\Me\\Repo\\'),'c:/users/me/repo');
 assert.equal(normalizeWorkspacePath('file://SERVER/Share/Repo'),'//server/share/repo');
 assert.notEqual(normalizeWorkspacePath('vscode-remote://ssh-remote+one/home/me'),normalizeWorkspacePath('vscode-remote://ssh-remote+two/home/me'));
 assert.notEqual(normalizeWorkspacePath('/src/Foo'),normalizeWorkspacePath('/src/foo'));
});

test('workspace match uses path boundaries, longest folder and keeps sibling worktrees distinct',t=>{
 const r=root(t),a=path.join(r,'workspaceStorage/a'),b=path.join(r,'workspaceStorage/b');
 write(path.join(a,'workspace.json'),{folder:'file:///C:/src/repo'});write(path.join(b,'workspace.json'),{folder:'file:///c%3A/src/repo/nested'});
 const index=new WorkspaceIndex([a]);
 assert.equal(index.resolve('C:\\src\\repo\\nested\\lib').workspaceKey,b);
 assert.equal(index.resolve('c:/src/repo/lib').workspaceKey,a);
 assert.notEqual(index.resolve('c:/src/repo-worktree').workspaceKey,a);
 assert.notEqual(index.resolve('c:/src/repository').workspaceKey,a);
 assert.equal(index.resolve(undefined,[],true).workspaceLabel,'No workspace');
 assert.equal(index.resolve().workspaceLabel,'Unknown workspace');
});

test('multi-root JSONC workspace resolves relative folders and invalidates changed metadata',t=>{
 const r=root(t),dir=path.join(r,'workspaceStorage/x'),config=path.join(r,'project.code-workspace');
 write(config,'{ // workspace\n "folders": [{"path":"one","name":"First"},{"path":"two"}, /* trailing */ ], }');
 write(path.join(dir,'workspace.json'),{workspace:config});
 const identity=readWorkspaceIdentity(dir);assert.equal(identity.workspaceLabel,'First +1');assert.deepEqual(identity.folders,[path.join(r,'one'),path.join(r,'two')]);
 assert.equal(new WorkspaceIndex([dir]).resolve(path.join(r,'two')).workspaceKey,dir);
 write(path.join(dir,'workspace.json'),{folder:path.join(r,'new-folder')});assert.equal(readWorkspaceIdentity(dir).workspaceLabel,'new-folder');
});

test('event workspace retries torn heads, avoids unchanged reads, and notices replacement',t=>{
 const r=root(t),f=write(path.join(r,'events.jsonl'),'{"type":"session.start"');assert.equal(readEventWorkspace(f),undefined);
 events(f,[event('session.start','s',{context:{cwd:'/original'}})]);assert.equal(readEventWorkspace(f),'/original');
 const open=fs.openSync;let reads=0;fs.openSync=(...args)=>{reads++;return open(...args);};try{assert.equal(readEventWorkspace(f),'/original');assert.equal(reads,0);}finally{fs.openSync=open;}
 events(f,[event('session.start','s',{context:{cwd:'/different'}})]);assert.equal(readEventWorkspace(f),'/different');
});

test('scanner merges SDK spend into the matching classic workspace on cold and warm scans',t=>{
 const r=root(t),workspace=path.join(r,'Code/User/workspaceStorage/ws'),chat=path.join(workspace,'chatSessions');
 write(path.join(workspace,'workspace.json'),{folder:'file:///C:/work/project'});
 events(path.join(chat,'classic.jsonl'),[{kind:0,v:{requests:[{timestamp:now-2000,promptTokens:10,completionTokens:1,result:{details:'Claude Opus 5.5 • 1 credits'}}]}}]);
 events(path.join(r,'session-state/sdk/events.jsonl'),[event('session.start','s',{context:{cwd:'c:\\work\\project\\src'}}),event('user.message','u',{content:'test'},100),event('session.usage_record','c',{usage:usage('claude-opus-5.5',2e9,{modelDisplayName:'Claude Opus 5.5'})},200)]);
 scanner.configure({defaults:false,home:r,searchRoots:[r],maxDepth:6});
 for(let i=0;i<2;i++){const total=scanner.spend('full',true,path.join(r,'cache.json'));assert.equal(total.today.nanoAiu,3e9);assert.equal(total.today.workspaces.length,1);assert.equal(total.today.workspaces[0].label,'project');assert.equal(total.today.models.length,1);assert.equal(total.today.models[0].key,'claude-opus-5.5');assert.equal(total.today.models[0].label,'Claude Opus 5.5');}
});

test('model aliases strip provider prefixes and avoid ambiguous learned aliases',()=>{
 const names=new ModelNames();names.learn('gpt-6-luna','GPT-6 Luna');assert.equal(names.resolve('@provider-vscode-proxy:gpt-6-luna').key,'gpt-6-luna');assert.equal(names.resolve('GPT-6 Luna').key,'gpt-6-luna');
 names.learn('one','Shared');names.learn('two','Shared');assert.equal(names.resolve('Shared').key,'shared');
 assert.equal(modelSequence([{model:'m',modelDisplayName:'M',timestamp:1},{model:'n',timestamp:2},{model:'m',modelDisplayName:'M',timestamp:3}]),'M → n → M');
 assert.equal(modelCostMix([{model:'claude-opus-5.5',modelDisplayName:'Claude Opus 5.5',nanoAiu:60},{model:'Claude Opus 5.5',nanoAiu:40}]),'Claude Opus 5.5 100%');
});

test('model changes, pre-prompt routing and configured subagents preserve per-call selections',t=>{
 const r=root(t),f=events(path.join(r,'sdk/events.jsonl'),[
 event('session.start','s',{selectedModel:'auto',autoTier:'balance'}),event('session.auto_mode_resolved','route',{chosenModel:'luna',routingMethod:'auto_v2',availableModels:['luna'],candidateModels:['luna']},10),
 event('user.message','u',{content:'test'},20),event('session.usage_record','c1',{usage:usage('luna',10,{isAuto:true})},30),
 event('session.model_change','change',{newModel:'opus',reasoningEffort:'high',source:'sdk'},40),event('session.usage_record','c2',{usage:usage(undefined,20)},50),
 event('tool.execution_start','task',{toolCallId:'t',toolName:'task'},60),event('subagent.started','a',{toolCallId:'t',agentDisplayName:'Reviewer',model:'luna'},70,'child'),event('subagent.configured','config',{model:'small',reasoningEffort:'low'},80,'child'),event('session.usage_record','c3',{usage:usage(undefined,30,{isAuto:true})},90,'child'),
 event('session.resume','resume',{selectedModel:'next',reasoningEffort:'medium'},100),event('user.message','u2',{content:'continue'},110),event('session.usage_record','c4',{usage:usage(undefined,40)},120)]);
 const s=parseCopilotSessionFile(f).summary;assert.deepEqual(s.userMessages.flatMap(m=>m.modelTurns).map(t=>t.model),['luna','opus','small','next']);assert.equal(s.routing[0].owner,'u');assert.equal(s.routing[0].tier,'balance');assert.equal(s.agents[0].reasoningEffort,'low');assert.equal(s.totalNanoAiu,100);assert.equal(s.modelSelections.length,3);
});

test('permission success variant exposes tokens without adding charges or retaining request messages',t=>{
 const r=root(t),f=events(path.join(r,'sdk/events.jsonl'),[event('user.message','u',{content:'test'}),event('session.usage_record','bill',{usage:usage('m',123)},1),event('model.model_call_success','check',{requestMessages:JSON.stringify([{role:'system',content:'You are the permission judge. private system text'}]),modelCall:{model:'judge',retry_attempt:1,usage:{prompt_tokens:50,completion_tokens:2,prompt_tokens_details:{cached_tokens:30,cache_write_tokens:10}}},modelCallDurationMs:25},2)]);
 const s=parseCopilotSessionFile(f).summary;assert.equal(s.totalNanoAiu,123);assert.equal(s.permissionChecks.length,1);assert.equal(s.permissionChecks[0].inputTokens,50);assert.equal(s.permissionChecks[0].retry,true);assert(!JSON.stringify(s).includes('private system text'));
});

test('nested shutdown accounting and BYOK preserve billing states',t=>{
 const r=root(t),f=events(path.join(r,'sdk/events.jsonl'),[event('session.start','s'),event('user.message','u',{},1),event('session.usage_record','bill',{usage:usage('m',0,{isByok:true,contextTier:'long_context',responseModel:'m-v2'})},2),event('session.shutdown','end',{accountingSnapshot:{totalNanoAiu:0},codeChanges:{linesAdded:1,filesModifiedCount:1}},3)]);
 const s=parseCopilotSessionFile(f).summary;assert.equal(s.userMessages[0].modelTurns[0].isByok,true);assert.equal(s.userMessages[0].modelTurns[0].contextTier,'long_context');assert.equal(s.codeChanges.linesAdded,1);assert.equal(s.totalNanoAiu,0);
});

test('incremental SDK scan reads only the appended tail and caches no tool output or attachments',t=>{
 const {readUsageEvents}=require('../out/eventLog');const r=root(t),f=path.join(r,'events.jsonl');
 const lines=[event('user.message','u',{content:'hello',attachments:[{data:'PRIVATE_ATTACHMENT'}]})];
 for(let i=0;i<12000;i++)lines.push(event('tool.execution_complete','t'+i,{toolCallId:'t'+i,success:true,result:'PRIVATE_TOOL_RESULT'+'x'.repeat(1024)},i));
 events(f,lines);let cold=[];readUsageEvents(f,e=>cold.push(e));assert.equal(cold.length,12001);assert(!JSON.stringify(cold).includes('PRIVATE_'));
 fs.appendFileSync(f,JSON.stringify(event('session.usage_record','call',{usage:usage('m',12)},15000))+'\n');
 const read=fs.readSync;let bytes=0;fs.readSync=(...args)=>{const n=read(...args);bytes+=n;return n;};
 try {const next=[];readUsageEvents(f,e=>next.push(e));assert.equal(next.length,12002);assert(bytes<65536,`read ${bytes} bytes for a small append`);bytes=0;readUsageEvents(f,()=>{});assert.equal(bytes,0);}finally{fs.readSync=read;}
});

test('incremental SDK scan repairs partial UTF-8 tails and resets on truncate or replacement',t=>{
 const {readUsageEvents}=require('../out/eventLog');const r=root(t),f=path.join(r,'events.jsonl');
 events(f,[event('session.start','s')]);const line=Buffer.from(JSON.stringify(event('user.message','u',{content:'héllo 👋'})));const split=line.indexOf(Buffer.from('👋'))+2;
 fs.appendFileSync(f,line.subarray(0,split));const first=[];readUsageEvents(f,e=>first.push(e));assert.equal(first.length,1);
 fs.appendFileSync(f,Buffer.concat([line.subarray(split),Buffer.from('\n')]));const second=[];readUsageEvents(f,e=>second.push(e));assert.equal(second.length,2);assert.equal(second[1].data.content,'héllo 👋');
 events(f,[event('session.start','new')]);let values=[];readUsageEvents(f,e=>values.push(e));assert.deepEqual(values.map(e=>e.id),['new']);
 const other=events(path.join(r,'new.jsonl'),[event('session.start','replacement')]);fs.renameSync(other,f);values=[];readUsageEvents(f,e=>values.push(e));assert.deepEqual(values.map(e=>e.id),['replacement']);
});

test('explicit permission retry chains and duplicate success aliases count one final attempt',t=>{
 const r=root(t),f=events(path.join(r,'sdk/events.jsonl'),[
 event('user.message','u'),event('model.model_call_started','a',{model:'judge'},1),
 event('model.model_call_failure','fail',{purpose:'permission',modelCall:{model:'judge'}},2,undefined,'a'),
 event('model.turn_retry','retry',{},3,undefined,'fail'),event('model.model_call_started','b',{model:'judge'},4,undefined,'retry'),
 event('model.model_call_success','success',{purpose:'permission',modelCall:{model:'judge'}},5,undefined,'b'),
 event('model.model_call_completed','done',{purpose:'permission',modelCall:{model:'judge'}},6,undefined,'b')]);
 const s=parseCopilotSessionFile(f).summary;assert.equal(s.permissionChecks.length,2);assert.equal(s.permissionChecks.filter(c=>c.retry).length,1);assert.equal(s.permissionChecks.filter(c=>c.failed).length,1);assert.equal(s.totalNanoAiu,0);
});

test('database workspace arrays and saved routing retain identity without opening a live database for reads',t=>{
 const {DatabaseSync}=require('node:sqlite');const {resolveBackgroundFiles}=require('../out/backgroundIdentity');
 const r=root(t),f=path.join(r,'agentSessionData/owner/session.db');fs.mkdirSync(path.dirname(f),{recursive:true});const db=new DatabaseSync(f);
 db.exec('CREATE TABLE session_metadata(key TEXT,value TEXT,turn_id TEXT); CREATE TABLE turns(id TEXT,event_id TEXT); CREATE TABLE turn_usage(turn_id TEXT,usage TEXT)');
 for(const [key,value] of Object.entries({'copilot.workingDirectories':['file:///C:/Project','file:///C:/Other'],'copilot.model':{id:'auto',config:{tier:'balance'}},'agentHost.workspaceless':false}))db.prepare('INSERT INTO session_metadata VALUES(?,?,NULL)').run(key,JSON.stringify(value));
 db.prepare('INSERT INTO turns VALUES(?,?)').run('turn','user');db.prepare('INSERT INTO turn_usage VALUES(?,?)').run('turn',JSON.stringify({timestamp:now-1000,_meta:{copilotUsage:{totalNanoAiu:100},autoModeResolved:{chosenModel:'luna',selectionReason:'saved route',candidateModels:['luna']}}}));db.close();
 const identity=resolveBackgroundFiles(f,[],[]);assert.equal(identity.workspace,'file:///C:/Project');assert.equal(identity.workspaces.length,2);assert.equal(identity.selectedModel,'auto');
 const s=parseCopilotSessionFile(f).summary;assert.equal(s.routing.length,1);assert.equal(s.routing[0].reason,'saved route');assert.equal(s.modelSelections[0].autoTier,'balance');assert.equal(s.totalNanoAiu,100);
});
