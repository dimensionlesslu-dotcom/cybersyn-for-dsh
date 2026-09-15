import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRun, run, inspect, reviseGoal } from '../runtime/runner.mjs'
import { validateTask, parseAction, selectSupport } from '../runtime/contract.mjs'
import { readArtifact, writeArtifact } from '../runtime/files.mjs'
import { acquire, readJournal, Journal, requestCancel } from '../runtime/journal.mjs'
import { complete, validateBackend } from '../runtime/backend.mjs'

const task = () => ({id:'simple-doc',objective:'Write a verified short report',requirements:[{id:'R1',description:'Report has the requested content',check:{kind:'text-equals',path:'report.md',expected:'# Result\nVerified.\n'}}],writablePaths:['report.md']})
const write = () => ({action:'write',path:'report.md',content:task().requirements[0].check.expected,expected_hash:null})
function fixture(t, responses, options={}) {
  const base=mkdtempSync(join(tmpdir(),'cybersyn-v3-')), workspace=join(base,'work'),directory=join(base,'state')
  t.after(()=> { const safe=realpathSync(base); assert.ok(safe.startsWith(realpathSync(tmpdir())) && safe.includes('cybersyn-v3-')); rmSync(safe,{recursive:true,force:true}) })
  createRun({task:options.task??task(),workspace,directory,backend:{type:'fixture',responses},limits:options.limits})
  return {base,workspace,directory}
}

