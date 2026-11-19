"""公开来源、账本防重和排空回滚边界的无副作用回归。"""

import hashlib
import base64
import datetime
import errno
import os
from contextlib import contextmanager, closing, redirect_stdout
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
from deployment import edition_cutover_preflight


@contextmanager
def connection(path):
    """提交夹具事务并显式关闭连接，避免 Windows 留下文件锁。"""
    with closing(sqlite3.connect(path)) as database:
        with database:
            yield database


class ReportPartActivationTests(unittest.TestCase):
    def test_cutover_uses_config_selected_by_active_cd(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            active, stale = root / "active.json", root / "stale.json"
            stale.write_text(json.dumps({"state_dir": str(root), "scheduled_delivery": {"activation_date": "2026-11-21"}}))
            config = {"state_dir": str(root)}
            with patch.object(cd, "load_config", return_value={"publisher_config": str(active)}):
                active.write_text(json.dumps(config))
                self.assertIsNone(edition_cutover_preflight.scheduler_activation(root / "handoff.sqlite"))
                config["scheduled_delivery"] = {"activation_date": "2026-11-18"}
                active.write_text(json.dumps(config))
                self.assertEqual(edition_cutover_preflight.scheduler_activation(root / "handoff.sqlite"), "2026-11-18")
                with self.assertRaisesRegex(ValueError, "configuration_is_not_active"):
                    edition_cutover_preflight.scheduler_activation(root / "handoff.sqlite", stale)

    def test_cutover_before_main_advances_requires_exact_original_receipt(self):
        with closing(sqlite3.connect(':memory:')) as db:
            db.execute('CREATE TABLE jobs(id TEXT,hash TEXT,phase TEXT,detail TEXT)')
            db.execute('CREATE TABLE research_control_runs(request_id TEXT,report_date TEXT,permit TEXT)')
            db.execute('CREATE TABLE research_page_rounds(request_id TEXT,run_id TEXT,permit TEXT)')
            pause = '1795000100.000000'
            def check():
                edition_cutover_preflight.check(db, pause)
            with self.assertRaisesRegex(ValueError,'slack_intake_watermark_required'):
                check()
            db.execute('CREATE TABLE publisher_intake_scan(id INTEGER,watermark TEXT,upper_bound TEXT,page_cursor TEXT)')
            with self.assertRaisesRegex(ValueError,'drain_slack_intake'):
                check()
            db.execute("INSERT INTO publisher_intake_scan VALUES(1,?,NULL,NULL)", (pause,))
            check()
            db.execute('INSERT INTO research_control_runs VALUES (?,?,?)', ('original','2026-11-18',json.dumps({'bundle_sha256':'a'*64})))
            with self.assertRaisesRegex(ValueError,'settle_original_permit'):
                check()
            def detail(digest):
                return json.dumps({'commit':'c'*40,'proof':{'publication_status':'verified','commit':'c'*40,'bundle_sha256':digest}})
            db.execute('INSERT INTO jobs VALUES (?,?,?,?)', ('original','b'*64,'receipt_sent',detail('b'*64)))
            with self.assertRaisesRegex(ValueError,'settle_original_permit'):
                check()
            db.execute(cd.JOB_REPLACEMENT_SCHEMA)
            db.execute("INSERT INTO job_replacement_audit VALUES(?,?,?,?,?,?,?,?,?,?)",
                       ('original','a'*64,'1795000000.000000',b'original','received','{}','b'*64,'c'*40,'2026-11-18','authorized correction'))
            check()
            db.execute("UPDATE jobs SET detail=?", (detail('d'*64),))
            with self.assertRaisesRegex(ValueError,'settle_original_permit'):
                check()
            db.execute("UPDATE jobs SET hash=?,detail=?", ('a'*64,detail('a'*64)))
            check()
            db.execute("UPDATE research_control_runs SET report_date='2026-11-19'")
            db.execute("INSERT INTO research_page_rounds VALUES ('revision','original',NULL)")
            db.execute("CREATE TABLE research_control_ops(request_id TEXT,operation_id TEXT,kind TEXT,phase TEXT)")
            db.execute("INSERT INTO research_control_ops VALUES ('original','op','model','intent')")
            with self.assertRaisesRegex(ValueError,'settle_original_page_dispatch'):
                check()
            db.execute("UPDATE research_control_ops SET phase='unknown'")
            with self.assertRaisesRegex(ValueError,'settle_original_page_dispatch'):
                check()
            db.execute("UPDATE research_control_ops SET kind='native'")
            with self.assertRaisesRegex(ValueError,'settle_original_page_dispatch'):
                check()
            db.execute("CREATE TABLE research_control_commands(request_id TEXT,command_id TEXT,bytes BLOB,result TEXT)")
            db.execute("CREATE TABLE research_archives(request_id TEXT,hash TEXT,file_id TEXT,source_ts TEXT,bytes BLOB)")
            archive = b"original"
            digest = hashlib.sha256(archive).hexdigest()
            for key, action, args, result in [
                ("begin", "archive_recovery_begin", dict(operation_id="op", archive_sha256=digest, file_id="F1", total_bytes=len(archive)), {}),
                ("commit", "archive_recovery_commit", dict(recovery_id="begin"), {"recovery": {"source_ts": pause}}),
            ]:
                db.execute("INSERT INTO research_control_commands VALUES('original',?,?,?)",
                           (key, json.dumps(dict(action=action,args=args)), json.dumps(dict(status="committed",**result))))
            db.execute("INSERT INTO research_archives VALUES('original',?,'F1',?,?)", (digest,pause,archive))
            check()
            db.execute("UPDATE research_archives SET bytes=?", (b"modified",))
            with self.assertRaisesRegex(ValueError,'settle_original_page_dispatch'):
                check()
            db.execute("UPDATE research_control_ops SET phase='acknowledged'")
            check()
            db.execute('CREATE TABLE research_control_events(phase TEXT,bytes BLOB)')
            db.execute('INSERT INTO research_control_events VALUES (?,?)', ('pending',b'{"action":"page_permit"}'))
            with self.assertRaisesRegex(ValueError,'settle_original_permit_command'):
                check()
            db.execute("UPDATE research_control_events SET phase='sent'")
            db.execute('CREATE TABLE slack_submission_events(phase TEXT)')
            db.execute("INSERT INTO slack_submission_events VALUES ('pending')")
            with self.assertRaisesRegex(ValueError,'settle_original_intake'):
                check()
            db.execute("UPDATE slack_submission_events SET phase='done'")
            db.execute("UPDATE publisher_intake_scan SET watermark='1795000000.000000',upper_bound='1795000300.000000',page_cursor='more'")
            with self.assertRaisesRegex(ValueError,'drain_slack_intake'):
                edition_cutover_preflight.check(db,'1795000100.000000')
            db.execute("UPDATE publisher_intake_scan SET upper_bound=NULL,page_cursor=NULL")
            with self.assertRaisesRegex(ValueError,'drain_slack_intake'):
                edition_cutover_preflight.check(db,'1795000100.000000')
            db.execute("UPDATE publisher_intake_scan SET watermark='1795000300.000000'")
            edition_cutover_preflight.check(db,'1795000100.000000')
            db.execute('CREATE TABLE scheduled_handoffs(request_id TEXT,binding TEXT,phase TEXT,result TEXT)')
            db.execute("UPDATE jobs SET detail=json_set(detail,'$.proof.edition','2026-11-18/r1')")
            edition_cutover_preflight.check(db,pause,"2026-11-19")
            with self.assertRaisesRegex(ValueError,'settle_original_scheduler_admission'):
                edition_cutover_preflight.check(db,pause,"2026-11-18")
            db.execute("INSERT INTO scheduled_handoffs VALUES ('original','{}','complete',NULL)")
            edition_cutover_preflight.check(db,pause,"2026-11-18")
            db.execute("DELETE FROM scheduled_handoffs")
            db.execute("INSERT INTO scheduled_handoffs VALUES ('original','{}','admission_pending',NULL)")
            with self.assertRaises(cd.Deferred):
                edition_cutover_preflight.check(db,'1795000100.000000')

    @unittest.skipUnless(os.name == 'posix', 'Linux deployment lock')
    def test_competing_deployment_and_activation_defer_without_mutating(self):
        import fcntl
        cases = [(['tick'], 'deployment.lock'), (['enable-report-parts', 'a'*40], 'control-entry.lock')]
        with tempfile.TemporaryDirectory() as directory:
            for args, name in cases:
                with self.subTest(args=args), (Path(directory) / name).open('wb') as owner:
                    fcntl.flock(owner, fcntl.LOCK_EX)
                    output = io.StringIO()
                    with patch.object(cd.sys, 'argv', ['publisher_cd.py', *args]), patch.object(cd.os, 'getuid', return_value=0), patch.object(cd, 'load_config', return_value={'control': directory}), patch.object(cd, 'tick') as tick, patch.object(cd, 'enable_report_parts') as activate, redirect_stdout(output):
                        cd.main()
                    tick.assert_not_called()
                    activate.assert_not_called()
                    self.assertEqual(json.loads(output.getvalue()), dict(status='deferred', reason='deployment_lock_busy'))

    def test_only_the_confirmed_healthy_release_can_install_the_store(self):
        commit = 'a' * 40
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release = root / 'releases' / commit
            (release / 'deployment').mkdir(parents=True)
            shutil.copyfile(cd.__file__, release / 'deployment/publisher_cd.py')
            control = root / 'control'
            control.mkdir()
            config = dict(base=str(root), control=str(control), node='/node', publisher_config='/publisher.json', uid=1001, gid=1002)
            active = control / 'active.json'
            active.write_text(json.dumps({'commit': 'b' * 40}))
            service = dict(ActiveState='active', SubState='running', WorkingDirectory=str(release), MainPID='15')
            result = subprocess.CompletedProcess([], 0, b'{"installed":true}', b'')
            with patch.object(cd, 'properties', return_value=service), patch.object(cd, 'health', return_value=False) as healthy, patch.object(cd.subprocess, 'run', return_value=result) as start:
                with self.assertRaisesRegex(ValueError, 'active_release'):
                    cd.enable_report_parts(config, commit)
                active.write_text(json.dumps({'commit': commit}))
                for name in ('pending.json', 'control-pending.json'):
                    (control / name).touch()
                    with self.assertRaisesRegex(ValueError, 'active_release'):
                        cd.enable_report_parts(config, commit)
                    (control / name).unlink()
                for name in ('blocked.json', 'control-blocked.json'):
                    (control / name).write_text(json.dumps({'commit': commit}))
                    with self.assertRaisesRegex(ValueError, 'active_release'):
                        cd.enable_report_parts(config, commit)
                    (control / name).write_text(json.dumps({'commit': 'b' * 40}))
                pointer = control / 'control-release.json'
                pointer.write_text(json.dumps({'commit': 'b' * 40, 'files': {}}))
                with self.assertRaisesRegex(ValueError, 'controller_release'):
                    cd.enable_report_parts(config, commit)
                pointer.write_text(json.dumps({'commit': commit, 'files': {'publisher_cd.py': cd.digest(Path(cd.__file__))}}))
                with self.assertRaisesRegex(cd.Deferred, 'healthy_release'):
                    cd.enable_report_parts(config, commit)
                start.assert_not_called()
                healthy.return_value = True
                self.assertEqual(cd.enable_report_parts(config, commit), dict(status='report_parts_enabled', commit=commit, installed=True))
                self.assertEqual(start.call_args.kwargs['cwd'], release)
                self.assertEqual(start.call_args.args[0][:5], ['/usr/bin/setpriv', '--reuid=1001', '--regid=1002', '--clear-groups', '--no-new-privs'])
                result.stdout = b'{"lock_busy":true}'
                with self.assertRaisesRegex(cd.Deferred, 'publisher_ledger_lock_busy'):
                    cd.enable_report_parts(config, commit)
                start.side_effect = subprocess.CalledProcessError(1, 'node')
                with self.assertRaises(subprocess.CalledProcessError):
                    cd.enable_report_parts(config, commit)


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

    def test_full_ready_page_schema_requires_compatible_rollback_without_tables(self):
        with closing(sqlite3.connect(':memory:')) as database:
            database.execute('CREATE TABLE jobs(bytes BLOB)')
            self.assertFalse(cd.page_runtime_required(database))
            report = dict(schema_version='1.2', revision=1, page_delivery=dict(previous=None, added=[], pending=[]))
            raw = json.dumps(dict(files=[dict(path='reports/2026-11-13/report.json', base64=base64.b64encode(json.dumps(report).encode()).decode())])).encode()
            database.execute('INSERT INTO jobs VALUES (?)', (raw,))
            self.assertTrue(cd.page_runtime_required(database))
            self.assertTrue(cd.revision_runtime_required(database))
            self.assertIsNone(database.execute("SELECT 1 FROM sqlite_master WHERE name='research_page_rounds'").fetchone())

    def test_skipped_and_superseded_require_bound_terminal_evidence(self):
        with closing(sqlite3.connect(':memory:')) as database:
            database.execute(cd.SCHEDULED_SCHEMA['scheduled_handoffs'])
            def insert(revision, phase, status, **extra):
                identity = {'request_id': f'morning-20261101-r{revision}', 'report_date': '2026-11-01', 'report_commit': 'a'*40, 'bundle_sha256': str(revision)*64}
                result = {**identity, 'phase': phase, 'status': status, **extra}
                database.execute('INSERT INTO scheduled_handoffs VALUES (?,?,?,?,0)', (identity['request_id'], json.dumps(identity), phase, json.dumps(result)))
            for revision, phase in ((4, 'policy_rejected'), (5, 'awaiting_first_delivery')):
                insert(revision, phase, 'rejected', error='first_notice_requires_all_six_articles')
            self.assertTrue(cd.first_notice_rejection_runtime_required(database))
            cd.require_settled_scheduled(database)
            database.execute("UPDATE scheduled_handoffs SET result=json_set(result,'$.error','unverified') WHERE phase='policy_rejected'")
            with self.assertRaises(cd.Deferred):
                cd.require_settled_scheduled(database)
            database.execute("DELETE FROM scheduled_handoffs")
            self.assertFalse(cd.first_notice_rejection_runtime_required(database))
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





class ResearchRecoveryCdTests(unittest.TestCase):
    """新恢复层的只读快照和旧运行端拒绝边界，均为隔离夹具。"""
    setUp = LedgerTests.setUp

    def install(self):
        generation = '11111111-1111-4111-8111-111111111111'
        activation = '1794461160.996000'
        scope = 'a' * 64
        with connection(self.database) as database:
            database.execute('UPDATE scope SET value=?', (scope,))
            for schema in (cd.PRODUCER_FENCE_SCHEMA, cd.SUBMISSION_SCHEMA,
                           cd.RESEARCH_ARCHIVE_SCHEMA, cd.RESEARCH_CONTROL_SCHEMA,
                           cd.RESEARCH_RECOVERY_SCHEMA):
                for sql in schema.values():
                    database.execute(sql)
            database.execute('INSERT INTO producer_admission_fence VALUES(1,?,?,?,?,?)',
                             (generation, activation, scope, json.dumps(dict(journal_device='1', journal_inode='2', lock_device='3', lock_inode='4')), 'synthetic approval'))
            common = dict(generation=generation, activation_ts=activation, first_report_date='2026-11-13', publisher_scope_sha256=scope)
            for table, value in [('slack_submission_policy', dict(common, fence_generation=generation)),
                                 ('research_archive_policy', dict(common, submission_generation=generation)),
                                 ('research_control_policy', dict(common, archive_generation=generation, protocol='repository_inputs_v1'))]:
                database.execute('INSERT INTO '+table+' VALUES(1,?,?)', (json.dumps(value), 'synthetic installation'))
            database.execute("INSERT INTO research_recovery_installation VALUES(1,'synthetic explicit install',1794461160996)")
            database.execute('INSERT INTO research_recovery_authorizations VALUES(?,?,?,?)', ('b'*64, 'synthetic approval', b'original approval bytes', 1))
            database.execute('INSERT INTO research_recovery_grants VALUES(?,?,?,?,?,?,?,?)', ('grant','request',generation,'c'*64,None,'d'*64,b'original grant bytes',2))
            database.execute('INSERT INTO research_recovery_operations VALUES(?,?,?,?,?)', ('op','request','grant',1200000,3))

    def config(self):
        path = self.root / 'publisher.json'; path.write_text('{}')
        operation = self.root / 'operation'; operation.mkdir(exist_ok=True)
        return {'state':str(self.root),'publisher_config':str(path),'uid':996,'gid':996}, operation

    def test_page_schema_is_additive_snapshotted_and_rejects_partial_install(self):
        self.install()
        before = cd.snapshot(self.database)
        with connection(self.database) as database:
            for sql in cd.RESEARCH_PAGE_SCHEMA.values():
                database.execute(sql)
            database.execute('INSERT INTO research_page_rounds VALUES(?,?,?,?,?,?,?)',
                             ('morning-20261113-r2', 'morning-20261113-r1', 2, '{}', '["hardware-status"]', 1, None))
        after = cd.snapshot(self.database)
        self.assertNotEqual(before, after)
        self.assertEqual(after, cd.snapshot(self.database))
        with connection(self.database) as database:
            database.execute('DROP TABLE research_page_staged')
        with self.assertRaisesRegex(ValueError, 'unsupported_research_page_schema'):
            cd.snapshot(self.database)

    def test_complete_recovery_schema_rows_and_indexes_are_fingerprinted(self):
        self.install()
        before = cd.snapshot(self.database)
        self.assertEqual(cd.snapshot(self.database), before)
        with connection(self.database) as database:
            database.execute("UPDATE research_recovery_grants SET bytes=?", (b'altered',))
        self.assertNotEqual(cd.snapshot(self.database), before)
        with connection(self.database) as database:
            database.execute('CREATE INDEX unauthorized ON research_recovery_operations(request_id)')
        with self.assertRaisesRegex(ValueError, 'unsupported_research_recovery_schema'):
            cd.snapshot(self.database)

    def test_partial_or_changed_recovery_schema_rejected(self):
        self.install()
        with connection(self.database) as database:
            database.execute('ALTER TABLE research_recovery_operations ADD COLUMN extra TEXT')
        with self.assertRaisesRegex(ValueError, 'unsupported_research_recovery_schema'):
            cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute('DROP TABLE research_recovery_operations')
        with self.assertRaisesRegex(ValueError, 'unsupported_research_recovery_schema'):
            cd.snapshot(self.database)

    def continuation(self):
        with connection(self.database) as database:
            database.execute("INSERT INTO research_control_ops VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                             ('continuation', 'request', 'model', 'editor', 'e'*64,
                              json.dumps({'continuation_archive_sha256': 'f'*64}), 'owner', 1,
                              800, 'intent', None, None, None, None))

    def test_continuation_runtime_requirement_uses_existing_immutable_input(self):
        with connection(self.database) as database:
            self.assertFalse(cd.model_continuation_runtime_required(database))
        self.install()
        with connection(self.database) as database:
            self.assertFalse(cd.model_continuation_runtime_required(database))
        self.continuation()
        before = cd.snapshot(self.database)
        with connection(self.database) as database:
            self.assertTrue(cd.model_continuation_runtime_required(database))
        self.assertEqual(cd.snapshot(self.database), before)

    def test_continuation_blocks_old_runtime_before_config_and_state_open(self):
        if shutil.which('node') is None:
            self.skipTest('Node is not available')
        self.install(); self.continuation()
        scripts = self.root / 'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export function validateConfig(){throw Error('config_opened')}")
        (scripts/'research-control.mjs').write_text('export const REPOSITORY_RESEARCH_INPUTS_VERSION=1;export const LAYERED_RESEARCH_BUDGET_VERSION=1;')
        config, operation = self.config(); before = cd.snapshot(self.database)
        def probe(config, release, arguments, **kwargs):
            result = subprocess.run(['node','--input-type=module','-e',arguments[-1]], cwd=release, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('model_continuation_requires_compatible_release', result.stderr)
            self.assertNotIn('config_opened', result.stderr)
            self.assertNotIn('state_opened', result.stderr)
            raise ValueError('candidate_incompatible')
        with patch.object(cd,'container',side_effect=probe), patch.object(cd,'legacy_dependency_mount',return_value=[]), patch.object(os,'chown',create=True):
            with self.assertRaisesRegex(ValueError,'candidate_incompatible'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)

    def cancelled_permit(self, grant=True, page=False, marked=True):
        metadata = {'sources': [{'attempt_records': [{'status': 'not_dispatched'}]}]}
        encoded = lambda x: json.dumps(x).encode()
        mh = hashlib.sha256(encoded(metadata)).hexdigest()
        audit = {'evidence_metadata_sha256': mh}
        ah = hashlib.sha256(encoded(audit)).hexdigest()
        files = [{'path': p, 'sha256': hashlib.sha256(encoded(v)).hexdigest(),
                  'content_base64': base64.b64encode(encoded(v)).decode()}
                 for p, v in [('audit.json', audit), ('metadata.json', metadata)]]
        archive = encoded({'files': files}); h = hashlib.sha256(archive).hexdigest()
        permit = json.dumps({'archive_sha256': h, 'audit_sha256': ah}) if grant else None
        with connection(self.database) as db:
            if grant and marked:
                command = encoded({'action': 'page_permit' if page else 'permit'})
                result = json.dumps({'status': 'committed', 'cancellation_page_version': 1})
                db.execute('INSERT INTO research_control_commands VALUES(?,?,?,?,?)', ('permit-command','request',hashlib.sha256(command).hexdigest(),command,result))
            db.execute('INSERT INTO research_archives VALUES(?,?,?,?,?,?,?,?,?)',
                       ('archive','2026-11-13','request',h,None,'[]',archive,'1794461161.000001','FARCHIVE'))
            if page:
                for sql in cd.RESEARCH_PAGE_SCHEMA.values(): db.execute(sql)
                db.execute('INSERT INTO research_page_rounds VALUES(?,?,?,?,?,?,?)', ('r2','request',2,'{}','[]',1,permit))
            else:
                db.execute('INSERT INTO research_control_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           ('request','2026-11-13',b'{}','a'*64,'owner',1,1,1,1,0,None,None,permit))

    def test_new_layered_cancel_settlement_fences_quota_downgrade_only_after_commit(self):
        if shutil.which('node') is None:
            self.skipTest('Node is not available')
        self.install()
        command = b'{"action":"settle","args":{"outcome":"acknowledged"}}'
        with connection(self.database) as db:
            db.execute('INSERT INTO research_control_commands VALUES(?,?,?,?,?)', ('legacy','request','a'*64,command,json.dumps({'status':'committed'})))
            self.assertFalse(cd.cancellation_settlement_runtime_required(db))
        scripts = self.root/'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export function validateConfig(){throw Error('config_opened')}")
        old = 'export const REPOSITORY_RESEARCH_INPUTS_VERSION=1;export const LAYERED_RESEARCH_BUDGET_VERSION=1;'
        for mode in ['historical', 'new-old-runtime', 'new-compatible-runtime']:
            if mode == 'new-old-runtime':
                with connection(self.database) as db:
                    db.execute('INSERT INTO research_control_commands VALUES(?,?,?,?,?)', ('new','request','b'*64,command,json.dumps({'status':'committed','cancellation_settlement_version':1})))
                    self.assertTrue(cd.cancellation_settlement_runtime_required(db))
            (scripts/'research-control.mjs').write_text(old + ('export const CANCELLATION_SETTLEMENT_VERSION=1;' if mode=='new-compatible-runtime' else ''))
            config, operation = self.config(); before = cd.snapshot(self.database)
            def probe(config, release, arguments, **kwargs):
                script = arguments[-1].replace('/probe/publisher.json',(self.root/'publisher.json').as_posix())
                result = subprocess.run(['node','--input-type=module','-e',script],cwd=release,capture_output=True,text=True)
                self.assertNotEqual(result.returncode,0)
                if mode == 'new-old-runtime':
                    self.assertIn('cancellation_settlements_require_compatible_release',result.stderr)
                    self.assertNotIn('config_opened',result.stderr)
                else:
                    self.assertNotIn('cancellation_settlements_require_compatible_release',result.stderr)
                    self.assertIn('config_opened',result.stderr)
                self.assertNotIn('state_opened',result.stderr)
                raise ValueError('synthetic probe finished')
            with patch.object(cd,'container',side_effect=probe),patch.object(cd,'legacy_dependency_mount',return_value=[]),patch.object(os,'chown',create=True):
                with self.assertRaisesRegex(ValueError,'synthetic probe finished'):
                    cd.compatibility(config,self.root,operation,before)
            self.assertEqual(cd.snapshot(self.database),before)
        with connection(self.database) as db:
            db.execute('UPDATE research_control_commands SET result=? WHERE command_id=?',(json.dumps({'status':'committed','cancellation_settlement_version':2}),'new'))
            with self.assertRaisesRegex(ValueError,'cancellation_settlement_version_invalid'):
                cd.cancellation_settlement_runtime_required(db)

    def test_only_new_versioned_permit_receipts_fence_rollback(self):
        self.install(); self.cancelled_permit(marked=False)
        before = cd.snapshot(self.database)
        with connection(self.database) as db:
            self.assertFalse(cd.cancellation_page_runtime_required(db))
        self.assertEqual(cd.snapshot(self.database),before)
        with connection(self.database) as db:
            command = b'{"action":"permit"}'
            db.execute('INSERT INTO research_control_commands VALUES(?,?,?,?,?)', ('new','request','e'*64,command,json.dumps({'status':'committed','cancellation_page_version':1})))
            self.assertTrue(cd.cancellation_page_runtime_required(db))
            db.execute('UPDATE research_control_commands SET result=?', (json.dumps({'status':'committed','cancellation_page_version':2}),))
            with self.assertRaisesRegex(ValueError,'cancellation_permit_version_invalid'):
                cd.cancellation_page_runtime_required(db)

    def test_cancellation_page_permit_blocks_old_runtime_before_open(self):
        if shutil.which('node') is None:
            self.skipTest('Node is not available')
        self.install(); self.cancelled_permit(page=True)
        scripts = self.root/'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export const PAGE_AUTHORITY_VERSION=1;export function validateConfig(){throw Error('config_opened')}")
        (scripts/'research-page-authority.mjs').write_text('export const PAGE_AUTHORITY_VERSION=1;')
        (scripts/'research-control.mjs').write_text('export const REPOSITORY_RESEARCH_INPUTS_VERSION=1;export const LAYERED_RESEARCH_BUDGET_VERSION=1;export const MODEL_CONTINUATION_VERSION=1;')
        config,operation=self.config();before=cd.snapshot(self.database)
        def probe(config,release,arguments,**kwargs):
            result=subprocess.run(['node','--input-type=module','-e',arguments[-1]],cwd=release,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('cancellation_pages_require_compatible_release',result.stderr)
            self.assertNotIn('config_opened',result.stderr);self.assertNotIn('state_opened',result.stderr)
            raise ValueError('candidate_incompatible')
        with patch.object(cd,'container',side_effect=probe),patch.object(cd,'legacy_dependency_mount',return_value=[]),patch.object(os,'chown',create=True):
            with self.assertRaisesRegex(ValueError,'candidate_incompatible'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)

    def test_historical_cancellation_does_not_fence_initial_upgrade(self):
        if shutil.which('node') is None:
            self.skipTest('Node is not available')
        self.install(); self.cancelled_permit(marked=False,page=True)
        scripts = self.root/'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export const PAGE_AUTHORITY_VERSION=1;export function validateConfig(){throw Error('config_opened')}")
        (scripts/'research-page-authority.mjs').write_text('export const PAGE_AUTHORITY_VERSION=1;')
        (scripts/'research-control.mjs').write_text('export const REPOSITORY_RESEARCH_INPUTS_VERSION=1;export const LAYERED_RESEARCH_BUDGET_VERSION=1;export const MODEL_CONTINUATION_VERSION=1;')
        config,operation=self.config();before=cd.snapshot(self.database)
        def probe(config,release,arguments,**kwargs):
            result=subprocess.run(['node','--input-type=module','-e',arguments[-1].replace('/probe/publisher.json',(self.root/'publisher.json').as_posix())],cwd=release,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn('cancellation_pages_require_compatible_release',result.stderr)
            self.assertIn('config_opened',result.stderr);self.assertNotIn('state_opened',result.stderr)
            raise ValueError('candidate_incompatible')
        with patch.object(cd,'container',side_effect=probe),patch.object(cd,'legacy_dependency_mount',return_value=[]),patch.object(os,'chown',create=True):
            with self.assertRaisesRegex(ValueError,'candidate_incompatible'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)

    def test_old_runtime_rejected_before_config_and_state_open(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('Node is required for candidate rejection check')
        self.install()
        scripts = self.root / 'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export function validateConfig(){throw Error('config_opened')}")
        (scripts/'research-control.mjs').write_text('export const REPOSITORY_RESEARCH_INPUTS_VERSION=1;')
        config, operation = self.config(); before = cd.snapshot(self.database)
        def probe(config, release, arguments, **kwargs):
            result = subprocess.run([node,'--input-type=module','-e',arguments[-1]],cwd=release,capture_output=True,text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('layered_budget_requires_compatible_release', result.stderr)
            self.assertNotIn('config_opened', result.stderr)
            self.assertNotIn('state_opened', result.stderr)
            raise ValueError('candidate_incompatible')
        with patch.object(cd,'container',side_effect=probe), patch.object(cd,'legacy_dependency_mount',return_value=[]), patch.object(os,'chown'):
            with self.assertRaisesRegex(ValueError,'candidate_incompatible'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)

    def test_persisted_full_page_bundle_blocks_old_decoder_before_state_open(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('Node required')
        report = dict(schema_version='1.2', revision=1, page_delivery=dict(previous=None, added=[], pending=[]))
        raw = json.dumps(dict(files=[dict(path='reports/2026-11-13/report.json', base64=base64.b64encode(json.dumps(report).encode()).decode())])).encode()
        with connection(self.database) as database:
            database.execute('UPDATE jobs SET bytes=?', (raw,))
        scripts = self.root / 'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export const REVISION_NOTICES_VERSION=1;export function validateConfig(){throw Error('config_opened')}")
        (scripts/'research-page-authority.mjs').write_text('export const PAGE_AUTHORITY_VERSION=0;')
        config, operation = self.config(); before = cd.snapshot(self.database)
        def probe(config, release, arguments, **kwargs):
            result = subprocess.run([node,'--input-type=module','-e',arguments[-1]],cwd=release,capture_output=True,text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('page_authority_requires_compatible_release', result.stderr)
            self.assertNotIn('config_opened', result.stderr)
            self.assertNotIn('state_opened', result.stderr)
            raise ValueError('candidate_incompatible')
        with patch.object(cd,'container',side_effect=probe), patch.object(cd,'legacy_dependency_mount',return_value=[]), patch.object(os,'chown'):
            with self.assertRaisesRegex(ValueError,'candidate_incompatible'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)

    def test_probe_retains_recovery_rows_and_does_not_install_on_legacy(self):
        config, operation = self.config()
        def probe(config, release, arguments, **kwargs):
            mount=kwargs['extra'][1]; copied=Path(mount[len('type=bind,src='):-len(',dst=/probe')])/'handoff.sqlite'
            self.assertEqual(cd.snapshot(copied), before)
            self.assertEqual('LAYERED_RESEARCH_BUDGET_VERSION' in arguments[-1], installed)
        for installed in [False, True]:
            if installed:
                self.install()
            before=cd.snapshot(self.database)
            with patch.object(cd,'container',side_effect=probe), patch.object(cd,'legacy_dependency_mount',return_value=[]), patch.object(os,'chown'):
                cd.compatibility(config,self.root,operation,before)
            self.assertEqual(cd.snapshot(self.database),before)
        def mutation(config, release, arguments, **kwargs):
            mount=kwargs['extra'][1]; copied=Path(mount[len('type=bind,src='):-len(',dst=/probe')])/'handoff.sqlite'
            with connection(copied) as database:
                database.execute("UPDATE research_recovery_authorizations SET bytes=?", (b'changed',))
        with patch.object(cd,'container',side_effect=mutation), patch.object(cd,'legacy_dependency_mount',return_value=[]), patch.object(os,'chown'):
            with self.assertRaisesRegex(ValueError,'automatic_state_migration_not_supported'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)

    def test_cd_schema_matches_runtime_export_exactly(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('Node is required for runtime schema comparison')
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run([node,'--input-type=module','-e',"import{RESEARCH_RECOVERY_SCHEMA}from'./scripts/research-recovery.mjs';console.log(JSON.stringify(RESEARCH_RECOVERY_SCHEMA))"],cwd=root,capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(result.stdout), cd.RESEARCH_RECOVERY_SCHEMA)



class ArchiveRecoveryCdTests(unittest.TestCase):
    setUp = LedgerTests.setUp
    install = ResearchRecoveryCdTests.install
    config = ResearchRecoveryCdTests.config
    def marker(self):
        with connection(self.database) as database:
            database.execute(cd.ARCHIVE_RECOVERY_SCHEMA)
            database.execute('INSERT INTO research_control_archive_recovery VALUES(1,1)')

    def test_archive_marker_exact_snapshot_and_row(self):
        self.install()
        before = cd.snapshot(self.database)
        with connection(self.database) as database:
            self.assertFalse(cd.archive_recovery_runtime_required(database))
        self.marker()
        after = cd.snapshot(self.database)
        self.assertNotEqual(before, after)
        with connection(self.database) as database:
            self.assertTrue(cd.archive_recovery_runtime_required(database))
            database.execute('DELETE FROM research_control_archive_recovery')
        with self.assertRaisesRegex(ValueError, 'invalid_archive_recovery_marker'):
            cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute('DROP TABLE research_control_archive_recovery')
            database.execute(cd.ARCHIVE_RECOVERY_SCHEMA.replace('CHECK(version=1)', 'CHECK(version>0)'))
            database.execute('INSERT INTO research_control_archive_recovery VALUES(1,1)')
        with self.assertRaisesRegex(ValueError, 'unsupported_research_control_schema'):
            cd.snapshot(self.database)

    def test_archive_marker_probe_and_no_legacy_install(self):
        self.install()
        config, operation = self.config()
        for installed in (False, True):
            if installed:
                self.marker()
            before = cd.snapshot(self.database)
            def probe(config, release, arguments, **kwargs):
                self.assertEqual('ARCHIVE_RECOVERY_VERSION' in arguments[-1], installed)
                mount = kwargs['extra'][1]
                copied = Path(mount[len('type=bind,src='):-len(',dst=/probe')]) / 'handoff.sqlite'
                self.assertEqual(cd.snapshot(copied), before)
            with patch.object(cd, 'container', side_effect=probe), patch.object(cd, 'legacy_dependency_mount', return_value=[]), patch.object(os, 'chown'):
                cd.compatibility(config, self.root, operation, before)
            self.assertEqual(cd.snapshot(self.database), before)

    def test_archive_marker_incompatible_candidate_rejected_before_state_open(self):
        self.install(); self.marker()
        scripts = self.root / 'scripts'; scripts.mkdir()
        (scripts/'handoff-state.mjs').write_text("export class HandoffState{constructor(){throw Error('state_opened')}};export const handoffScope=x=>x;")
        (scripts/'notice-outbox.mjs').write_text("export class NoticeOutbox{};export const notificationScope=x=>x;")
        (scripts/'run-handoff.mjs').write_text("export function validateConfig(){throw Error('config_opened')}")
        (scripts/'research-archive-recovery.mjs').write_text('export const ARCHIVE_RECOVERY_VERSION=0;')
        config, operation = self.config(); before = cd.snapshot(self.database)
        def probe(config, release, arguments, **kwargs):
            result = subprocess.run(['node','--input-type=module','-e',arguments[-1]], cwd=release, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('archive_recovery_requires_compatible_release', result.stderr)
            self.assertNotIn('config_opened', result.stderr)
            self.assertNotIn('state_opened', result.stderr)
            raise ValueError('candidate_incompatible')
        with patch.object(cd,'container',side_effect=probe), patch.object(cd,'legacy_dependency_mount',return_value=[]), patch.object(os,'chown'):
            with self.assertRaisesRegex(ValueError,'candidate_incompatible'):
                cd.compatibility(config,self.root,operation,before)
        self.assertEqual(cd.snapshot(self.database),before)


if __name__ == "__main__":
    unittest.main()
