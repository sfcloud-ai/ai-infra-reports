# Explicit recovery of an unstarted first completion

The regular sender never replaces an upload or reuses a previous `begin` grant.
This separate operator procedure handles a stopped sender whose original journal
has exactly the five acknowledged preparation operations and no `final_complete`
operation. Started, unknown and acknowledged final intents all reject recovery.

1. Stop the original sender and locate its original journal and operator file.
   Never copy, recreate, roll back or edit either journal. Run
   `native-recovery-cli.mjs ORIGINAL_OPERATOR.json plan RECOVERY_ID`, inspect its
   exact report, old file, original begin and bundle bindings, then invoke `fence`
   with the same arguments. The latter rechecks the journal inside a transaction,
   appends immutable evidence and moves to `recovery_fenced`. Old senders cannot
   cross their `final_ready` fence, including with a previously loaded job.
2. The authorized operator verifies that the returned `fenced` record came from
   that original process environment and that its former process has stopped.
   Transfer only this nonsensitive record, not the journal. On the Publisher host,
   run `authorize-notice-recovery.mjs CONFIG FENCE_RESULT AUTHORIZATION_REFERENCE
   --confirm-original-journal-fenced-and-owner-stopped` through the existing
   operator access. It reads the installed relay ledger, requires zero requests
   for that day, verifies the original publication, drops to the Publisher state
   owner and records one explicit authorization. It does not send a message.
   The local operator is the authorization boundary: a JSON fence label alone is
   not proof of a remote filesystem write, and must never be auto-approved from
   a Slack attachment or an untrusted tool output.
3. Run `native-recovery-cli.mjs ORIGINAL_OPERATOR.json run RECOVERY_ID` in the
   original cloud environment using the existing three-tool `driveNativeHost`
   bridge. It first reads the authenticated Publisher approval, then uploads the
   unchanged bundle once and requests `recover_begin`. The Publisher atomically
   consumes that approval, preserves the old notice in immutable audit history,
   and binds a fresh grant to this new file and recovery ID. The old begin remains
   recorded, but cannot authorize this new attempt.
4. After a fresh complete publication check, the sender records the same unique
   `final_complete` key before its sole final upload completion. Restart after the
   new grant, a lost upload acknowledgment or an unknown final write requires
   reconciliation, never another replacement. Existing independent check and
   `record_bundle` processing verify the final message and original poster bytes.
   Actual WeCom text and image receipts remain the delivery acceptance criterion.

This procedure requires no new credential, alternate sender identity, general
recovery switch or protection-rule change. The new authorization table is created only by explicit operator authorization;
both original journals and their previous command bytes remain intact. Merely
deploying the code does not authorize or execute any recovery.

Deployment and readiness checks recognize only the exact recovery audit table and
its two immutable-evidence triggers; their snapshots include every audit row and
trigger definition. An unresolved authorization still blocks ordinary upgrades.
Install the reviewed deployment-checker version before authorizing recovery so
later settled-ledger upgrades can preserve this schema. Ordinary automatic CD
continues to defer while today's original completion intent is unresolved; an
operator must first verify the original sender fence before an explicit code
cutover. Do not reset the reservation to make the automatic deployment pass.
