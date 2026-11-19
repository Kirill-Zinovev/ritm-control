import test from 'node:test';
import assert from 'node:assert/strict';
import {departmentMoveAvailability} from '../src/departmentMoveAvailability.ts';
const ready={shipmentId:'supply',disabled:false,printed:0,cut:0};
test('unstarted linked position can move',()=>assert.equal(departmentMoveAvailability(ready),null));
test('printing or cutting explains why a completed position cannot move',()=>{for(const key of ['printed','cut']){const result=departmentMoveAvailability({...ready,[key]:1});assert.equal(result.label,'Работа начата');assert.match(result.reason,/до начала работы/);}});
test('legacy position without registry explains the missing link',()=>assert.equal(departmentMoveAvailability({...ready,shipmentId:''}).label,'Нет связи участков'));
test('temporary source lock keeps its actual explanation',()=>{const result=departmentMoveAvailability({...ready,disabled:true,disabledReason:'Источник обновляется'});assert.equal(result.reason,'Источник обновляется');});
