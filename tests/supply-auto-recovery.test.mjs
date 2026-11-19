import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverableSupply} from '../src/supplyAutoRecovery.js';

test('automatic recovery waits for the original writer and resumes only an accepted create/append identity',()=>{
  const now=Date.now(), operation={id:'c27bca81-78bf-43a0-b779-07ba522e6057',action:'create',status:'writing',updatedAt:new Date(now-20000).toISOString(),steps:[{status:'verified'},{status:'writing'}]};
  const original=structuredClone(operation);
  assert.equal(recoverableSupply(operation,true,0,now),false);
  assert.equal(recoverableSupply(operation,false,0,now),true);
  assert.equal(recoverableSupply({...operation,updatedAt:new Date(now).toISOString()},false,0,now),false);
  assert.equal(recoverableSupply({...operation,status:'verified'},false,0,now),false);
  assert.equal(recoverableSupply({...operation,action:'deletePart'},false,0,now),false);
  assert.equal(recoverableSupply({...operation,id:'new-id'},false,0,now),false);
  assert.equal(recoverableSupply(operation,false,5,now),false);
  assert.deepEqual(operation,original);
});
