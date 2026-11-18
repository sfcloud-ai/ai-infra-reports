"""Read the existing Publisher ledger before advancing main for the six-topic cutover."""
from contextlib import closing
from pathlib import Path
import sqlite3
import sys


def check(database):
    tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "jobs" not in tables:
        raise ValueError("publisher_ledger_required")
    if database.execute("SELECT 1 FROM jobs WHERE phase!='receipt_sent' LIMIT 1").fetchone():
        raise ValueError("settle_original_publication_before_advancing_main")
    for table in ("research_control_runs", "research_page_rounds"):
        if table not in tables:
            continue
        table_with_date = ("research_control_runs p" if table == "research_control_runs"
                           else "research_page_rounds p JOIN research_control_runs r ON r.request_id=p.run_id")
        date = "p.report_date" if table == "research_control_runs" else "r.report_date"
        pending = database.execute(f"""
            SELECT 1 FROM {table_with_date} WHERE {date}>='2026-11-19' AND p.permit IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=p.request_id
                            AND j.hash=json_extract(p.permit,'$.bundle_sha256')
                            AND j.phase='receipt_sent'
                            AND json_extract(j.detail,'$.proof.publication_status')='verified')
            LIMIT 1""").fetchone()
        if pending:
            raise ValueError("settle_original_permit_before_advancing_main")


if __name__ == "__main__":
    with closing(sqlite3.connect(Path(sys.argv[1]).resolve(strict=True).as_uri()+"?mode=ro", uri=True)) as database:
        database.execute("PRAGMA query_only=ON")
        database.execute("BEGIN")
        check(database)
    print("edition_cutover_ready")
