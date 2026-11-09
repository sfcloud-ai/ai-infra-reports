# Designated T4 Producer journal

This opt-in extension keeps the existing upload protocol and original Publisher
and scheduler ledgers. It adds a host-local admission fence and an explicit direct
TLS transport policy. The source changes and offline tests do not activate a
deployment. No daily launcher, report generation, Slack write or delivery is
installed by these modules.

## Explicit offline cutover

Use the pinned Node 24 runtime and dependencies. Preserve the original cloud
journal, bundle bytes and uncertain-operation evidence. A new T4 journal cannot
reconstruct that history or authorize replay of an unresolved report.

Before changing an installation, stop the old Producer execution path and retain
its isolation evidence. Reconcile the complete Publisher intake scan, pending
uploads and scheduler date claims. Record all unresolved original dates in the
quarantine inventory; an empty request-only lookup is insufficient. Retain all
existing Publisher jobs, inbox rows and scopes. Pause Publisher consumption
through the existing operator procedure while installing the coordinated fence.

The following are trusted local setup APIs, not remotely callable commands:

1. Choose an owner-only persistent Producer directory and create its private
   `runner.lock` once. Initialize an empty journal with the existing four-field
   native operator configuration and `--initialize` as described in
   [producer-upload.md](producer-upload.md). Keep a new bundle's path separate.
2. Hold the original exclusive `runner.lock` through setup. If abandoned-ticket
   restart recovery is approved, run `--enable-restart-recovery REFERENCE`
   **before** installing the admission/transport policies. It binds the original
   journal and lock inodes; it never recovers an uncertain POST or COMPLETE.
3. Add `producer_fence` to the existing Publisher configuration. Its exact fields
   are `generation` (UUIDv4), `activation_ts` (Slack timestamp),
   `producer_scope_sha256` (`producerScopeHash(scope)`), and `installation`.
   The installation contains string-valued `journal_device`, `journal_inode`,
   `lock_device`, and `lock_inode`, measured from the designated original files.
   Durable intake and scheduled delivery must already be configured.
4. While retaining the Producer lock, acquire the Publisher's original outer
   lock with `withHandoffLock`. Validate the Publisher config and original scope;
   call `installFence(publisher.db, config.producer_fence, evidenceReference,
   unresolvedDates)` from `producer-admission-fence.mjs`. Existing fence tables
   cause rejection. This step never removes or recreates downstream state.
5. Under the same locks, call `installProducerAdmissionPolicy(producer,
   absolutePublisherConfigFile, config)` and, only with separate direct-egress
   authorization, `installT4DirectTransportPolicy(producer, reference)` from
   `producer-local-admission.mjs`. These require an empty new Producer journal.
   Record and verify each committed setup step. If setup is interrupted, leave
   execution paused and inspect the installed policies; do not delete/recreate
   journals or rerun all setup functions blindly.
6. Add `publisher_fence_config_file` to the native Producer operator config,
   pointing to that absolute private Publisher configuration. Check both
   installed policies and the fence before resuming consumption and enabling
   exactly one designated launcher. Keep the original files/inodes across runs.

The launcher must inherit an exclusive lock, for example:

```sh
flock --nonblock --no-fork /private/producer/runner.lock \
  /pinned/node scripts/producer-upload-cli.mjs \
  /private/producer/operator.json --serve-t4-direct
```

The paths above are placeholders. The native-tool orchestrator remains
responsible for executing and returning the actual one-shot native actions.
Direct TLS retains host verification, HTTPS only, no redirects and no curl
retries. An installed direct policy cannot silently switch to another mode.
An admission-only installation without direct authorization must use
`--serve-managed-proxy` with its existing approved proxy configuration. Fenced
installations reject the legacy `--serve` flag.

## Failure and upgrade behavior

The CLI verifies the original journal, lock identity, policies, Publisher scope
and fence before preparing work. Before COMPLETE, it acquires the Publisher
lock, records the exact request/date/hash/file/operation grant, releases the lock,
and only then emits the native action. Ordinary lock contention leaves no
COMPLETE intent. A crash after the intent commit remains unknown and is never
automatically replayed, including a crash before action emission.

Unregistered or obsolete uploads remain in the inbox as `fenced`; they are not
downloaded or admitted. Eligible original jobs continue with their exact
bindings. Post-cutover ineligible envelopes cannot block future-date inspection;
pre-cutover ambiguous dates and explicitly quarantined dates still block.
No quarantine-removal API is supplied by this change.

The deployment controller recognizes only the exact fence schema, fingerprints
all its rows, and rechecks a fenced envelope's ineligibility before treating it
as settled. Pending or newly eligible intake continues to defer a switch. Deploy
the matching controller support before activating the fence; activation against
an older controller would block later upgrades.

The Linux CLI integration test uses real flock and SQLite with synthetic native
replies and curl. It validates restart and contention behavior without proving
live Slack delivery, daily orchestration, Pages publication or notification
receipts. Those are separate activation checks.
