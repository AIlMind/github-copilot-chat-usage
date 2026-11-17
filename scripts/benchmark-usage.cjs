// Optional large-log regression: node scripts/benchmark-usage.cjs [MiB, default 492]
// Creates synthetic data in the OS temp directory and removes it afterwards.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {UsageClient}=require('../out/usageClient');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-large-'));
 const sizeMiB=Number(process.argv[2]||492);assert(sizeMiB>0&&sizeMiB<=1024);
 const dir=path.join(root,'session-state','large');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,'events.jsonl'),fd=fs.openSync(file,'w'),timestamp=new Date(Date.now()-1000).toISOString();
 fs.writeSync(fd,JSON.stringify({type:'user.message',id:'user',timestamp,data:{content:'Large log validation'}})+'\n');
 const payload='x'.repeat(65536);let written=0,index=0;
 while(written<sizeMiB*1024*1024) {const line=JSON.stringify({type:'tool.execution_complete',id:`result-${index++}`,timestamp,data:{toolCallId:'tool',result:payload,success:true}})+'\n';written+=fs.writeSync(fd,line);}
 fs.writeSync(fd,JSON.stringify({type:'session.usage_record',id:'usage',timestamp,data:{usage:{model:'test',inputTokens:12345,outputTokens:678,cacheReadTokens:1000,copilotUsage:{totalNanoAiu:1500000000}}}})+'\n');fs.closeSync(fd);
 const client=new UsageClient({defaults:false,searchRoots:[root]});let ticks=0,maxGap=0,last=performance.now();
 const timer=setInterval(()=>{const now=performance.now();ticks++;maxGap=Math.max(maxGap,now-last);last=now;},5);
 try {
  const start=performance.now();const cold=await client.request('spend','full',true,path.join(root,'cache.json'));const coldMs=performance.now()-start;
  const warmStart=performance.now();const warm=await client.request('spend','full',true,path.join(root,'cache.json'));const warmMs=performance.now()-warmStart;
  assert.equal(cold.today.inputTokens,12345);assert.equal(cold.today.nanoAiu,1500000000);assert.deepEqual(cold.today,warm.today);assert(ticks>2);assert(maxGap<500);
  console.log(JSON.stringify({sizeMiB:written/1024/1024,coldMs,warmMs,heartbeatTicks:ticks,maxHostGapMs:maxGap,totalsAgree:true},null,2));
 }finally{clearInterval(timer);client.dispose();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