test('strong model defaults to standalone MD; unavailable support is explicit',()=>{
  assert.equal(selectSupport().recommended,'T1')
  assert.deepEqual(selectSupport(['sequencing']).status,'capability-missing')
  assert.equal(selectSupport(['memory'],false,['T1','T2']).recommended,'T2')
  assert.throws(()=>selectSupport(['intelligence-score']))
})
test('simple report is actually written and freshly verified',async t=>{
  const f=fixture(t,[write(),{action:'finish'}]); const result=await run(f.directory)
  assert.equal(result.accepted,true); assert.equal(result.observation_kind,'fixture')
  assert.equal(readFileSync(join(f.workspace,'report.md'),'utf8'),write().content)
  writeFileSync(join(f.workspace,'report.md'),'changed')
  assert.equal(inspect(f.directory).accepted,false);assert.ok(inspect(f.directory).issues.includes('current-artifact'))
})
test('JSON project verifies semantic equality independent of key order',async t=>{
  const spec=task();spec.requirements[0].check={kind:'json-equals',path:'report.md',expected:{total:3,items:[1,2]}}
  const f=fixture(t,[{...write(),content:'{"items":[1,2],"total":3}'},{action:'finish'}],{task:spec})
  assert.equal((await run(f.directory)).accepted,true)
})
test('malformed task and action inputs are rejected',()=>{
  for(const bad of [null,[],{}, {...task(),requirements:[]},{...task(),readablePaths:{}},{...task(),constraints:1},{...task(),writablePaths:['../outside']},{...task(),requirements:[task().requirements[0],task().requirements[0]]}]) assert.throws(()=>validateTask(bad))
  for(const bad of ['not json','null','[]',{action:'shell',command:'anything'},{action:'finish',evidence:['trust me']},{...write(),expected_hash:undefined},{...write(),path:'../outside'},{...write(),path:'NUL.txt'},{...write(),path:'C:/outside'}]) assert.throws(()=>parseAction(bad))
  assert.throws(()=>validateBackend({type:'pi',provider:'x',model:'x',apiKey:'do-not-store'}))
})
test('bad model JSON has bounded repair and cannot finish',async t=>{
  const f=fixture(t,['bad','bad','bad']); const result=await run(f.directory)
  assert.equal(result.status,'blocked');assert.equal(result.counters.modelCalls,2);assert.equal(result.accepted,false)
})
test('unknown tools, forged evidence and ungranted paths do not execute',async t=>{
  for(const bad of [{action:'shell',command:'whoami'},{action:'finish',evidence:[{status:'passed'}]},{...write(),path:'events.jsonl'},{...write(),path:'../state/events.jsonl'}]) {
    const f=fixture(t,[bad],{limits:{maxRepairs:1}});const result=await run(f.directory)
    assert.equal(result.status,'blocked');assert.equal(existsSync(join(f.workspace,'report.md')),false)
  }
})
test('finish cannot pass a missing or wrong artifact',async t=>{
  const f=fixture(t,[{...write(),content:'wrong'},{action:'finish'},{action:'finish'},{action:'finish'},{action:'finish'}])
  const result=await run(f.directory);assert.equal(result.accepted,false);assert.equal(result.status,'blocked')
  assert.equal(result.ledger[0].status,'failed')
})
test('model steps and token budget are retained on resume',async t=>{
  const f=fixture(t,[write(),{action:'finish'}],{limits:{maxSteps:1}})
  const first=await run(f.directory,{stopAfter:1});assert.equal(first.status,'paused')
  const result=await run(f.directory);assert.equal(result.status,'budget_exhausted');assert.equal(result.counters.modelCalls,1);assert.equal(result.counters.tokens,first.counters.tokens)
  const second=fixture(t,[write()],{limits:{maxTokens:1,maxOutputTokens:1}})
  assert.equal((await run(second.directory)).counters.modelCalls,0)
})
test('repeated reads stop as no progress',async t=>{
  const f=fixture(t,Array(8).fill({action:'read',path:'report.md'}))
  const result=await run(f.directory);assert.equal(result.status,'blocked');assert.equal(result.counters.modelCalls,4)
})
test('goal revision clears evidence but retains resource counters',async t=>{
  const f=fixture(t,[write(),{action:'verify'},{action:'finish'}]);const first=await run(f.directory,{stopAfter:2})
  assert.equal(first.ledger[0].status,'passed'); const spec=task();spec.objective='Revised';spec.requirements[0].check.expected='different'
  const revised=reviseGoal(f.directory,spec,1);assert.equal(revised.goal_revision,2);assert.deepEqual(revised.ledger,[]);assert.deepEqual(revised.counters,first.counters)
  assert.throws(()=>reviseGoal(f.directory,{...spec,requirements:[{...spec.requirements[0],check:{...spec.requirements[0].check,path:'secret'}}]},2))
  assert.equal((await run(f.directory,{stopAfter:1})).accepted,false)
})
test('required environment conditions must have valid confirmation evidence',async t=>{
  const spec=task();spec.conditions=[{id:'target',status:'unknown',required:true}]
  const f=fixture(t,[write(),{action:'finish'}],{task:spec});const result=await run(f.directory,{stopAfter:2})
  assert.equal(result.accepted,false);assert.ok(result.issues.includes('required-conditions-confirmed'))
})
test('pending write is reconciled before resume, before and after side effect',async t=>{
  for (const alreadyApplied of [false,true]) {
    const f=fixture(t,[write(),{action:'finish'}])
    await assert.rejects(run(f.directory,{afterPrepared:()=>{if(alreadyApplied)writeFileSync(join(f.workspace,'report.md'),write().content);throw new Error('injected crash')}}))
    assert.equal(readJournal(f.directory).state.pending.kind,'tool')
    const result=await run(f.directory);assert.equal(result.accepted,true);assert.equal(result.counters.modelCalls,2)
    const records=readFileSync(join(f.directory,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(records.some(e=>e.kind==='tool.reconciled'&&e.detail.outcome===(alreadyApplied?'already-applied':'applied-after-check')))
  }
})
test('uncertain conflicting write halts instead of overwriting',async t=>{
  const f=fixture(t,[write(),{action:'finish'}]);await assert.rejects(run(f.directory,{afterPrepared:()=>{writeFileSync(join(f.workspace,'report.md'),'external edit');throw new Error('crash')}}))
  assert.equal((await run(f.directory)).status,'indeterminate');assert.equal(readFileSync(join(f.workspace,'report.md'),'utf8'),'external edit')
})
test('torn journal tail recovers unicode; complete corruption fails',async t=>{
  const f=fixture(t,[write(),{action:'finish'}]);await run(f.directory,{stopAfter:1})
  appendFileSync(join(f.directory,'events.jsonl'),'{"partial":"中文')
  assert.equal(inspect(f.directory).truncated_tail,true);assert.equal((await run(f.directory)).accepted,true)
  appendFileSync(join(f.directory,'events.jsonl'),'{"digest":"corrupt"}\n')
  assert.throws(()=>inspect(f.directory),{code:'CORRUPT_LOG'})
})
test('single writer lock rejects simultaneous writers',async t=>{
  const f=fixture(t,[write()]);const release=acquire(f.directory)
  try {await assert.rejects(run(f.directory),{code:'LOCKED'})} finally {release()}
})
test('cancel interrupts a pending model request before writing',async t=>{
  const f=fixture(t,[{fixture_delay_ms:2000,response:write()}]);const pending=run(f.directory)
  const timer=setTimeout(()=>requestCancel(f.directory),20)
  const result=await pending;clearTimeout(timer);assert.equal(result.status,'cancelled');assert.equal(existsSync(join(f.workspace,'report.md')),false)
})
test('provider timeout is bounded and credentials are never inferred',async t=>{
  const f=fixture(t,[{fixture_delay_ms:2000,response:write()}],{limits:{callTimeoutMs:10,maxRepairs:1}})
  assert.equal((await run(f.directory)).status,'blocked')
  await assert.rejects(complete({type:'pi',provider:'x',model:'x',apiKeyEnv:'CYBERSYN_SELFTEST_ABSENT_KEY'},'{}',0,{signal:new AbortController().signal,maxTokens:1}),{code:'CREDENTIAL_MISSING'})
})
test('needs_input requires a real reply before another model call',async t=>{
  const f=fixture(t,[{action:'need_input',reason:'Need report confirmation'},write(),{action:'finish'}]);const first=await run(f.directory)
  assert.equal(first.status,'needs_input');assert.equal((await run(f.directory)).counters.modelCalls,1)
  assert.equal((await run(f.directory,{input:'Use the agreed report text'})).accepted,true)
})
test('trusted state cannot be inside workspace and linked paths are denied',t=>{
  const f=fixture(t,[write()]);assert.throws(()=>createRun({task:task(),workspace:f.workspace,directory:join(f.workspace,'state'),backend:{type:'fixture',responses:[write()]}}))
  const elsewhere=join(f.base,'elsewhere');mkdirSync(elsewhere);symlinkSync(elsewhere,join(f.workspace,'linked'),'junction')
  assert.throws(()=>readArtifact(f.workspace,'linked/secret'),{code:'PATH_DENIED'})
  writeArtifact(f.workspace,'report.md','one',null);assert.throws(()=>writeArtifact(f.workspace,'report.md','two',null),{code:'ARTIFACT_CONFLICT'})
})

test('cancel after a crash prevents recovery from applying a pending write',async t=>{
  const f=fixture(t,[write(),{action:'finish'}]);await assert.rejects(run(f.directory,{afterPrepared:()=>{throw new Error('crash')}}))
  requestCancel(f.directory);assert.equal((await run(f.directory)).status,'cancelled')
  assert.equal(existsSync(join(f.workspace,'report.md')),false)
})
test('lost model response retains its reserved token budget on recovery',async t=>{
  const f=fixture(t,['lost',write(),{action:'finish'}]);const journal=new Journal(f.directory),state=journal.state
  state.counters.tokens=10000;state.counters.modelCalls=1;state.pending={kind:'model',reservation:10000};journal.append('model.requested',state)
  const result=await run(f.directory);assert.equal(result.accepted,true);assert.ok(result.counters.tokens>10000);assert.equal(result.counters.modelCalls,3)
})
