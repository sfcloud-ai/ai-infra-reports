"""Isolated filesystem/process regression cases; no real Slack or delivery IO."""
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import signal
import pty
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'producer-day-guard.py'
spec = importlib.util.spec_from_file_location('dayguard', SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
NOW = dt.datetime.fromisoformat('2026-11-11T00:20:00+00:00')


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'original'
        self.generation = str(uuid.uuid4())
        guard.initialize(self.root, self.generation, '2026-11-10')

    def tearDown(self):
        self.temp.cleanup()

    def open(self, when=NOW):
        return guard.DayGuard(self.root, self.generation, 'actual-hourly-fixture', clock=lambda: when)

    def snapshot(self, g):
        receipt = {'kind': 'day', 'complete': True, 'request_id': g.request, 'report_date': g.day,
                   'state': 'empty', 'observed_at': int(g.clock().timestamp() * 1000),
                   'source_ts': '1794356400.000001', 'scan_watermark': '1794356400.000001',
                   'query_id': '11111111-1111-4111-8111-111111111111',
                   'publisher_scope_sha256': 'b' * 64, 'scheduler_scope_sha256': 'c' * 64,
                   'publisher_day': [], 'publisher_intake': [], 'staged_bundles': [],
                   'pending_submissions': [], 'scheduler': None, 'scheduler_day_claim': None}
        return g.dispatch({'action': 'snapshot', 'receipt': receipt})

    def begin(self, g):
        self.snapshot(g)
        return g.dispatch({'action': 'begin', 'research': {'prompt_commit_sha': 'a' * 40,
                          'budget': {'max_attempts': 3, 'seconds': 1200}, 'audit_directory': str(self.root / 'audit')}})

    def test_hourly_first_start_at_0820_and_resume_preserve_budget(self):
        g = self.open()
        try:
            self.assertEqual(g.request, 'morning-20261111-r1')
            self.begin(g)
            g.dispatch({'action': 'record', 'evidence': {'attempts_used': 2, 'phase': 'research'}})
            original = g.record['research']
        finally:
            g.close()
        resumed = self.open()
        try:
            self.assertEqual(resumed.record['research'], original)
            self.begin(resumed)
            with self.assertRaisesRegex(ValueError, 'budget_and_version'):
                resumed.dispatch({'action': 'begin', 'research': {**original, 'budget': {'max_attempts': 30}}})
            self.assertTrue(any(e.get('evidence', {}).get('attempts_used') == 2 for e in resumed.record['events']))
        finally:
            resumed.close()

    def test_real_process_contention_and_crash_release_keep_original_intent(self):
        code = """import importlib.util,sys,datetime as dt
from pathlib import Path
s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
g=m.DayGuard(Path(sys.argv[2]),sys.argv[3],'child-session',clock=lambda:dt.datetime.fromisoformat('2026-11-11T00:20:00+00:00'))
g.event({'type':'synthetic_unknown_intent'})
print('locked',flush=True)
sys.stdin.readline()
"""
        child = subprocess.Popen([sys.executable, '-c', code, str(SCRIPT), str(self.root), self.generation],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'locked')
            with self.assertRaises(BlockingIOError):
                self.open()
            child.kill()
            child.wait(timeout=5)
            resumed = self.open()
            try:
                self.assertTrue(any(e['type'] == 'synthetic_unknown_intent' for e in resumed.record['events']))
            finally:
                resumed.close()
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdin.close(); child.stdout.close(); child.stderr.close()

    def test_unknown_stage_survives_crash_and_prevents_replay(self):
        g = self.open()
        try:
            self.begin(g)
            path = self.root / 'synthetic-input.json'
            data = json.dumps({'request_id': g.request, 'prompt_commit_sha': 'a' * 40}).encode()
            path.write_bytes(data)
            calls = []
            def crash(*args):
                calls.append(args)
                raise RuntimeError('constructed process loss before receipt')
            g.stage = crash
            command = {'action': 'stage', 'bundle': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'channel': 'CTEST'}
            with self.assertRaises(RuntimeError):
                g.dispatch(command)
            self.assertEqual(len(calls), 1)
        finally:
            g.close()
        resumed = self.open()
        try:
            self.snapshot(resumed)
            resumed.stage = lambda *args: self.fail('unknown stage must not replay')
            with self.assertRaisesRegex(ValueError, 'reconciliation'):
                resumed.dispatch(command)
            self.assertEqual(resumed.record['stage']['phase'], 'intent')
        finally:
            resumed.close()

    def test_previous_day_unknown_does_not_block_new_day_and_timezone_is_explicit(self):
        old = self.open(dt.datetime.fromisoformat('2026-11-10T15:59:00+00:00'))
        try:
            old.record['stage'] = {'phase': 'unknown'}
            old.event({'type': 'synthetic_unknown'})
        finally:
            old.close()
        g = self.open()
        try:
            self.assertEqual(g.day, '2026-11-11')
            self.assertIsNone(g.record['stage'])
            self.begin(g)
            g.clock = lambda: NOW + dt.timedelta(days=1)
            with self.assertRaisesRegex(ValueError, 'day_has_ended'):
                g.snapshot_empty()
        finally:
            g.close()
        with self.assertRaisesRegex(ValueError, 'before_daily_start'):
            self.open(dt.datetime.fromisoformat('2026-11-10T23:19:59+00:00'))

    def test_real_child_exit_before_first_write_can_resume_original_bundle(self):
        g = self.open()
        try:
            self.begin(g)
            path = self.root / 'input.json'
            data = json.dumps({'request_id': g.request, 'prompt_commit_sha': 'a' * 40}).encode(); path.write_bytes(data)
            command = {'action': 'stage', 'bundle': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'channel': 'CTEST'}
            original = g.stage
            # Controlled bridge subprocess, no provider/network IO. This proves
            # process-outcome handling, not a real Slack rejection.
            g.stage = lambda b, c: original(b, c, bridge=[sys.executable, '-c', 'raise SystemExit(1)'])
            g.dispatch(command)
            self.assertEqual(g.record['stage']['phase'], 'not_started')
            g.dispatch(command)
            self.assertEqual(g.record['stage']['phase'], 'not_started')
            self.assertEqual(sum(e['type'] == 'stage_process_exit' for e in g.record['events']), 2)
            changed = json.dumps({'request_id': g.request, 'prompt_commit_sha': 'a' * 40, 'different': True}).encode(); path.write_bytes(changed)
            with self.assertRaisesRegex(ValueError, 'saved_bundle_differs'):
                g.dispatch({**command, 'sha256': hashlib.sha256(changed).hexdigest()})
        finally:
            g.close()

    def test_real_child_exit_after_forwarded_native_write_keeps_unknown(self):
        g = self.open()
        try:
            self.begin(g)
            path = self.root / 'input.json'
            data = json.dumps({'request_id': g.request, 'prompt_commit_sha': 'a' * 40}).encode(); path.write_bytes(data)
            command = {'action': 'stage', 'bundle': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'channel': 'CTEST'}
            original = g.stage
            code = "import json,sys;print(json.dumps({'type':'write','operation_id':'fixture','tool':'fixture'}),flush=True);sys.stdin.readline();raise SystemExit(1)"
            g.stage = lambda b, c: original(b, c, bridge=[sys.executable, '-c', code])
            with patch.object(sys, 'stdin', io.StringIO('{"type":"native_result"}\n')):
                g.dispatch(command)
            self.assertEqual(g.record['stage']['phase'], 'unknown')
            with self.assertRaisesRegex(ValueError, 'reconciliation'):
                g.dispatch(command)
        finally:
            g.close()

    def test_missing_or_replaced_installation_and_incomplete_receipt_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError, 'installation'):
            guard.DayGuard(self.root, str(uuid.uuid4()), 'fixture', clock=lambda: NOW)
        g = self.open()
        try:
            with self.assertRaisesRegex(ValueError, 'reconciliation'):
                g.snapshot_empty()
            self.snapshot(g)
            old = {**g.snapshot, 'observed_at': g.snapshot['observed_at'] - 61000}
            with self.assertRaisesRegex(ValueError, 'fresh_day_snapshot'):
                g.dispatch({'action': 'snapshot', 'receipt': old})
        finally:
            g.close()

    def test_prompt_version_mismatch_is_rejected_before_any_stage_intent_or_copy(self):
        g = self.open()
        try:
            self.begin(g)
            path = self.root / 'input.json'
            data = json.dumps({'request_id': g.request, 'prompt_commit_sha': 'b' * 40}).encode()
            path.write_bytes(data)
            with self.assertRaisesRegex(ValueError, 'research_version'):
                g.dispatch({'action': 'stage', 'bundle': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'channel': 'CTEST'})
            self.assertIsNone(g.record['stage'])
            self.assertFalse((self.root / '2026-11-11.bundle.json').exists())
        finally:
            g.close()

    def test_clock_skew_is_bounded_and_monotonic_expiry_survives_wall_clock_change(self):
        g = self.open()
        try:
            self.snapshot(g)
            future = {**g.snapshot, 'observed_at': g.snapshot['observed_at'] + 20000}
            g.dispatch({'action': 'snapshot', 'receipt': future})
            g.snapshot_empty()
            with patch.object(guard.time, 'monotonic', return_value=g.snapshot_deadline + 1):
                with self.assertRaisesRegex(ValueError, 'fresh_day_snapshot'):
                    g.snapshot_empty()
            with self.assertRaisesRegex(ValueError, 'fresh_day_snapshot'):
                g.dispatch({'action': 'snapshot', 'receipt': {**future, 'observed_at': future['observed_at'] + 20000}})
        finally:
            g.close()

    def test_existing_date_marker_with_lost_journal_requires_reconciliation(self):
        g = self.open()
        g.close()
        (self.root / '2026-11-11.json').unlink()
        with self.assertRaisesRegex(ValueError, 'record_missing_reconcile'):
            self.open()
        self.assertFalse((self.root / '2026-11-11.json').exists())

    def test_staging_node_child_keeps_lock_after_guard_parent_dies(self):
        code = """import importlib.util,sys,datetime as dt
from pathlib import Path
s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
g=m.DayGuard(Path(sys.argv[2]),sys.argv[3],'parent-fixture',clock=lambda:dt.datetime.fromisoformat('2026-11-11T00:20:00+00:00'))
g.record['stage']={'phase':'intent'};g.event({'type':'synthetic_stage_intent'})
node="console.log(JSON.stringify({type:'fixture_pid',pid:process.pid}));console.log(JSON.stringify({type:'write',operation_id:'fixture',tool:'fixture'}));setInterval(()=>{},1000);"
g.stage(Path('/unused-fixture'), 'CTEST', bridge=['node','-e',node])
"""
        parent = subprocess.Popen([sys.executable, '-c', code, str(SCRIPT), str(self.root), self.generation],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child_pid = None
        try:
            child_pid = json.loads(parent.stdout.readline())['pid']
            self.assertEqual(json.loads(parent.stdout.readline())['type'], 'write')
            parent.kill(); parent.wait(timeout=5)
            with self.assertRaises(BlockingIOError):
                self.open()
            os.kill(child_pid, signal.SIGTERM)
            child_pid = None
            deadline = time.monotonic() + 5
            while True:
                try:
                    resumed = self.open()
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.02)
            try:
                self.assertEqual(resumed.record['stage']['phase'], 'intent')
            finally:
                resumed.close()
        finally:
            if parent.poll() is None:
                parent.kill(); parent.wait()
            if child_pid is not None:
                os.kill(child_pid, signal.SIGTERM)
            parent.stdin.close(); parent.stdout.close(); parent.stderr.close()

    def test_actual_pty_does_not_echo_private_stdin(self):
        master, slave = pty.openpty()
        code = """import importlib.util,sys,datetime as dt
s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.utcnow=lambda:dt.datetime.fromisoformat('2026-11-11T00:20:00+00:00')
raise SystemExit(m.main(['run',sys.argv[2],sys.argv[3],'pty-fixture']))
"""
        child = subprocess.Popen([sys.executable, '-c', code, str(SCRIPT), str(self.root), self.generation],
                                 stdin=slave, stdout=slave, stderr=subprocess.PIPE)
        os.close(slave)
        def read_until(marker):
            data = b''
            deadline = time.monotonic() + 5
            while marker not in data:
                require_time = deadline - time.monotonic()
                self.assertGreater(require_time, 0, data)
                self.assertTrue(select.select([master], [], [], require_time)[0])
                data += os.read(master, 65536)
            return data
        try:
            read_until(b'guard_acquired')
            marker = 'SYNTHETIC_PRIVATE_NATIVE_TICKET'
            os.write(master, (json.dumps({'action': 'record', 'evidence': {'fixture': marker}}) + '\n').encode())
            output = read_until(b'checkpoint_saved')
            self.assertNotIn(marker.encode(), output)
            os.write(master, b'{"action":"release"}\n')
            read_until(b'guard_released')
            self.assertEqual(child.wait(timeout=5), 0)
        finally:
            if child.poll() is None:
                child.kill(); child.wait()
            os.close(master); child.stderr.close()

    def test_lost_open_stdin_exits_and_successor_retains_original_budget(self):
        g = self.open()
        self.begin(g)
        original = g.record['research']
        g.close()
        code = """import importlib.util,sys,datetime as dt
s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.utcnow=lambda:dt.datetime.fromisoformat('2026-11-11T00:20:00+00:00')
raise SystemExit(m.main(['run',sys.argv[2],sys.argv[3],'idle-fixture'],idle_seconds=0.2))
"""
        child = subprocess.Popen([sys.executable, '-c', code, str(SCRIPT), str(self.root), self.generation],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(json.loads(child.stdout.readline())['type'], 'guard_acquired')
            # Keep the pipe open, simulating a lost tool handle rather than EOF.
            self.assertEqual(child.wait(timeout=5), 1)
            self.assertEqual(json.loads(child.stdout.readline())['reason'], 'guard_input_idle')
            resumed = self.open()
            try:
                self.assertEqual(resumed.record['research'], original)
            finally:
                resumed.close()
        finally:
            if child.poll() is None:
                child.kill(); child.wait()
            child.stdin.close(); child.stdout.close(); child.stderr.close()

    def test_silent_stage_and_missing_native_result_have_distinct_outcomes(self):
        g = self.open()
        read_fd, write_fd = os.pipe()
        source = os.fdopen(read_fd, 'r')
        try:
            self.begin(g)
            g.input_reader = guard.LineInput(source, idle_seconds=0.1)
            path = self.root / 'input.json'
            data = json.dumps({'request_id': g.request, 'prompt_commit_sha': 'a' * 40}).encode()
            path.write_bytes(data)
            command = {'action': 'stage', 'bundle': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'channel': 'CTEST'}
            original = g.stage
            g.stage = lambda b, c: original(b, c, bridge=[sys.executable, '-c', 'import time;time.sleep(30)'])
            with self.assertRaisesRegex(ValueError, 'guard_input_idle'):
                g.dispatch(command)
            self.assertEqual(g.record['stage']['phase'], 'not_started')
            code = "import json,sys;print(json.dumps({'type':'write','operation_id':'fixture','tool':'fixture'}),flush=True);sys.stdin.readline()"
            g.stage = lambda b, c: original(b, c, bridge=[sys.executable, '-c', code])
            with self.assertRaisesRegex(ValueError, 'guard_input_idle'):
                g.dispatch(command)
            self.assertEqual(g.record['stage']['phase'], 'intent')
            with self.assertRaisesRegex(ValueError, 'reconciliation'):
                g.dispatch(command)
        finally:
            source.close(); os.close(write_fd); g.close()


if __name__ == '__main__':
    unittest.main()
