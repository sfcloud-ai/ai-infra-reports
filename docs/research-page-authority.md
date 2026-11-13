# Incremental page authority

This is an additive protocol for reports with an explicit `verified_pages_v1`
page-scoped audit and a schema 1.2 ready/pending partition. It is not an upgrade
of historical incomplete reports or permission to repeat an existing send.

The original `morning-YYYYMMDD-r1` run, plan bytes, input hashes, owner/epoch,
operation ledger and cumulative budget remain authoritative. Original `run.permit`
is immutable. Every control command, archive and source/model reservation still
uses that original run ID. There is no second claim.

After a compatible release and independent review, offline administration uses
`research-page-admin.mjs CONFIG --install` while the Publisher is stopped. The
existing lock and transaction install `research_page_rounds` and
`research_page_staged`; no existing staging table or date uniqueness is rewritten.
CD fingerprints both tables and refuses an incompatible runtime before opening
its live state. This migration alone does not send anything.

## A continuation

1. Read the complete original status/operations. At the next eligible hourly
   window, submit `page_begin` with exact arguments
   `{previous_request_id, added}`. `added` is a nonempty canonical subset of the
   previous pending topics. The host reads the original permit, stored job,
   authenticated archive/audit/metadata and `scheduled_handoffs` full sent receipt.
   Unknown/partial sends, missing audit metadata hashes and legacy unpartitioned
   reports cannot create a round. No client-supplied `sent` assertion is accepted.
2. The host appends a deterministic rN round and previous evidence. Repeated
   identical begin observes that round; changing its page selection is rejected.
   It never overwrites the original permit, resets a budget, or replaces an
   unknown upload. Source identities remain unchanged. Model operation keys are
   the original plan stage plus `:morning-YYYYMMDD-rN`; only the current open
   round permits those keys. All successful/unknown work still consumes the
   original cumulative accounting.
3. Save the real new evidence with the original run's archive chain. The current
   audit must bind original metadata bytes and retain the prior records/attempts.
   Previous evidence has exact fields `request_id`, `bundle_sha256`,
   `audit_sha256`, `archive_sha256`, and `report_commit`.
4. Use `page_permit` with exact arguments `publication_request_id`,
   `archive_sha256`, `bundle_sha256`, `audit_sha256`. The host validates the full
   original bundle, current audit and previous authenticated bytes. New bundle
   base is the previous verified publication commit. Only previously pending
   pages may become ready. Old articles, entries and assets are immutable;
   report metadata and the common poster may extend to show newly ready pages.
5. Use the same native research client with `upload.request_id` still the r1 run
   and the new round's permit ID. `upload_status` returns that specific permit.
   Stage/submit messages name its rN publication target. Original native operation
   keys are per permit; an unknown step is reconciled, not retried under another
   file or permit. Stage and admission recheck the predecessor inside the final
   transaction. Per-round staging rows preserve original source/file/hash bytes.
6. Publisher/Pages/T4 continue the existing chain. The page-completion notification
   includes only `page_delivery.added`; previously sent URLs are not repeated.
   Another round cannot begin until the current one has complete real delivery
   evidence. At most six nonempty rounds can exist for the six fixed topics.

A tested authority module is not evidence that a deployed host supports this
protocol. Both audit production and host/client validation must be deployed and
verified together; do not bypass a rejected coverage contract to force a send.
