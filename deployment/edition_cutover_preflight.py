"""Read the existing Publisher ledger before advancing main for the six-topic cutover."""
from contextlib import closing
from datetime import date
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import re
if __package__:
    from . import publisher_cd
else:
    import publisher_cd


def native_archive_stored(database, tables, request_id, operation_id):
    if not {"research_control_commands", "research_archives"} <= tables:
        return False
    row = database.execute("""
        SELECT a.bytes,a.hash,json_extract(b.bytes,'$.args.total_bytes') FROM research_control_commands b
        JOIN research_control_commands c ON c.request_id=b.request_id AND json_extract(c.bytes,'$.args.recovery_id')=b.command_id
        JOIN research_archives a ON a.request_id=b.request_id AND a.hash=json_extract(b.bytes,'$.args.archive_sha256')
          AND a.file_id=json_extract(b.bytes,'$.args.file_id') AND a.source_ts=json_extract(c.result,'$.recovery.source_ts')
        WHERE b.request_id=? AND json_extract(b.bytes,'$.args.operation_id')=?
          AND json_extract(b.bytes,'$.action')='archive_recovery_begin' AND json_extract(c.bytes,'$.action')='archive_recovery_commit'
          AND json_extract(b.result,'$.status')='committed' AND json_extract(c.result,'$.status')='committed'
        """, (request_id, operation_id)).fetchone()
    return bool(row and len(row[0]) == row[2] and hashlib.sha256(row[0]).hexdigest() == row[1])


def check(database, pause_start=None, scheduler_from=None):
    tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "jobs" not in tables:
        raise ValueError("publisher_ledger_required")
    if "publisher_intake_scan" not in tables:
        raise ValueError("slack_intake_watermark_required")
    if not isinstance(pause_start, str) or not re.fullmatch(r"[0-9]{10}\.[0-9]{6}", pause_start):
        raise ValueError("publication_pause_start_required")
    scan = database.execute("SELECT watermark,upper_bound,page_cursor FROM publisher_intake_scan WHERE id=1").fetchone()
    if not scan or not re.fullmatch(r"[0-9]{10}\.[0-9]{6}", scan[0] or "") or scan[0] < pause_start or any(v is not None for v in scan[1:]):
        raise ValueError("drain_slack_intake_through_publication_pause")
    if database.execute("SELECT 1 FROM jobs WHERE phase!='receipt_sent' LIMIT 1").fetchone():
        raise ValueError("settle_original_publication_before_advancing_main")
    if scheduler_from is not None:
        if date.fromisoformat(scheduler_from).isoformat() != scheduler_from:
            raise ValueError("invalid_scheduler_activation_date")
        for request_id, edition in database.execute("SELECT id,json_extract(detail,'$.proof.edition') FROM jobs"):
            if not isinstance(edition, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}/r[1-9]\d*", edition):
                raise ValueError("original_published_edition_required")
            if edition[:10] >= scheduler_from and ("scheduled_handoffs" not in tables or not database.execute(
                    "SELECT 1 FROM scheduled_handoffs WHERE request_id=?", (request_id,)).fetchone()):
                raise ValueError("settle_original_scheduler_admission_before_advancing_main")
    for table, terminal in (("slack_submission_events", "'done','fenced'"),
                            ("publisher_inbox", "'admitted','fenced'"),
                            ("slack_staged_bundles", "'admitted'"),
                            ("research_page_staged", "'admitted'")):
        if table in tables and database.execute(
                f"SELECT 1 FROM {table} WHERE phase NOT IN ({terminal}) LIMIT 1").fetchone():
            raise ValueError("settle_original_intake_before_advancing_main")
    if "research_control_report_parts" in tables and database.execute(
            "SELECT 1 FROM research_control_report_parts LIMIT 1").fetchone():
        raise ValueError("settle_original_intake_before_advancing_main")
    if "research_control_events" in tables and database.execute("""
            SELECT 1 FROM research_control_events WHERE phase='pending'
            AND json_extract(CAST(bytes AS TEXT),'$.action') IN ('permit','page_permit') LIMIT 1
            """).fetchone():
        raise ValueError("settle_original_permit_command_before_advancing_main")
    if {"research_control_ops", "research_page_rounds", "research_control_runs"} <= tables:
        outstanding = database.execute("""
            SELECT DISTINCT r.request_id,o.operation_id,o.kind FROM research_page_rounds p JOIN research_control_runs r ON r.request_id=p.run_id
            JOIN research_control_ops o ON o.request_id=r.request_id
            WHERE r.report_date>='2026-11-19' AND r.permit IS NOT NULL AND p.permit IS NULL
            AND o.phase!='acknowledged'""")
        for request_id, operation_id, kind in outstanding:
            if kind != "native" or not native_archive_stored(database, tables, request_id, operation_id):
                raise ValueError("settle_original_page_dispatch_before_advancing_main")
    replacement_edges = ""
    if "job_replacement_audit" in tables:
        schema = database.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_replacement_audit'").fetchone()[0]
        if schema != publisher_cd.JOB_REPLACEMENT_SCHEMA:
            raise ValueError("invalid_job_replacement_audit_schema")
        replacement_edges = """UNION
            SELECT r.request_id,r.replacement_hash FROM job_replacement_audit r
            JOIN permitted prior ON prior.id=r.request_id AND prior.hash=r.original_hash"""
    for table in ("research_control_runs", "research_page_rounds"):
        if table not in tables:
            continue
        pending = database.execute(f"""
            WITH RECURSIVE permitted(id,hash) AS (
                SELECT request_id,json_extract(permit,'$.bundle_sha256') FROM {table} WHERE permit IS NOT NULL
                {replacement_edges})
            SELECT 1 FROM {table} p WHERE p.permit IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM jobs j JOIN permitted proof ON j.id=proof.id AND j.hash=proof.hash
                            WHERE j.id=p.request_id
                            AND j.phase='receipt_sent'
                            AND json_extract(j.detail,'$.proof.bundle_sha256')=j.hash
                            AND json_extract(j.detail,'$.proof.commit')=json_extract(j.detail,'$.commit')
                            AND json_extract(j.detail,'$.proof.publication_status')='verified')
            LIMIT 1""").fetchone()
        if pending:
            raise ValueError("settle_original_permit_before_advancing_main")
    publisher_cd.require_settled_operations(database, tables, publisher_cd.producer_fence_snapshot(database))


if __name__ == "__main__":
    ledger = Path(sys.argv[1]).resolve(strict=True)
    config = json.loads((Path(sys.argv[3]) if len(sys.argv) == 4 else ledger.parent.parent / "config/publisher.json").read_bytes())
    if Path(config["state_dir"]).resolve() != ledger.parent:
        raise ValueError("publisher_config_state_directory_differs")
    with closing(sqlite3.connect(ledger.as_uri()+"?mode=ro", uri=True)) as database:
        database.execute("PRAGMA query_only=ON")
        database.execute("BEGIN")
        check(database, sys.argv[2], config["scheduled_delivery"]["activation_date"])
    print("edition_cutover_ready")
