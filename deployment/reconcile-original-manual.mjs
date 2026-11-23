import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {withHandoffLock} from '../scripts/handoff-lock.mjs';
import {HandoffState} from '../scripts/handoff-state.mjs';
import {originalManualDelivery} from '../scripts/manual-delivery-fact.mjs';
import {privateDirectory,privateFile,validateLiveConfig} from '../scripts/run-handoff.mjs';
import {queryScheduled} from '../scripts/scheduled-delivery-bridge.mjs';

// One-time operator command for the verified November 21 manual delivery.
const id = 'morning-20261121-r1';
if (process.argv.length !== 3) throw Error('Expected the active Publisher configuration path');
const config = validateLiveConfig(JSON.parse(await privateFile(process.argv[2], 16384)));
await privateDirectory(config.state_dir);
const changed = await withHandoffLock(config.state_dir, async () => {
  const filename = path.join(config.state_dir, 'handoff.sqlite');
  await privateFile(filename, Number.MAX_SAFE_INTEGER, false);
  const db = new DatabaseSync(pathToFileURL(filename).href + '?mode=rw');
  try { return await reconcile(db); }
  finally { db.close(); }
});
console.log(JSON.stringify({request_id: id, delivery_kind: 'manual_initial', changed}));

async function reconcile(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM scheduled_handoffs WHERE request_id=?').get(id);
    if (!row) throw Error('Original scheduled handoff missing');
    const stored = JSON.parse(row.result);
    const prior = row.phase === 'complete' ? stored?.reconciliation?.previous : {...row};
    if (prior?.request_id !== id || prior.phase !== 'admission_pending' ||
        prior.binding !== row.binding || prior.poll_order !== row.poll_order) {
      throw Error('Original scheduled handoff differs');
    }
    // Use the service's job decoder without running its schema-initializing constructor.
    const observed = originalManualDelivery({db, get: HandoffState.prototype.get}, config, id, prior);
    if (observed?.delivery_kind !== 'manual_initial' || observed.status !== 'sent' ||
        observed.phase !== 'complete' || observed.parts_sent !== 2 || observed.parts_total !== 2) {
      throw Error('Verified original manual receipt required');
    }
    const scheduled = await queryScheduled(config.scheduled_delivery, {action: 'status', request_id: id});
    if (!isDeepStrictEqual(scheduled, {status: 'not_found'})) throw Error('Original automatic admission is not absent');
    const result = {...observed, reconciliation: {previous: prior}};
    if (row.phase === 'complete') {
      if (!isDeepStrictEqual(stored, result)) throw Error('Recorded manual delivery differs');
      db.exec('COMMIT');
      return false;
    }
    const update = db.prepare("UPDATE scheduled_handoffs SET phase='complete',result=? WHERE request_id=? AND phase='admission_pending'");
    if (update.run(JSON.stringify(result), id).changes !== 1) throw Error('Original scheduled handoff changed');
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
