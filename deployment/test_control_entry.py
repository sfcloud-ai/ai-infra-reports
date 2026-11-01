"""控制程序版本转换的离线回归，不访问服务、凭据或生产账本。"""

import hashlib
import datetime
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from deployment import control_entry as control
from deployment import publisher_cd as publisher


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.before, self.target = 'a' * 40, 'b' * 40
        (self.root / 'code').mkdir()
        self.old = self.version(self.before)
        self.new = self.version(self.target)
        self.patches = [patch.object(control, 'admin'),
                        patch.object(control, 'atomic', side_effect=lambda p,d,*a,**kw: p.write_bytes(d)),
                        patch.object(control, 'sync_directory')]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        control.save(self.root / 'control-release.json', self.old)
        self.evidence = {'commit': self.before, 'unit_sha256': 'old-unit', 'config_sha256': 'same-config',
                         'publisher_config_sha256': 'same-publisher-config'}
        self.config = dict(self.evidence)

    def version(self, commit):
        directory = self.root / 'code' / commit
        directory.mkdir()
        data = b'pass\n'
        (directory / 'publisher_cd.py').write_bytes(data)
        return {'commit': commit, 'files': {'publisher_cd.py': hashlib.sha256(data).hexdigest()}}

    def run_candidate(self, call):
        return control.execute(self.root, prepare=lambda *args: self.new, call=call,
                               observe=lambda *args: dict(self.evidence),
                               read=lambda *args: {'object': {'type': 'commit', 'sha': self.target}})

    def result(self, status, code=0):
        return SimpleNamespace(returncode=code, stdout=json.dumps({'status': status, 'commit': self.target}).encode())

    def test_success_keeps_previous_controller_and_does_not_touch_ledger(self):
        ledger = self.root / 'ledger'
        ledger.write_bytes(b'immutable delivery evidence')
        def call(directory, commit):
            self.assertEqual(directory.name, self.target)
            self.assertEqual(commit, self.target)
            self.assertTrue((self.root / 'control-pending.json').exists())
            self.evidence.update(commit=self.target, unit_sha256='new-unit')
            return self.result('updated')
        with patch.object(control, 'sync_directory', side_effect=lambda p: self.assertFalse((p / 'control-pending.json').exists())) as sync:
            self.run_candidate(call)
        sync.assert_called_once_with(self.root)
        self.assertEqual(control.current_record(self.root)[0], self.new)
        self.assertEqual(json.loads((self.root / 'control-previous.json').read_text()), self.old)
        self.assertFalse((self.root / 'control-pending.json').exists())
        self.assertEqual(ledger.read_bytes(), b'immutable delivery evidence')

    def test_deferred_work_preserves_original_controller_and_can_retry_later(self):
        self.run_candidate(lambda *args: self.result('deferred'))
        self.assertEqual(control.current_record(self.root)[0], self.old)
        self.assertFalse((self.root / 'control-blocked.json').exists())
        self.run_candidate(lambda *args: self.result('deferred'))
        self.assertFalse((self.root / 'control-pending.json').exists())

    def test_known_failure_or_application_rollback_blocks_the_same_candidate(self):
        for status, code in [('blocked', 1), ('rolled_back', 0)]:
            with self.subTest(status=status):
                (self.root / 'control-blocked.json').unlink(missing_ok=True)
                self.run_candidate(lambda *args: self.result(status, code))
                self.assertEqual(control.current_record(self.root)[0], self.old)
                with self.assertRaisesRegex(ValueError, 'previously_failed'):
                    self.run_candidate(lambda *args: self.fail('不得重复失败候选'))

    def test_unknown_outcome_preserves_intent_and_never_repeats_execution(self):
        def timeout(*args):
            raise TimeoutError('unknown')
        with self.assertRaises(TimeoutError):
            self.run_candidate(timeout)
        with self.assertRaisesRegex(ValueError, 'requires_reconciliation'):
            self.run_candidate(lambda *args: self.fail('不能重复未知调用'))
        self.assertEqual(control.current_record(self.root)[0], self.new)

    def test_same_controller_timeout_is_durable_and_cannot_repeat_after_restart(self):
        self.target = self.before
        with self.assertRaises(TimeoutError):
            self.run_candidate(lambda *args: (_ for _ in ()).throw(TimeoutError('unknown')))
        with self.assertRaisesRegex(ValueError, 'requires_reconciliation'):
            self.run_candidate(lambda *args: self.fail('同一控制器的未知执行也不能重试'))

    def test_same_controller_success_preserves_previous_version(self):
        self.target = self.before
        previous = self.root / 'control-previous.json'
        previous.write_text('preserve known rollback target')
        self.run_candidate(lambda *args: self.result('current'))
        self.assertEqual(previous.read_text(), 'preserve known rollback target')
        self.assertFalse((self.root / 'control-pending.json').exists())

    def test_publisher_configuration_change_prevents_success_or_failure_classification(self):
        for code in (0, 1):
            (self.root / 'control-pending.json').unlink(missing_ok=True)
            control.save(self.root / 'control-release.json', self.old)
            self.evidence = dict(self.config)
            def call(*args):
                self.evidence['publisher_config_sha256'] = 'changed'
                if code == 0:
                    self.evidence['commit'] = self.target
                return self.result('updated', code)
            with self.assertRaisesRegex(ValueError, 'requires_reconciliation'):
                self.run_candidate(call)
            self.assertTrue((self.root / 'control-pending.json').exists())

    def test_observed_baseline_includes_the_actual_publisher_configuration(self):
        config_path = self.root / 'updater.json'
        publisher_path = self.root / 'publisher.json'
        unit = self.root / 'publisher.service'
        unit.write_text('fixed unit')
        publisher_path.write_text('configuration one')
        config_path.write_text(json.dumps({'unit':str(unit),'publisher_config':str(publisher_path),
            'state':str(self.root),'base':str(self.root)}))
        (self.root / 'active.json').write_text(json.dumps({'commit':self.before}))
        (self.root / 'health.json').write_text(json.dumps({'healthy':True,'commit':self.before,
            'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'successful_checks':2}))
        properties = 'MainPID=123\nActiveState=active\nWorkingDirectory='+str(self.root/'releases'/self.before)+'\n'
        with patch.object(control, 'CONFIG', config_path), patch.object(control.subprocess, 'run',
                return_value=SimpleNamespace(returncode=0, stdout=properties)):
            before = control.application(self.root)
            publisher_path.write_text('configuration two')
            after = control.application(self.root)
        self.assertEqual(before['config_sha256'], after['config_sha256'])
        self.assertNotEqual(before['publisher_config_sha256'], after['publisher_config_sha256'])

    def test_child_pending_or_changed_config_cannot_commit_or_rollback(self):
        for mode in ('pending', 'config'):
            with self.subTest(mode=mode):
                (self.root / 'control-pending.json').unlink(missing_ok=True)
                (self.root / 'pending.json').unlink(missing_ok=True)
                control.save(self.root / 'control-release.json', self.old)
                self.evidence = dict(self.config)
                def call(*args):
                    if mode == 'pending':
                        (self.root / 'pending.json').write_text('{}')
                    else:
                        self.evidence['config_sha256'] = 'changed'
                    return self.result('deferred')
                with self.assertRaisesRegex(ValueError, 'requires_reconciliation'):
                    self.run_candidate(call)
                self.assertTrue((self.root / 'control-pending.json').exists())

    def test_modified_controller_is_rejected_before_intent_or_execution(self):
        (self.root / 'code' / self.target / 'publisher_cd.py').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'file_changed'):
            self.run_candidate(lambda *args: self.fail('不得执行修改文件'))
        self.assertFalse((self.root / 'control-pending.json').exists())

    def test_latest_ci_attempt_and_exact_repository_are_required(self):
        run = dict(id=1, run_attempt=1, head_sha=self.target, head_branch='main', event='push',
                   path='.github/workflows/validate.yml', repository={'full_name': control.REPOSITORY},
                   status='completed', conclusion='success')
        runs = [run]
        def read(path):
            if path == '/git/ref/heads/main':
                return {'object': {'type': 'commit', 'sha': self.target}}
            if path.startswith('/compare/'):
                return {'status': 'ahead', 'base_commit': {'sha': self.before}, 'merge_base_commit': {'sha': self.before}}
            return {'workflow_runs': runs}
        self.assertEqual(control.trusted_candidate(self.target, self.before, read)['run_id'], 1)
        runs.append(dict(run, run_attempt=2, conclusion='failure'))
        with self.assertRaisesRegex(ValueError, 'not_successful'):
            control.trusted_candidate(self.target, self.before, read)
        runs[:] = [dict(run, repository={'full_name': 'other/repository'})]
        with self.assertRaises(control.CandidatePending):
            control.trusted_candidate(self.target, self.before, read)

    def test_new_deployment_module_is_included_but_symlink_tree_is_rejected(self):
        tree = {'truncated': False, 'tree': [dict(path='deployment/' + name, type='blob', mode='100644', sha=self.before)
                                           for name in ('publisher_cd.py', 'helpers/new_module.py')]}
        def read(path):
            return {'tree': {'sha': self.before}} if '/git/commits/' in path else tree
        self.assertIn('helpers/new_module.py', control.source_tree(self.target, read))
        tree['tree'][-1]['mode'] = '120000'
        with self.assertRaises(ValueError):
            control.source_tree(self.target, read)

    def test_pinned_controller_cannot_deploy_a_different_commit(self):
        (self.root / 'active.json').write_text(json.dumps({'commit': self.before}))
        config = {'control': str(self.root), 'state': str(self.root)}
        with patch.dict(publisher.os.environ, {'REPORT_CD_EXPECTED_SHA': self.target}), \
                patch.object(publisher, 'health', return_value=True), patch.object(publisher, 'snapshot'), \
                patch.object(publisher, 'select_candidate', return_value={'commit': 'c' * 40}), \
                patch.object(publisher, 'stage') as stage:
            with self.assertRaisesRegex(publisher.Deferred, 'superseded'):
                publisher._tick(config)
            stage.assert_not_called()


@unittest.skipUnless(os.name == 'posix', '完整部署校验在 Linux 执行')
class DurableFileTests(unittest.TestCase):
    def test_readonly_code_mode_survives_restrictive_service_umask(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'code.py'
            previous = os.umask(0o077)
            try:
                control.atomic(path, b'pass\n', 0o444)
            finally:
                os.umask(previous)
            self.assertEqual(path.stat().st_mode & 0o777, 0o444)
            self.assertEqual(path.read_bytes(), b'pass\n')


if __name__ == '__main__':
    unittest.main()
