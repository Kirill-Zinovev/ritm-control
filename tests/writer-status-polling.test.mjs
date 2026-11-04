import test from 'node:test';
import assert from 'node:assert/strict';
import {startWriterStatusPolling} from '../src/writerStatusPolling.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('checks busy state repeatedly without overlapping and stops after cleanup',async()=>{let calls=0,active=0,max=0;const stop=startWriterStatusPolling(async()=>{calls++;active++;max=Math.max(max,active);await wait(15);active--},5);await wait(48);stop();const before=calls;await wait(25);assert.ok(before>=2);assert.equal(calls,before);assert.equal(max,1)});
test('cleanup cancels a scheduled check',async()=>{let calls=0;const stop=startWriterStatusPolling(async()=>{calls++},20);stop();await wait(35);assert.equal(calls,0)});
