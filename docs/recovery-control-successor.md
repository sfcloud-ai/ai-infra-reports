# Explicit successor for an ungranted recovery command

This is an operator-only exceptional path, not a scheduled retry. It does not
reset an unknown upload, copy a journal, reuse a grant, or upload another bundle.
Use it only when the original recovery process has stopped, the original cloud
journal remains available, its replacement bundle upload is acknowledged, and
there is no `final_complete` intent of any phase. T4 must still show the original
recovery authorization as unused and the notice exactly unchanged.

The old control command may exist on Slack and may arrive late. An atomic T4
fence denies every recovery command except the newly bound command ID and hash.
A database trigger also rejects consumption by an older Publisher executable.
Old command bytes, owner, unknown share and original grant remain immutable
history. The replacement report file is reused unchanged. If T4 already issued
the old grant, this path refuses recovery and requires read-only reconciliation.

## Procedure

1. Verify the old process is stopped. Never infer non-delivery from an empty
   Slack search. Check the original `final_complete`, Publisher and relay state.
2. Generate a plan in the ORIGINAL cloud journal environment:

   `node scripts/native-recovery-successor-cli.mjs ORIGINAL_OPERATOR.json plan SUCCESSOR_ID`

3. Save that exact `successor-plan` JSON to a private file and fence locally:

   `node scripts/native-recovery-successor-cli.mjs ORIGINAL_OPERATOR.json fence PLAN.json --confirm-original-owner-stopped`

   Save the resulting `successor-fenced` JSON. No old operation is edited, and
   the run does not change phase. This step permanently fences the old host.
   If a prior CLI persisted the fence but mislabeled its output, do not fence
   again or edit that output. Read the existing fence using:

   `node scripts/native-recovery-successor-cli.mjs ORIGINAL_OPERATOR.json inspect SUCCESSOR_ID --confirm-original-owner-stopped`

   This opens the original journal read-only, verifies its scope, plan hash,
   stopped-owner authorization, unchanged source/unknown-share evidence and
   absence of any successor begin or final intent, then emits `successor-fenced`.
4. Deploy the reviewed code to T4 under the existing code-update procedure,
   retaining the same service identity/configuration/state. Stop old service
   processes before authorizing. Do not migrate or replace active SQLite state.
5. Transfer only the fenced plan (no credentials) to T4. Run the local operator
   CLI as root with existing config; it checks publication, relay activity and
   original source before writing the authorization as the service owner:

   `node scripts/authorize-recovery-successor.mjs CONFIG.json FENCED.json REFERENCE --confirm-original-journal-fenced-and-owner-stopped`

6. In the original cloud environment, run once through the unchanged
   `driveRemoteNativeHost` from this commit, budget at most 30 minutes:

   `node scripts/native-recovery-successor-cli.mjs ORIGINAL_OPERATOR.json run SUCCESSOR_ID`

   The CLI uses the existing hex terminal framing and raw input handling. A
   second executor cannot change the live winner's state or steal its grant.
   A stopped executor with a grant cannot be restarted to send. Unknown writes
   remain read-only reconciliation; never delete the successor fence to retry.
   A new begin needs at least three minutes remaining after publication reads.
   An outstanding call that exhausts the remaining slice still cannot be replayed.
7. `complete` means the independent Slack check and `record_bundle` succeeded.
   Verify the relay's text and image parts separately before reporting WeCom
   success. Nothing in this procedure sends a test to a formal destination.

## Diagnostic evidence

The original cloud journal gains append-only runtime observations in
`native_transport_audit`: ticket requested/received, known file ID, POST started
and HTTP response, complete started/returned, safe error names/network codes.
Signed upload URLs, raw tool bodies and error messages are never persisted.
These observations do not themselves authorize retries. Existing failures from
before this patch cannot be reconstructed from missing audit rows.
