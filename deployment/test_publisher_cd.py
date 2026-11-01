"""公开来源、账本防重和排空回滚边界的无副作用回归。"""

import hashlib
import datetime
import errno
import os
from contextlib import contextmanager, closing
import io
import json
from pathlib import Path
import sqlite3
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
                "CREATE TABLE jobs(id TEXT PRIMARY KEY,phase TEXT,bytes BLOB);INSERT INTO jobs VALUES('report','receipt_sent',X'0102');"
                "CREATE TABLE notices(id TEXT PRIMARY KEY,phase TEXT);"
                "CREATE TABLE notice_commands(id TEXT PRIMARY KEY,phase TEXT);")

    def test_row_mutation_with_identical_counts_is_detected(self):
        before = cd.snapshot(self.database)
        with connection(self.database) as database:
            database.execute("UPDATE jobs SET bytes=X'0201'")
        self.assertNotEqual(cd.snapshot(self.database), before)

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
