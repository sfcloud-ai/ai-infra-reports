import test from 'node:test';
import assert from 'node:assert/strict';
import {researchMicros,receiptMicros,researchTimeNotBefore} from '../scripts/research-time.mjs';
test('receipt ordering retains all six microsecond digits',()=>{
 const receipt=receiptMicros('1793492110.123456');
 const base=new Date(1793492110123).toISOString();
 assert(researchMicros(base.replace('.123Z','.123900Z'))>receipt);
 assert(researchMicros(base.replace('.123Z','.123100Z'))<receipt);
 assert.equal(researchMicros(base.replace('.123Z','.123456Z')),receipt);
 assert.equal(researchMicros('2026-11-06 07:20:00.123456+08:00'),researchMicros('2026-11-05T23:20:00.123456Z'));
 assert.equal(researchMicros('2026-11-06'),null);assert.equal(receiptMicros('invalid'),null);
});
test('chronology retains fractions beyond the dispatch receipt precision',()=>{
 assert.equal(researchMicros('2026-11-06T07:20:00z'),null);
 assert.equal(researchTimeNotBefore('2026-11-06T07:20:00.123456789Z','2026-11-06T07:20:00.123456790Z'),false);
 assert.equal(researchTimeNotBefore('2026-11-06T07:20:00.100Z','2026-11-06T07:20:00.1Z'),true);
});
test('chronology uses the late record precision interval without inventing detail',()=>{
 assert.equal(researchTimeNotBefore('2026-11-06T07:22:00Z','2026-11-06T07:22:00.900000Z'),true);
 assert.equal(researchTimeNotBefore('2026-11-06T07:22:00.100Z','2026-11-06T07:22:00.800Z'),false);
 assert.equal(researchTimeNotBefore('2026-11-06T07:22:00.1234561Z','2026-11-06T07:22:00.1234563Z'),false);
 assert.equal(researchTimeNotBefore('2026-11-06T07:22:00.1234561Z','2026-11-06T07:22:00.1234561Z'),true);
});
