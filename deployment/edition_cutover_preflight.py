"""Read the existing Publisher ledger before advancing main for the six-topic cutover."""
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import re
if __package__:
    from . import publisher_cd
else:
    import publisher_cd


def check(database, pause_start=None):
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
    with closing(sqlite3.connect(Path(sys.argv[1]).resolve(strict=True).as_uri()+"?mode=ro", uri=True)) as database:
        database.execute("PRAGMA query_only=ON")
        database.execute("BEGIN")
        check(database, sys.argv[2] if len(sys.argv) == 3 else None)
    print("edition_cutover_ready")
