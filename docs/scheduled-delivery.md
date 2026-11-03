# Optional Publisher to T4 bridge

The optional `scheduled_delivery` Publisher configuration hands independently
published reports to the companion scheduler in `sfcloud-ai/ai-infra-brief`.
Actions continues to publish the reports. The relay owns timing, deduplication,
retry and WeCom receipts; a native Slack final DM is no longer a prerequisite for
this path. The report intake channel and its existing authenticated sender
contract are still used.

An example configuration fragment (all paths and IDs are placeholders):

```json
{
  "scheduled_delivery": {
    "activation_date": "2026-11-04",
    "executable": "/usr/bin/python3",
    "args": [
      "/opt/relay-client/scheduled_client.py",
      "--socket", "/scheduled-ipc/scheduled.sock",
      "--reader-uid", "2002"
    ]
  }
}
```

The activation date must match the relay's separately reviewed boundary. The
client is trusted local code, never chosen by a report payload. Its endpoint
checks and kernel peer credentials must match the relay service UID. No OAuth
credential or destination is accepted by this interface. Adding the bridge
preserves the original handoff scope; its own configuration is pinned in a
separate durable scope and later changes require reconciliation.

Each bounded tick queries the original request ID before admission. Admission
carries the original bundle bytes and source commit; an uncertain response is
resolved by querying that ID on the next tick. A lost Slack publication receipt
does not prevent scheduling and is not resent. A WeCom result is complete only
when the original binding matches and all real parts have confirmed receipts.
Unknown outcomes remain visible and are never reported as sent.

The existing authenticated intake sender may issue `!ai-report status REQUEST_ID`
without uploading a file. The reply is advisory, uses the original thread, and
reconciles an uncertain reply without posting again.

`scripts/verify-scheduled-delivery.mjs --serve` is the fixed local verifier for
the relay. It checks the bundle, source commit, live Pages content and original
images. Only immutable GitHub source evidence is cached within that process;
live publication and image checks remain mandatory. `--history` verifies only
an immutable historical source for migration and explicitly grants no delivery
authority. Install the full pinned source/dependencies under Node 24.22.2.

Both changes can be reviewed independently while the feature remains disabled.
Before activation, the relay change and this verifier must both be installed,
historical date claims reconciled, and unresolved native intents assessed.
This PR does not install or enable a service. Merging to main can trigger the
existing Pages and Publisher release paths; coordinate those separately.
