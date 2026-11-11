"""公开来源、账本防重和排空回滚边界的无副作用回归。"""

import hashlib
import base64
import datetime
import errno
import os
from contextlib import contextmanager, closing
import io
import json
from pathlib import Path
import sqlite3
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from deployment import publisher_cd as cd


@contextmanager
def connection(path):
    """提交夹具事务并显式关闭连接，避免 Windows 留下文件锁。"""
    with closing(sqlite3.connect(path)) as database:
        with database:
            yield database


class RevisionSettlementTests(unittest.TestCase):
    def test_revision_capability_detects_original_bundle_and_submission(self):
        with closing(sqlite3.connect(':memory:')) as database:
            database.execute('CREATE TABLE jobs(bytes BLOB)')
            database.execute('INSERT INTO jobs VALUES (?)', (b'{"files":[]}',))
            self.assertFalse(cd.revision_runtime_required(database))
            raw=json.dumps({'files':[{'path':'reports/2026-11-01/report.json','base64':base64.b64encode(b'{"schema_version":"1.1"}').decode()}]}).encode()
            database.execute('UPDATE jobs SET bytes=?', (raw,))
            self.assertTrue(cd.revision_runtime_required(database))
            database.execute('DELETE FROM jobs')
            database.execute('CREATE TABLE slack_submission_events(kind TEXT)')
            database.execute("INSERT INTO slack_submission_events VALUES ('revision')")
            self.assertTrue(cd.revision_runtime_required(database))

    def test_skipped_and_superseded_require_bound_terminal_evidence(self):
        with closing(sqlite3.connect(':memory:')) as database:
            database.execute(cd.SCHEDULED_SCHEMA['scheduled_handoffs'])
            def insert(revision, phase, status, **extra):
                identity = {'request_id': f'morning-20261101-r{revision}', 'report_date': '2026-11-01', 'report_commit': 'a'*40, 'bundle_sha256': str(revision)*64}
                result = {**identity, 'phase': phase, 'status': status, **extra}
                database.execute('INSERT INTO scheduled_handoffs VALUES (?,?,?,?,0)', (identity['request_id'], json.dumps(identity), phase, json.dumps(result)))
            insert(2, 'skipped', 'skipped', delivery_kind='web_only', report_revision=2, parts_total=0, parts_sent=0, images=[])
            cd.require_settled_scheduled(database)
            insert(1, 'superseded', 'queued', superseded_by='morning-20261101-r3', parts_total=2, parts_sent=0)
            with self.assertRaises(cd.Deferred):
                cd.require_settled_scheduled(database)
            insert(3, 'complete', 'sent', delivery_kind='initial', report_revision=3, parts_total=2, parts_sent=2,
                   images=[{'file_id': 'scheduled-poster', 'status': 'sent', 'error': None}])
            cd.require_settled_scheduled(database)
            original = database.execute("SELECT result FROM scheduled_handoffs WHERE request_id='morning-20261101-r2'").fetchone()[0]
            for field, value in [('status', 'sent'), ('parts_total', 1), ('bundle_sha256', 'x'*64)]:
                changed = json.loads(original); changed[field] = value
                database.execute("UPDATE scheduled_handoffs SET result=? WHERE request_id='morning-20261101-r2'", (json.dumps(changed),))
                with self.assertRaises(cd.Deferred):
                    cd.require_settled_scheduled(database)
            database.execute("UPDATE scheduled_handoffs SET result=? WHERE request_id='morning-20261101-r2'", (original,))
            database.execute("UPDATE scheduled_handoffs SET phase='observed' WHERE request_id='morning-20261101-r3'")
            with self.assertRaises(cd.Deferred):
                cd.require_settled_scheduled(database)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.before, self.target = "a" * 40, "b" * 40
        self.run = {"id": 10, "run_attempt": 1, "head_sha": self.target, "head_branch": "main",
                    "event": "push", "path": ".github/workflows/validate.yml",
                    "repository": {"full_name": cd.REPOSITORY}, "status": "completed", "conclusion": "success"}
        self.comparison = {"status": "ahead", "base_commit": {"sha": self.before}, "merge_base_commit": {"sha": self.before}}

    def api(self, path):
        if path == "/git/ref/heads/main":
            return {"object": {"type": "commit", "sha": self.target}}
        if path.startswith("/compare/"):
            return self.comparison
        self.assertIn("head_sha=" + self.target, path)
        return {"workflow_runs": [self.run]}

    def test_only_exact_main_push_ci_authorizes_forward_update(self):
        self.assertEqual(cd.select_candidate(self.before, self.api), {"commit": self.target, "run_id": 10, "run_attempt": 1})
        for field, value in (("head_sha", self.before), ("head_branch", "topic"), ("event", "pull_request"),
                             ("path", ".github/workflows/unrelated.yml"), ("repository", {"full_name": "other/repo"}),
                             ("status", "in_progress"), ("conclusion", "skipped")):
            with self.subTest(field=field), patch.dict(self.run, {field: value}):
                with self.assertRaises(cd.Deferred):
                    cd.select_candidate(self.before, self.api)

    def test_diverged_or_backwards_main_is_not_deployed(self):
        for value in ("behind", "diverged", "identical"):
            with patch.dict(self.comparison, {"status": value}):
                with self.assertRaisesRegex(ValueError, "forward_only"):
                    cd.select_candidate(self.before, self.api)
        with patch.dict(self.comparison, {"merge_base_commit": {"sha": "c" * 40}}):
            with self.assertRaisesRegex(ValueError, "forward_only"):
                cd.select_candidate(self.before, self.api)

    def test_later_failed_rerun_cannot_reuse_older_success(self):
        good = dict(self.run)
        bad = {**self.run, "run_attempt": 2, "conclusion": "failure"}
        original = self.api
        def api(path):
            return {"workflow_runs": [good, bad]} if "/runs?" in path else original(path)
        with self.assertRaisesRegex(cd.Deferred, "not_successful"):
            cd.select_candidate(self.before, api)

    def archive(self, extra=None):
        data = io.BytesIO()
        prefix = "ai-infra-reports-" + self.target + "/"
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            for name in ("package.json", "package-lock.json", "scripts/publisher-service.mjs"):
                info = tarfile.TarInfo(prefix + name)
                info.size = 2
                archive.addfile(info, io.BytesIO(b"{}"))
            if extra is not None:
                archive.addfile(extra, io.BytesIO(b"x" * extra.size))
        return data.getvalue()

    def test_archive_rejects_links_traversal_duplicates_and_wrong_commit(self):
        self.assertEqual(len(cd.archive_files(self.archive(), self.target)), 3)
        prefix = "ai-infra-reports-" + self.target + "/"
        for name, kind in ((prefix + "../escape", tarfile.REGTYPE), ("/escape", tarfile.REGTYPE),
                           (prefix + "package.json", tarfile.REGTYPE), (prefix + "link", tarfile.SYMTYPE),
                           (prefix + "hard", tarfile.LNKTYPE), (prefix + "pipe", tarfile.FIFOTYPE),
                           (prefix + "node_modules/foreign", tarfile.REGTYPE)):
            with self.subTest(name=name):
                info = tarfile.TarInfo(name)
                info.type = kind
                info.linkname = "/outside"
                with self.assertRaises(ValueError):
                    cd.archive_files(self.archive(info), self.target)
        with self.assertRaises(ValueError):
            cd.archive_files(self.archive(), self.before)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.database = self.root / "handoff.sqlite"
        with connection(self.database) as database:
            database.executescript("CREATE TABLE scope(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO scope VALUES(1,'pinned');"
                "CREATE TABLE jobs(id TEXT PRIMARY KEY,phase TEXT,bytes BLOB);INSERT INTO jobs VALUES('report','receipt_sent','{}');"
                "CREATE TABLE notices(id TEXT PRIMARY KEY,phase TEXT);"
                "CREATE TABLE notice_commands(id TEXT PRIMARY KEY,phase TEXT);")

    def intake(self):
        with connection(self.database) as database:
            for sql in cd.INTAKE_SCHEMA.values():
                database.execute(sql)
            database.execute("INSERT INTO publisher_intake_scan VALUES(1,?,?,NULL,NULL)", ("a" * 64, "1793448000.000001"))

    def test_old_revision_reader_is_rejected_before_candidate_state_open(self):
        node=shutil.which('node')
        if node is None:
            self.skipTest('Node is required for candidate rejection check')
        raw=json.dumps({'files':[{'path':'reports/2026-11-01/report.json','base64':base64.b64encode(b'{"schema_version":"1.1"}').decode()}]}).encode()
        with connection(self.database) as database:
            database.execute('UPDATE jobs SET bytes=?', (raw,))
        scripts=self.root/'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export function validateConfig(){throw Error('config_opened')}")
        config_file=self.root/'publisher.json';config_file.write_text('{}')
        operation=self.root/'operation';operation.mkdir()
        config={'state':str(self.root),'publisher_config':str(config_file),'uid':996,'gid':996}
        before=cd.snapshot(self.database)
        def probe(config,release,arguments,**kwargs):
            result=subprocess.run([node,'--input-type=module','-e',arguments[-1]],cwd=release,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('revision_ledger_requires_compatible_release',result.stderr)
            self.assertNotIn('state_opened',result.stderr)
            self.assertNotIn('config_opened',result.stderr)
            raise ValueError('expected_old_reader_rejection')
        with patch.object(cd,'container',side_effect=probe),patch.object(cd,'legacy_dependency_mount',return_value=[]),patch.object(os,'chown',create=True):
            with self.assertRaisesRegex(ValueError,'expected_old_reader_rejection'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)

    def test_intake_empty_completed_scan_and_every_column_is_fingerprinted(self):
        self.intake()
        empty = cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute("INSERT INTO publisher_inbox VALUES('ts','report','F123','hash','admitted',3,42,100,'historic')")
        self.assertNotEqual(cd.snapshot(self.database), empty)
        for table, column, value in [("publisher_intake_scan", "scope", "b" * 64),
                ("publisher_intake_scan", "watermark", "1793448000.000002"),
                *[("publisher_inbox", column, value) for column, value in
                  [("source_ts", "ts2"), ("request_id", "report2"), ("file_id", "F124"), ("hash", "hash2"),
                   ("attempts", 4), ("next_at", 43), ("last_attempt", 101), ("diagnostic", "changed")]]]:
            before = cd.snapshot(self.database)
            with connection(self.database) as database:
                database.execute("UPDATE " + table + " SET " + column + "=?", (value,))
            self.assertNotEqual(cd.snapshot(self.database), before, column)

    def test_intake_pending_unknown_partial_and_late_read_commands_defer(self):
        self.intake()
        with connection(self.database) as database:
            database.execute("INSERT INTO publisher_inbox(source_ts,request_id,file_id,hash) VALUES('ts','report','F123','hash')")
        for phase in ('pending', 'unknown'):
            with connection(self.database) as database:
                database.execute('UPDATE publisher_inbox SET phase=?', (phase,))
            with self.assertRaises(cd.Deferred):
                cd.snapshot(self.database)
            cd.snapshot(self.database, settled=False)
        with connection(self.database) as database:
            database.execute("UPDATE publisher_inbox SET phase='admitted'")
        for sql in ["UPDATE publisher_intake_scan SET upper_bound='1793449000.000001'",
                    "UPDATE publisher_intake_scan SET upper_bound=NULL,page_cursor='cursor'"]:
            before = cd.snapshot(self.database, settled=False)
            with connection(self.database) as database:
                database.execute(sql)
            with self.assertRaisesRegex(cd.Deferred, 'unfinished_intake_scan'):
                cd.snapshot(self.database)
            self.assertNotEqual(cd.snapshot(self.database, settled=False), before)
        with connection(self.database) as database:
            database.execute('UPDATE publisher_intake_scan SET page_cursor=NULL')
            database.execute(cd.SCHEDULED_SCHEMA['scheduled_status_replies'])
            database.execute("INSERT INTO scheduled_status_replies VALUES('ts','hash','queued','query',NULL,0)")
        with self.assertRaises(cd.Deferred):
            cd.snapshot(self.database)
        before = cd.snapshot(self.database, settled=False)
        with connection(self.database) as database:
            database.execute("UPDATE scheduled_status_replies SET phase='sent',reply_ts='reply'")
        self.assertNotEqual(cd.snapshot(self.database), before)

    def test_intake_exact_schema_and_scope_required_even_for_unsettled_snapshot(self):
        for sql in ['DROP TABLE publisher_inbox', 'DROP TABLE publisher_intake_scan',
                    'DELETE FROM publisher_intake_scan', "UPDATE publisher_intake_scan SET scope='invalid'",
                    'DROP INDEX publisher_inbox_request',
                    'DROP INDEX publisher_inbox_request; CREATE INDEX publisher_inbox_request ON publisher_inbox(hash)',
                    'CREATE INDEX extra ON publisher_inbox(hash)',
                    'ALTER TABLE publisher_inbox ADD COLUMN extra TEXT',
                    'CREATE TRIGGER extra AFTER UPDATE ON publisher_intake_scan BEGIN DELETE FROM jobs; END']:
            with self.subTest(sql=sql):
                with connection(self.database) as database:
                    database.executescript('DROP TABLE IF EXISTS publisher_inbox; DROP TABLE IF EXISTS publisher_intake_scan;')
                self.intake()
                with connection(self.database) as database:
                    database.executescript(sql)
                for settled in (True, False):
                    with self.assertRaisesRegex(ValueError, 'intake|unsupported_ledger_object'):
                        cd.snapshot(self.database, settled=settled)

    def test_row_mutation_with_identical_counts_is_detected(self):
        before = cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute("UPDATE jobs SET bytes=X'0201'")
        self.assertNotEqual(cd.snapshot(self.database), before)

    def replacement_audit(self, database):
        # Match the one-time recovery CREATE exactly, including SQLite's removal
        # of IF NOT EXISTS in sqlite_master. The old unknown phase is history.
        database.execute(cd.JOB_REPLACEMENT_SCHEMA.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1))
        original = b"\x00\xfforiginal bundle bytes\n"
        database.execute("INSERT INTO job_replacement_audit VALUES(?,?,?,?,?,?,?,?,?,?)",
                         ("report", hashlib.sha256(original).hexdigest(), "1793749034.937879",
                          original, "proposal_unknown", "{}", "a" * 64, "b" * 40,
                          "2026-11-04T00:34:33.000Z", "authorized correction before publication"))
        return original

    def test_exact_replacement_audit_schema_preserves_complete_original_bytes(self):
        without = cd.snapshot(self.database)
        with connection(self.database) as database:
            original = self.replacement_audit(database)
            self.assertEqual(database.execute("SELECT sql FROM sqlite_master WHERE name='job_replacement_audit'").fetchone()[0],
                             cd.JOB_REPLACEMENT_SCHEMA)
        before = cd.snapshot(self.database)
        self.assertNotEqual(before, without)
        with connection(self.database) as database:
            self.assertEqual(database.execute("SELECT original_bytes FROM job_replacement_audit").fetchone()[0], original)
            database.execute("UPDATE job_replacement_audit SET original_bytes=?", (original.replace(b"\xff", b"\xfe"),))
        # Same row count, schema and byte length: every original byte still
        # participates in the snapshot rather than only the recorded hash.
        self.assertNotEqual(cd.snapshot(self.database), before)

    def test_replacement_audit_rejects_changed_schema_and_additional_constraints(self):
        variants = [cd.JOB_REPLACEMENT_SCHEMA.replace("original_bytes BLOB", "original_bytes TEXT"),
                    cd.JOB_REPLACEMENT_SCHEMA.replace("request_id TEXT NOT NULL", "request_id TEXT"),
                    cd.JOB_REPLACEMENT_SCHEMA.replace("PRIMARY KEY(request_id, original_hash)", "PRIMARY KEY(request_id)"),
                    cd.JOB_REPLACEMENT_SCHEMA.replace("reason TEXT NOT NULL", "reason TEXT NOT NULL, extra TEXT")]
        for sql in variants:
            with self.subTest(sql=sql):
                with connection(self.database) as database:
                    database.execute("DROP TABLE IF EXISTS job_replacement_audit")
                    database.execute(sql)
                with self.assertRaisesRegex(ValueError, "unsupported_job_replacement_schema"):
                    cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute("DROP TABLE job_replacement_audit")
            self.replacement_audit(database)
            database.execute("CREATE UNIQUE INDEX foreign_replacement_constraint ON job_replacement_audit(replacement_hash)")
        with self.assertRaisesRegex(ValueError, "unsupported_job_replacement_schema"):
            cd.snapshot(self.database)

    def test_compatibility_probe_retains_audit_and_detects_any_original_byte_change(self):
        with connection(self.database) as database:
            original = self.replacement_audit(database)
        config_file = self.root / "publisher.json"
        config_file.write_text('{}')
        operation = self.root / "operation"
        operation.mkdir()
        config = {"state": str(self.root), "publisher_config": str(config_file), "uid": 996, "gid": 996}
        before = cd.snapshot(self.database)
        def copied_database(kwargs):
            mount = kwargs["extra"][1]
            prefix, suffix = "type=bind,src=", ",dst=/probe"
            self.assertTrue(mount.startswith(prefix) and mount.endswith(suffix))
            return Path(mount[len(prefix):-len(suffix)]) / "handoff.sqlite"
        def probe(config, release, arguments, **kwargs):
            with connection(copied_database(kwargs)) as database:
                self.assertEqual(database.execute("SELECT original_bytes FROM job_replacement_audit").fetchone()[0], original)
                database.execute("INSERT OR IGNORE INTO scope VALUES(1,'pinned')")
        with patch.object(cd, "container", side_effect=probe), \
                patch.object(cd, "legacy_dependency_mount", return_value=[]), patch.object(os, "chown", create=True):
            cd.compatibility(config, self.root, operation, before)
        self.assertEqual(cd.snapshot(self.database), before)

        def mutating_probe(config, release, arguments, **kwargs):
            probe(config, release, arguments, **kwargs)
            with connection(copied_database(kwargs)) as database:
                database.execute("UPDATE job_replacement_audit SET original_bytes=?", (original + b"changed",))
        with patch.object(cd, "container", side_effect=mutating_probe), \
                patch.object(cd, "legacy_dependency_mount", return_value=[]), patch.object(os, "chown", create=True):
            with self.assertRaisesRegex(ValueError, "automatic_state_migration_not_supported"):
                cd.compatibility(config, self.root, operation, before)
        self.assertEqual(cd.snapshot(self.database), before)

    def test_scheduled_schema_is_snapshotted_and_unsettled_work_blocks_cutover(self):
        with connection(self.database) as database:
            for sql in cd.SCHEDULED_SCHEMA.values():
                database.execute(sql)
        empty = cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute("INSERT INTO scheduled_bridge_scope VALUES(1,'pinned')")
            database.execute("INSERT INTO scheduled_handoffs VALUES('report','binding','observed',NULL,1)")
        with self.assertRaises(cd.Deferred):
            cd.snapshot(self.database)
        pending = cd.snapshot(self.database, settled=False)
        self.assertNotEqual(empty, pending)
        with connection(self.database) as database:
            database.execute("UPDATE scheduled_handoffs SET phase='complete'")
            database.execute("INSERT INTO scheduled_status_replies VALUES('ts','hash','unknown','receipt',NULL,0)")
        with self.assertRaises(cd.Deferred):
            cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute("UPDATE scheduled_status_replies SET phase='sent'")
        self.assertNotEqual(cd.snapshot(self.database), pending)
        with connection(self.database) as database:
            database.execute('ALTER TABLE scheduled_handoffs ADD COLUMN unexpected TEXT')
        with self.assertRaisesRegex(ValueError, 'unsupported_scheduled_schema'):
            cd.snapshot(self.database)

    def test_remote_journal_schema_and_unresolved_operation_gate(self):
        with connection(self.database) as database:
            for sql in sorted(cd.REMOTE_JOURNAL_SCHEMA, key=lambda s: not s.startswith('CREATE TABLE')):
                database.execute(sql)
            database.execute("INSERT INTO remote_native_runs VALUES('report','{}','hash',1,'open',0,0,NULL)")
        with self.assertRaises(cd.Deferred):
            cd.snapshot(self.database)
        before = cd.snapshot(self.database, settled=False)
        with connection(self.database) as database:
            database.execute("UPDATE remote_native_runs SET phase='complete'")
        self.assertNotEqual(cd.snapshot(self.database), before)
        with connection(self.database) as database:
            database.execute('DROP TRIGGER remote_native_run_keep')
        with self.assertRaisesRegex(ValueError, 'unsupported_remote_journal_schema'):
            cd.snapshot(self.database)

    def test_wal_backup_has_no_admin_owned_sidecars_before_service_probe(self):
        with connection(self.database) as database:
            self.assertEqual(database.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        config_file = self.root / "publisher.json"
        config_file.write_text('{}')
        operation = self.root / "operation"
        operation.mkdir()
        config = {"state": str(self.root), "publisher_config": str(config_file), "uid": 996, "gid": 996}
        before = cd.snapshot(self.database)
        def probe(config, release, arguments, **kwargs):
            directory = next(operation.glob("probe-*"))
            copied = directory / "handoff.sqlite"
            self.assertFalse(Path(str(copied) + "-wal").exists())
            self.assertFalse(Path(str(copied) + "-shm").exists())
            with connection(copied) as database:
                self.assertEqual(database.execute("PRAGMA journal_mode").fetchone()[0], "delete")
                database.execute("INSERT OR IGNORE INTO scope VALUES(1,'pinned')")
        with patch.object(cd, "container", side_effect=probe) as container, \
                patch.object(cd, "legacy_dependency_mount", return_value=[]), patch.object(os, "chown", create=True):
            cd.compatibility(config, self.root, operation, before)
        container.assert_called_once()
        self.assertEqual(cd.snapshot(self.database), before)

    def test_any_unresolved_report_notice_or_reply_defers_upgrade(self):
        for table, phase in (("jobs", "pr_sending"), ("notices", "reserved"), ("notices", "send_unknown"),
                             ("notice_commands", "response_sending"), ("notice_commands", "response_unknown")):
            with self.subTest(table=table, phase=phase):
                with connection(self.database) as database:
                    if table == "jobs":
                        database.execute("UPDATE jobs SET phase=?", (phase,))
                    else:
                        database.execute("INSERT INTO " + table + " VALUES('pending',?)", (phase,))
                with self.assertRaises(cd.Deferred):
                    cd.snapshot(self.database)
                with connection(self.database) as database:
                    if table == "jobs":
                        database.execute("UPDATE jobs SET phase='receipt_sent'")
                    else:
                        database.execute("DELETE FROM " + table)

    def test_recovery_audit_is_preserved_and_only_exact_guards_are_accepted(self):
        with connection(self.database) as database:
            for sql in sorted(cd.RECOVERY_SCHEMA):
                database.execute(sql)
            database.execute("INSERT INTO notice_recovery_authorizations VALUES('recover','report','{}','hash','{}','{}','approved',NULL,NULL)")
        with self.assertRaises(cd.Deferred):
            cd.snapshot(self.database)
        before = cd.snapshot(self.database, settled=False)
        with connection(self.database) as database:
            database.execute("UPDATE notice_recovery_authorizations SET phase='consumed'")
        self.assertNotEqual(cd.snapshot(self.database), before)
        with connection(self.database) as database:
            database.execute("DROP TRIGGER notice_recovery_no_delete")
        with self.assertRaisesRegex(ValueError, "recovery_schema"):
            cd.snapshot(self.database)

    def test_successor_fence_preserves_audit_and_unresolved_gate(self):
        with connection(self.database) as database:
            for sql in sorted(cd.RECOVERY_SCHEMA):
                database.execute(sql)
            database.execute("ALTER TABLE notice_commands ADD COLUMN hash TEXT")
            database.execute("INSERT INTO notice_commands VALUES('successor-command','response_sent','hash')")
            database.execute("INSERT INTO notice_recovery_authorizations VALUES('recover','report','{}','hash','{}','{}','approved',NULL,NULL)")
            for sql in sorted(cd.RECOVERY_SUCCESSOR_SCHEMA):
                database.execute(sql)
            plan = json.dumps({'command_id': 'successor-command', 'command_sha256': 'hash', 'file_id': 'F123'})
            database.execute("INSERT INTO recovery_control_successors VALUES('report','successor',?,'hash','{}')", (plan,))
        with self.assertRaises(cd.Deferred):
            cd.snapshot(self.database)
        before = cd.snapshot(self.database, settled=False)
        with connection(self.database) as database:
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'permanently fenced'):
                database.execute("UPDATE notice_recovery_authorizations SET phase='consumed',grant_command_id='old-command',replacement_file_id='F123'")
            database.execute("UPDATE notice_recovery_authorizations SET phase='consumed',grant_command_id='successor-command',replacement_file_id='F123'")
        self.assertNotEqual(cd.snapshot(self.database), before)
        with connection(self.database) as database:
            database.execute('DROP TRIGGER recovery_successor_grant_guard')
        with self.assertRaisesRegex(ValueError, 'unsupported_recovery_successor_schema'):
            cd.snapshot(self.database)

    def test_unknown_schema_or_trigger_prevents_automatic_migration(self):
        with connection(self.database) as database:
            database.execute("CREATE TABLE future_schema(value)")
        with self.assertRaisesRegex(ValueError, "schema"):
            cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute("DROP TABLE future_schema")
            database.execute("CREATE TRIGGER future_change AFTER INSERT ON scope BEGIN UPDATE jobs SET phase='received'; END")
        with self.assertRaisesRegex(ValueError, "object"):
            cd.snapshot(self.database)

    def test_only_known_old_code_phases_can_resume_after_drain_race(self):
        for phase in ("received", "pr_open", "merged", "verified", "receipt_sent"):
            with connection(self.database) as database:
                database.execute("UPDATE jobs SET phase=?", (phase,))
            cd.resumable_original(self.database)
        for phase in ("proposing", "proposal_unknown", "sending", "receipt_unknown", "future_phase"):
            with connection(self.database) as database:
                database.execute("UPDATE jobs SET phase=?", (phase,))
            with self.assertRaisesRegex(cd.Deferred, "unknown_write"):
                cd.resumable_original(self.database)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        LedgerTests.setUp(self)
        self.operation = self.root / "operation"
        self.operation.mkdir()
        self.before, self.target = "a" * 40, "b" * 40
        self.unit = self.root / "publisher.service"
        self.config_path = self.root / "publisher.json"
        self.config_path.write_text("{}")
        self.old_unit, self.new_unit = b"original", b"candidate"
        self.unit.write_bytes(self.new_unit)
        (self.operation / "before.service").write_bytes(self.old_unit)
        self.config = {"control": str(self.root), "unit": str(self.unit), "publisher_config": str(self.config_path),
                       "base": str(self.root / "application"), "state": str(self.root)}
        self.record = {"phase": "start_intent", "before": self.before, "target": self.target,
                       "operation": str(self.operation), "config_sha256": cd.digest(self.config_path),
                       "before_unit_sha256": hashlib.sha256(self.old_unit).hexdigest(),
                       "target_unit_sha256": hashlib.sha256(self.new_unit).hexdigest()}
        (self.root / "pending.json").write_text(json.dumps(self.record))

    def test_previous_unknown_operation_is_never_reissued_by_timer(self):
        with patch.object(cd, "_tick") as tick, patch.object(cd, "recover_known_attempt") as recovery:
            with self.assertRaisesRegex(ValueError, "read_only_reconciliation"):
                cd.tick(self.config)
        tick.assert_not_called()
        recovery.assert_not_called()

    def test_unconfirmed_original_drain_never_restarts_or_signals_again(self):
        current = {"ActiveState": "active", "MainPID": "123", "WorkingDirectory": str(Path(self.config["base"]) / "releases" / self.before)}
        with patch.object(cd, "properties", return_value=current), patch.object(cd, "run") as command:
            with self.assertRaisesRegex(ValueError, "drain_outcome_unconfirmed"):
                cd.recover_known_attempt(self.config)
        command.assert_not_called()

    def test_unknown_write_blocks_rollback_even_when_process_has_exited(self):
        with connection(self.database) as database:
            database.execute("UPDATE jobs SET phase='pr_sending'")
        with patch.object(cd, "properties", return_value={"ActiveState": "failed", "MainPID": "0"}), \
                patch.object(cd, "run") as command, patch.object(cd, "compatibility") as compatibility:
            with self.assertRaises(cd.Deferred):
                cd.recover_known_attempt(self.config)
        command.assert_not_called()
        compatibility.assert_not_called()
        self.assertEqual(self.unit.read_bytes(), self.new_unit)

    def test_safe_rollback_restores_only_code_and_preserves_ledger(self):
        before = cd.snapshot(self.database)
        old_directory = str(Path(self.config["base"]) / "releases" / self.before)
        properties = [{"ActiveState": "failed", "MainPID": "0"},
                      {"ActiveState": "active", "MainPID": "456", "WorkingDirectory": old_directory}]
        def save(path, value):
            path.write_text(json.dumps(value))
        with patch.object(cd, "properties", side_effect=properties), patch.object(cd, "run") as command, \
                patch.object(cd, "compatibility") as compatibility, patch.object(cd, "health", return_value=True), \
                patch.object(cd, "save", side_effect=save), patch.object(cd, "atomic", side_effect=lambda p, d, **kw: p.write_bytes(d)):
            result = cd.recover_known_attempt(self.config)
        self.assertEqual(result["status"], "rolled_back")
        self.assertFalse(result["state_restored"])
        self.assertEqual(cd.snapshot(self.database), before)
        self.assertEqual(self.unit.read_bytes(), self.old_unit)
        compatibility.assert_called_once()
        self.assertFalse((self.root / "pending.json").exists())
        self.assertEqual(json.loads((self.root / "blocked.json").read_text())["commit"], self.target)
        self.assertEqual(command.call_args_list[-1].args[0], ["/bin/systemctl", "start", cd.SERVICE])

    def test_changed_config_or_foreign_unit_is_never_overwritten(self):
        self.unit.write_bytes(b"foreign")
        with patch.object(cd, "run") as command:
            with self.assertRaisesRegex(ValueError, "inputs_changed"):
                cd.recover_known_attempt(self.config)
        command.assert_not_called()

    def test_work_arriving_during_drain_resumes_unchanged_original(self):
        self.unit.write_bytes(self.old_unit)
        self.record["phase"] = "drain_intent"
        (self.root / "pending.json").write_text(json.dumps(self.record))
        with connection(self.database) as database:
            database.execute("UPDATE jobs SET phase='pr_open'")
        before = cd.snapshot(self.database, settled=False)
        old_directory = str(Path(self.config["base"]) / "releases" / self.before)
        statuses = [{"ActiveState": "inactive", "MainPID": "0"},
                    {"ActiveState": "active", "MainPID": "456", "WorkingDirectory": old_directory}]
        with patch.object(cd, "properties", side_effect=statuses), patch.object(cd, "run") as command, \
                patch.object(cd, "compatibility") as compatibility, patch.object(cd, "health", return_value=True) as health, \
                patch.object(cd, "save", side_effect=lambda p,v: p.write_text(json.dumps(v))):
            result = cd.recover_known_attempt(self.config)
        self.assertEqual(result["status"], "deferred")
        self.assertEqual(cd.snapshot(self.database, settled=False), before)
        self.assertEqual(self.unit.read_bytes(), self.old_unit)
        self.assertFalse((self.root / "pending.json").exists())
        self.assertFalse((self.root / "blocked.json").exists())
        compatibility.assert_not_called()
        command.assert_called_once_with(["/bin/systemctl", "start", cd.SERVICE])
        self.assertEqual(health.call_args.kwargs["pid"], "456")
        self.assertIsInstance(health.call_args.kwargs["after"], datetime.datetime)

    def test_old_process_health_does_not_confirm_restarted_process(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        health = {"healthy": True, "commit": self.before, "successful_checks": 99,
                  "checked_at": (now - datetime.timedelta(seconds=5)).isoformat(), "pid": 123}
        path = self.root / "health.json"
        path.write_text(json.dumps(health))
        self.assertFalse(cd.health(self.config, self.before, after=now, pid=456))
        health.update(checked_at=now.isoformat(), pid=456, successful_checks=1)
        path.write_text(json.dumps(health))
        self.assertFalse(cd.health(self.config, self.before, after=now, pid=456))
        health["successful_checks"] = 2
        path.write_text(json.dumps(health))
        self.assertTrue(cd.health(self.config, self.before, after=now, pid=456))
        self.assertFalse(cd.health(self.config, self.before, after=now, pid=789))


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.work = self.root / "work"
        self.work.mkdir()

    def test_failed_validation_keeps_bounded_private_diagnostics_before_cutover(self):
        for phase in ('dependencies', 'validation'):
            operation = self.root / phase
            operation.mkdir()
            failure = cd.CommandFailure(137, b'x' * (129 * 1024))
            sequence = [failure] if phase == 'dependencies' else ['installed', failure]
            files = {'package.json': (b'{}', False)}
            config = {'base': str(self.root), 'validation_uid': 65534}
            with patch.object(cd, 'require_same_filesystem'), patch.object(cd, 'fetch', return_value=b'archive'), \
                    patch.object(cd, 'archive_files', return_value=files), patch.object(os, 'chown', create=True), \
                    patch.object(cd, 'container', side_effect=sequence), \
                    patch.object(cd, 'atomic', side_effect=lambda p,d,**kw: p.write_bytes(d)), \
                    patch.object(cd.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 4 * 1024**3})()):
                with self.assertRaisesRegex(cd.CommandFailure, '^bounded_command_failed$'):
                    cd.stage(config, {'commit': 'a' * 40}, operation)
            log = (operation / 'stage-failed.log').read_bytes()
            record = json.loads((operation / 'stage-failed.json').read_text())
            self.assertEqual(len(log), 128 * 1024)
            self.assertEqual(record['phase'], phase)
            self.assertEqual(record['exit_code'], 137)
            self.assertEqual(record['log_sha256'], cd.digest(operation / 'stage-failed.log'))
            self.assertFalse(record['production_credentials_mounted'])
            self.assertFalse((operation / 'release').exists())
            self.assertFalse((operation / 'staged.json').exists())

    def test_dependency_root_link_is_rejected_before_traversal(self):
        with patch.object(Path, "is_symlink", return_value=True), patch.object(os, "walk") as walk:
            with self.assertRaisesRegex(ValueError, "unsafe_dependency_root"):
                cd.dependency_tree(self.work)
        walk.assert_not_called()

    def test_dependency_root_must_be_an_actual_directory(self):
        (self.work / "node_modules").write_text("not a directory")
        with self.assertRaisesRegex(ValueError, "unsafe_dependency_root"):
            cd.dependency_tree(self.work)

    def test_legacy_dependencies_mount_only_the_resolved_release_leaf_readonly(self):
        base = self.root / "application"
        link = base / "releases" / ("a" * 40) / "node_modules"
        target = base / "releases" / ("b" * 40) / "node_modules"
        self.assertEqual(cd.dependency_mount_paths(base, link, target),
                         ["--mount", "type=bind,src=" + str(target) + ",dst=" + str(link) + ",readonly"])
        for invalid in (Path("relative/node_modules"), self.root / "private", base / "releases",
                        base / "releases" / "main" / "node_modules", target / "nested"):
            with self.subTest(path=str(invalid)):
                with self.assertRaises(ValueError):cd.dependency_mount_paths(base, invalid, target)
                with self.assertRaises(ValueError):cd.dependency_mount_paths(base, link, invalid)

    def test_self_contained_candidate_dependencies_need_no_host_mount(self):
        (self.work / "node_modules").mkdir()
        with patch.object(cd, "admin_path") as admin:
            self.assertEqual(cd.legacy_dependency_mount({"base": str(self.root)}, self.work), [])
        admin.assert_not_called()

    def test_cross_filesystem_staging_is_rejected_before_fetch_or_mutation(self):
        with patch.object(Path, "stat", side_effect=[type("Info", (), {"st_dev": 1})(), type("Info", (), {"st_dev": 2})()]):
            with self.assertRaisesRegex(cd.Deferred, "cross_filesystem"):
                cd.require_same_filesystem(self.work, self.root / "releases")
        with patch.object(cd, "require_same_filesystem", side_effect=cd.Deferred("cross_filesystem")), \
                patch.object(cd, "fetch") as fetch, patch.object(cd, "container") as container:
            with self.assertRaisesRegex(cd.Deferred, "cross_filesystem"):
                cd.stage({"base": str(self.root)}, {"commit": "a" * 40}, self.work)
        fetch.assert_not_called()
        container.assert_not_called()
        self.assertEqual(list(self.work.iterdir()), [])

    def test_same_device_bind_mount_failure_is_detected_and_probe_cleaned(self):
        destination = self.root / "releases"
        destination.mkdir()
        self.assertEqual(self.work.stat().st_dev, destination.stat().st_dev)
        with patch.object(os, "rename", side_effect=OSError(errno.EXDEV, "different mount")):
            with self.assertRaisesRegex(cd.Deferred, "promotion_not_available"):
                cd.require_same_filesystem(self.work, destination)
        self.assertEqual(list(self.work.iterdir()), [])
        self.assertEqual(list(destination.iterdir()), [])
        cd.require_same_filesystem(self.work, destination)
        self.assertEqual(list(self.work.iterdir()), [])
        self.assertEqual(list(destination.iterdir()), [])

    def test_probe_return_failure_cleans_only_its_owned_empty_directory(self):
        destination = self.root / "releases"
        destination.mkdir()
        rename = os.rename
        calls = []
        def fail_return(source, target):
            calls.append((source, target))
            if len(calls) == 2:
                raise OSError(errno.EXDEV, "return failed")
            rename(source, target)
        with patch.object(os, "rename", side_effect=fail_return):
            with self.assertRaisesRegex(cd.Deferred, "promotion_not_available"):
                cd.require_same_filesystem(self.work, destination)
        self.assertEqual(list(self.work.iterdir()), [])
        self.assertEqual(list(destination.iterdir()), [])

    def test_work_arriving_during_staging_defers_without_stopping_original(self):
        before, target = "a" * 40, "b" * 40
        config = {"control": str(self.root), "state": str(self.root), "base": str(self.root / "base"),
                  "publisher_config": str(self.root / "config.json"), "unit": str(self.root / "unit")}
        (self.root / "active.json").write_text(json.dumps({"commit": before}))
        for name in ("config.json", "unit"):
            (self.root / name).write_text("unchanged")
        candidate = {"commit": target, "run_id": 1, "run_attempt": 1}
        proof = {"unit_sha256": cd.digest(self.root / "unit"), "config_sha256": cd.digest(self.root / "config.json")}
        with patch.object(cd, "health", return_value=True), \
                patch.object(cd, "snapshot", side_effect=["settled", cd.Deferred("new_work")]), \
                patch.object(cd, "select_candidate", return_value=candidate), patch.object(cd, "stage", return_value=proof), \
                patch.object(cd, "properties") as properties, patch.object(cd, "run") as command:
            with self.assertRaisesRegex(cd.Deferred, "new_work"):
                cd._tick(config)
        properties.assert_not_called()
        command.assert_not_called()
        self.assertFalse((self.root / "pending.json").exists())

    def test_failed_pre_activation_check_does_not_occupy_release_path(self):
        # 实际 stage 写入每轮私有目录；下一轮重做隔离检查，不复用不完整结果。
        before, target = "a" * 40, "b" * 40
        config = {"control": str(self.root), "state": str(self.root), "base": str(self.root / "base"),
                  "publisher_config": str(self.root / "config.json"), "unit": str(self.root / "unit"), "validation_uid": 65534}
        (self.root / "active.json").write_text(json.dumps({"commit": before}))
        for name in ("config.json", "unit"):
            (self.root / name).write_text("unchanged")
        candidate = {"commit": target, "run_id": 1, "run_attempt": 1}
        files = {"package.json": (b"{}", False), "package-lock.json": (b"{}", False),
                 "scripts/publisher-service.mjs": (b"export {};", False)}
        (Path(config["base"]) / "releases").mkdir(parents=True)
        def container(config, work, command, **kwargs):
            (work / "node_modules").mkdir(exist_ok=True)
            (work / "node_modules" / "dependency.js").write_text("export {};")
            return "passed"
        try:
            for _ in range(2):
                with patch.object(cd, "health", return_value=True), patch.object(cd, "snapshot", return_value="settled"), \
                        patch.object(cd, "select_candidate", side_effect=[candidate, cd.Deferred("transient_ci")]), \
                        patch.object(cd, "fetch", return_value=b"archive"), patch.object(cd, "archive_files", return_value=files), \
                        patch.object(cd, "container", side_effect=container), patch.object(os, "chown", create=True), \
                        patch.object(cd, "atomic", side_effect=lambda p,d,**kw: p.write_bytes(d)), \
                        patch.object(cd.shutil, "disk_usage", return_value=type("Disk", (), {"free": 4 * 1024**3})()):
                    with self.assertRaisesRegex(cd.Deferred, "transient_ci"):
                        cd._tick(config)
            self.assertEqual(len(list(self.root.glob(target + "-*/staged.json"))), 2)
            self.assertFalse((Path(config["base"]) / "releases" / target).exists())
            self.assertFalse((self.root / "pending.json").exists())
        finally:
            for path in self.root.rglob("*"):
                if not path.is_symlink():
                    path.chmod(0o700)


class UnitTests(unittest.TestCase):
    def test_release_update_preserves_account_hardening_and_state_paths(self):
        before = "[Service]\nUser=publisher\nWorkingDirectory=/old\nExecStart=/old/entry --live\nNoNewPrivileges=true\nReadWritePaths=/state\nRestart=no\n"
        after = cd.unit_for(before, Path("/new"), Path("/node"), Path("/private/config.json"))
        for line in ("User=publisher", "NoNewPrivileges=true", "ReadWritePaths=/state", "Restart=no"):
            self.assertIn(line + "\n", after)
        self.assertIn("scripts/publisher-service.mjs", after)
        for invalid in (before + "ExecStart=/second\n", before.replace("WorkingDirectory=/old\n", "")):
            with self.assertRaisesRegex(ValueError, "ambiguous"):
                cd.unit_for(invalid, Path("/new"), Path("/node"), Path("/config"))


if __name__ == "__main__":
    unittest.main()
