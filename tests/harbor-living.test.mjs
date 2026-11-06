import test from 'node:test';
import assert from 'node:assert/strict';
import {JOBS} from '../src/data/jobs.js';
import {createPlayerState, restoreHarborPocket, jobStatus, serviceStatus,HARBOR_SERVICES} from '../src/three/playerstate.js';

const find=id=>HARBOR_SERVICES.find(x=>x.id===id);
const job=id=>JOBS.find(x=>x.id===id);
test('four unique vendor activities are real jobs, expenses or recovery',()=>{
 assert.equal(HARBOR_SERVICES.length,4);
 assert.equal(new Set(HARBOR_SERVICES.map(x=>x.id)).size,4);
 const p=createPlayerState();
 assert.equal(p.money,240);assert.equal(p.energy,100);assert.equal(p.shiftsWorked,0);
 assert.equal(p.inventory.bicycle,false);assert.equal(p.skills.focus,0);
 assert.equal(p.service('nonexistent',480).ok,false);
 assert.equal(p.service('noodles',480).ok,false,'cannot buy energy above full energy');
});
test('work shift earns pay and costs energy, then meal consumes real cash and time',()=>{
 const p=createPlayerState();const market=job('market_haul');
 const work=p.work(market,480);
 assert.equal(work.ok,true);assert.equal(work.pay,38);assert.equal(p.money,278);
 const before=p.energy;
 const meal=p.service('noodles',480+work.minutes);
 assert.equal(meal.ok,true);assert.equal(meal.cost,12);assert.equal(meal.minutes,35);
 assert.equal(p.money,266);assert.equal(p.energy,Math.min(100,before+23));
 assert.equal(p.mealsEaten,1);
 assert.equal(p.service('noodles',10000).ok,false);
});
test('rest is free but consumes 130 city minutes; recovery has hard 100 ceiling',()=>{
 const p=createPlayerState();p.energy=30;const before=p.money;
 const result=p.service('rest',540);
 assert.equal(result.ok,true);assert.equal(result.minutes,130);assert.equal(p.energy,57);
 assert.equal(p.money,before);assert.equal(p.restsTaken,1);
 p.energy=100;
 assert.equal(p.service('rest',780).ok,false);
 assert.equal(p.restsTaken,1);
});
test('buying a bike really unlocks courier work and can never charge twice',()=>{
 const p=createPlayerState();const courier=job('courier_run');
 assert.equal(jobStatus(courier,720,p).workable,false);
 const r=p.service('bicycle',550);
 assert.equal(r.ok,true);assert.equal(r.cost,95);assert.equal(p.money,145);
 assert.equal(p.inventory.bicycle,true);
 assert.equal(jobStatus(courier,720,p).workable,true);
 const before=JSON.stringify(p.snapshot(1,550));
 assert.equal(p.service('bicycle',650).ok,false);
 assert.equal(JSON.stringify(p.snapshot(1,550)),before);
 const pay=p.work(courier,720);
 assert.equal(pay.ok,true);assert.equal(pay.pay,30);
 assert.equal(p.shiftsWorked,1);
});
test('2 paid practice sessions, not fake XP, open the civic records desk',()=>{
 const p=createPlayerState();
 const desk=job('civic_filing');
 assert.equal(jobStatus(desk,570,p).workable,false);
 p.energy=60;
 assert.equal(p.service('study',500).ok,true);
 assert.equal(p.skills.focus,5);assert.equal(p.money,222);assert.equal(p.energy,52);
 assert.equal(jobStatus(desk,570,p).workable,false);
 assert.equal(p.service('study',620).ok,true);
 assert.equal(p.skills.focus,10);assert.equal(p.money,204);assert.equal(p.energy,44);
 assert.equal(jobStatus(desk,800,p).workable,true);
 const before=JSON.stringify(p.snapshot(1,800));
 assert.equal(p.service('study',800).ok,false);
 assert.equal(JSON.stringify(p.snapshot(1,800)),before);
});
test('insufficient cash, fatigue and closed time have no partial effects',()=>{
 const p=createPlayerState();p.energy=5;p.money=4;
 for(const id of ['noodles','bicycle','study']){
  const frozen=JSON.stringify(p.snapshot(1,960));
  assert.equal(p.service(id,960).ok,false);
  assert.equal(JSON.stringify(p.snapshot(1,960)),frozen);
 }
 p.energy=40;p.money=400;
 const before=JSON.stringify(p.snapshot(1,1410));
 for(const id of HARBOR_SERVICES.map(x=>x.id))assert.equal(p.service(id,1410).ok,false);
 assert.equal(JSON.stringify(p.snapshot(1,1410)),before);
});
test('job requirements still enforce actual work windows, energy and remaining hours',()=>{
 const p=createPlayerState();
 assert.equal(jobStatus(job('market_haul'),480,p).workable,true);
 assert.equal(jobStatus(job('market_haul'),1000,p).workable,false);
 assert.equal(jobStatus(job('harbour_labour'),800,p).workable,true);
 p.energy=2;
 assert.equal(jobStatus(job('harbour_labour'),800,p).workable,false);
});
test('persistent pocket snapshots restore real purchases, skills and time',()=>{
 const p=createPlayerState();p.energy=50;
 p.service('bicycle',570);p.service('study',640);
 p.service('noodles',750);
 const saved=p.snapshot(4,821.35);
 const loaded=restoreHarborPocket(JSON.parse(JSON.stringify(saved)));
 assert.equal(loaded.day,4);assert.equal(loaded.minute,821);
 const restored=createPlayerState(loaded);
 assert.deepEqual(restored.snapshot(4,821),saved.minute===821?saved:{...saved,minute:821});
 assert.equal(restored.inventory.bicycle,true);assert.equal(restored.skills.focus,5);
 assert.equal(restored.money,115);assert.equal(restored.mealsEaten,1);
 assert.equal(restored.studySessions,1);
});
test('untrusted or old-version save does not inject cash, skills or items',()=>{
 assert.equal(restoreHarborPocket(null),null);
 assert.equal(restoreHarborPocket({version:3,money:999999}),null);
 const s=restoreHarborPocket({version:1,money:NaN,energy:-500,shiftsWorked:Infinity,
   inventory:{bicycle:'yes',weapon:true},skills:{focus:Infinity,cheat:100},
   day:NaN,minute:90000,mealsEaten:-40,studySessions:999});
 assert.equal(s.money,240);assert.equal(s.energy,0);assert.equal(s.inventory.bicycle,false);
 assert.equal(s.skills.focus,0);assert.equal(s.day,1);assert.equal(s.minute,1439);
 assert.equal(s.studySessions,2);
});
