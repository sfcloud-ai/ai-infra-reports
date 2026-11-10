"""One shared Linux cloud environment: date lock and durable first-write intent.

The caller keeps this stdin session open through research and first staging.
Native tool results are forwarded to the existing staging bridge, never saved.
Changing environments requires reconciling the original installation first.
"""
import datetime as dt
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import select
import stat
import subprocess
import sys
import time
import termios
import uuid
# Match the publisher's canonical report day and 08:00 delivery contract.
SHANGHAI = dt.timezone(dt.timedelta(hours=8), name='Asia/Shanghai')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


class LineInput:
    def __init__(self, stream, idle_seconds=300):
        self.stream, self.idle_seconds, self.buffer = stream, idle_seconds, b''

    def readline(self):
        deadline = time.monotonic() + self.idle_seconds
        try:
            fd = self.stream.fileno()
        except (OSError, ValueError):
            return self.stream.readline(65537)  # In-memory test driver.
        while b'\n' not in self.buffer:
            require(len(self.buffer) <= 65536, 'bounded_guard_input_required')
            remaining = deadline - time.monotonic()
            require(remaining > 0 and select.select([fd], [], [], remaining)[0], 'guard_input_idle')
            chunk = os.read(fd, 8192)
            if not chunk:
                result, self.buffer = self.buffer, b''
                return result.decode('utf-8')
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b'\n', 1)
        require(len(line) < 65536, 'bounded_guard_input_required')
        return line.decode('utf-8') + '\n'


@contextmanager
def quiet_input():
    # Native ticket results contain signed URLs. A PTY must not echo stdin into
    # tool/session output, independently of the caller's shell configuration.
    if not sys.stdin.isatty():
        yield
        return
    fd = sys.stdin.fileno()
    original = termios.tcgetattr(fd)
    quiet = termios.tcgetattr(fd)
    quiet[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON)
    quiet[6][termios.VMIN], quiet[6][termios.VTIME] = 1, 0
    termios.tcsetattr(fd, termios.TCSANOW, quiet)
    try:
        yield
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, original)


def private_dir(path):
    require(path.is_absolute() and path.resolve() == path, 'original_absolute_directory_required')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            'original_private_directory_required')
    return info


def open_private(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
            and info.st_mode & 0o077 == 0):
        os.close(fd)
        raise ValueError('original_private_file_required')
    return fd


def read_json(path):
    with os.fdopen(open_private(path, os.O_RDONLY), 'r') as stream:
        data = stream.read(1_000_001)
    require(len(data.encode()) <= 1_000_000, 'journal_size_limit')
    return json.loads(data)


def save(path, value):
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True) + '\n').encode()
    require(len(data) <= 1_000_000, 'journal_size_limit')
    save_bytes(path, data)


def save_bytes(path, data):
    # The caller holds the original date lock. An interrupted copy stays at an
    # uncommitted temporary path; readers see either the complete old or new file.
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with os.fdopen(open_private(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL), 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def initialize(root, generation, first_date):
    require(str(uuid.UUID(generation)) == generation, 'installation_generation_required')
    require(dt.date.fromisoformat(first_date).isoformat() == first_date, 'activation_date_required')
    root.mkdir(mode=0o700)  # Existing installation is never overwritten.
    info = private_dir(root)
    save(root / 'installation.json', {'schema_version': 1, 'generation': generation,
         'first_date': first_date, 'device': info.st_dev, 'inode': info.st_ino})
    emit({'type': 'guard_installed', 'generation': generation, 'first_date': first_date})


class DayGuard:
    def __init__(self, root, generation, trigger, clock=None, input_reader=None):
        clock = clock or utcnow
        self.root, self.clock = root, clock
        self.input_reader = input_reader
        info = private_dir(root)
        install = read_json(root / 'installation.json')
        require(install['schema_version'] == 1 and install['generation'] == generation
                and (info.st_dev, info.st_ino) == (install['device'], install['inode']),
                'original_cloud_installation_required')
        local = clock().astimezone(SHANGHAI)
        self.day = local.date().isoformat()
        require(self.day >= install['first_date'], 'before_guard_activation')
        require((local.hour, local.minute) >= (7, 20), 'before_daily_start')
        require(isinstance(trigger, str) and 0 < len(trigger) <= 512, 'actual_trigger_reference_required')
        lock_path = root / (self.day + '.lock')
        prior_date_marker = os.path.lexists(lock_path) or os.path.lexists(root / (self.day + '.bundle.json'))
        self.fd = open_private(lock_path, os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.path = root / (self.day + '.json')
            require(os.path.lexists(self.path) or not prior_date_marker, 'original_daily_record_missing_reconcile')
            self.request = 'morning-' + self.day.replace('-', '') + '-r1'
            self.record = read_json(self.path) if os.path.lexists(self.path) else {
                'schema_version': 1, 'generation': generation, 'report_date': self.day,
                'request_id': self.request, 'started_at': clock().isoformat(),
                'original_trigger': trigger, 'research': None, 'stage': None, 'events': []}
            require(self.record['generation'] == generation and self.record['report_date'] == self.day
                    and self.record['request_id'] == self.request, 'original_daily_record_required')
            self.snapshot = None
            self.snapshot_deadline = None
            self.event({'type': 'acquired', 'trigger': trigger})
        except BaseException:
            os.close(self.fd)
            raise

    def event(self, event):
        require(len(json.dumps(event).encode()) <= 16384, 'bounded_private_evidence_required')
        self.record['events'].append({'at': self.clock().isoformat(), **event})
        save(self.path, self.record)

    def snapshot_empty(self):
        require(self.clock().astimezone(SHANGHAI).date().isoformat() == self.day,
                'research_day_has_ended')
        require(self.snapshot and self.snapshot['state'] == 'empty', 'original_day_reconciliation_required')
        require(time.monotonic() <= self.snapshot_deadline,
                'fresh_day_snapshot_required')

    def dispatch(self, command):
        require(isinstance(command, dict), 'guard_command_required')
        action = command.get('action')
        if action == 'heartbeat':
            return {'type': 'guard_alive', 'request_id': self.request}
        if action == 'snapshot':
            value = command['receipt']
            require(value['complete'] is True and value['kind'] == 'day'
                    and value['request_id'] == self.request and value['report_date'] == self.day
                    and value['state'] in ('empty', 'pending', 'occupied')
                    and type(value['observed_at']) is int
                    and str(uuid.UUID(value['query_id'])) == value['query_id']
                    and all(re.fullmatch(r'[a-f0-9]{64}', value[k]) for k in ('publisher_scope_sha256', 'scheduler_scope_sha256'))
                    and re.fullmatch(r'\d{10}\.\d{6}', value['source_ts'])
                    and value['scan_watermark'] >= value['source_ts'], 'complete_original_day_receipt_required')
            if value['state'] == 'empty':
                require(all(value[k] == [] for k in ('publisher_day', 'publisher_intake', 'staged_bundles', 'pending_submissions'))
                        and value['scheduler'] is None and value['scheduler_day_claim'] is None,
                        'empty_day_receipt_conflicts')
            age = self.clock().timestamp() * 1000 - value['observed_at']
            require(-30000 <= age <= 60000, 'fresh_day_snapshot_required')
            self.snapshot = value
            self.snapshot_deadline = time.monotonic() + (60000 - max(0, age)) / 1000
            self.event({'type': 'day_snapshot', 'receipt': value})
            return {'type': 'day_observed', 'state': value['state']}
        if action == 'begin':
            self.snapshot_empty()
            require(self.record['stage'] is None, 'original_stage_requires_reconciliation')
            research = command['research']
            require(re.fullmatch(r'[a-f0-9]{40}', research.get('prompt_commit_sha', ''))
                    and isinstance(research.get('budget'), dict) and research['budget']
                    and isinstance(research.get('audit_directory'), str)
                    and Path(research['audit_directory']).is_absolute(), 'original_research_plan_required')
            if self.record['research'] is not None:
                require(self.record['research'] == research, 'original_research_budget_and_version_required')
            else:
                self.record['research'] = research
                self.event({'type': 'research_started'})
            return {'type': 'research_ready', 'request_id': self.request, 'research': self.record['research']}
        if action == 'record':
            self.event({'type': 'checkpoint', 'evidence': command['evidence']})
            return {'type': 'checkpoint_saved'}
        if action == 'stage':
            self.snapshot_empty()
            prior = self.record['stage']
            require(self.record['research'] is not None and (prior is None or prior['phase'] == 'not_started'),
                    'original_stage_requires_reconciliation')
            require(re.fullmatch(r'C[A-Z0-9]+', command['channel']), 'pinned_private_channel_required')
            filename = Path(command['bundle'])
            require(filename.is_absolute() and filename.is_file() and filename.stat().st_size <= 8 * 1024 * 1024,
                    'bounded_original_bundle_required')
            data = filename.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            payload = json.loads(data)
            require(digest == command['sha256'] and payload['request_id'] == self.request,
                    'original_bundle_binding_required')
            require(payload.get('prompt_commit_sha') == self.record['research']['prompt_commit_sha'],
                    'original_research_version_required')
            require(prior is None or prior['sha256'] == digest, 'original_saved_bundle_differs')
            bundle = self.root / (self.day + '.bundle.json')
            if bundle.exists():
                with os.fdopen(open_private(bundle, os.O_RDONLY), 'rb') as stream:
                    require(stream.read(8 * 1024 * 1024 + 1) == data, 'original_saved_bundle_differs')
            else:
                save_bytes(bundle, data)
            self.record['stage'] = {'bundle': str(bundle), 'sha256': digest, 'phase': 'intent'}
            self.event({'type': 'stage_intent'})  # Durable before spawning any writer.
            self.stage(bundle, command['channel'])
            return {'type': 'stage_requires_publisher_readback', 'stage': self.record['stage']}
        raise ValueError('unknown_guard_action')

    def stage(self, bundle, channel, *, bridge=None):
        cli = Path(__file__).with_name('slack-stage-cli.mjs')
        forwarded = finished = False
        child = None
        native_input = self.input_reader or LineInput(sys.stdin)
        try:
            argv = bridge if bridge is not None else [shutil.which('node') or 'node', str(cli), str(bundle), channel, '--managed-proxy']
            try:
                child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                         close_fds=True, pass_fds=(self.fd,))
            except OSError:
                self.record['stage']['phase'] = 'not_started'
                self.event({'type': 'stage_spawn_not_started'})
                raise
            output = LineInput(child.stdout, native_input.idle_seconds)
            while True:
                line = output.readline()
                if not line:
                    break
                require(len(line.encode()) <= 65536, 'bounded_bridge_output_required')
                value = json.loads(line)
                if value['type'] == 'write':
                    self.event({'type': 'native_write_intent', 'operation_id': value['operation_id'], 'tool': value['tool']})
                    forwarded = True
                    emit(value)
                    reply = native_input.readline()
                    require(reply and len(reply.encode()) <= 65536, 'original_native_result_required')
                    child.stdin.write(reply)
                    child.stdin.flush()
                else:
                    self.event({'type': 'stage_observation', 'value': value})
                    emit(value)
                    finished = value['type'] == 'staging_attempt_finished'
            code = child.wait(timeout=5)
            self.record['stage']['phase'] = 'finished' if code == 0 and finished and forwarded else 'unknown' if forwarded else 'not_started'
            self.event({'type': 'stage_process_exit', 'exit_code': code})
        finally:
            if child is not None and child.poll() is None:
                child.kill()
                child.wait()
            if child is not None:
                if not forwarded and self.record['stage']['phase'] == 'intent':
                    self.record['stage']['phase'] = 'not_started'
                    self.event({'type': 'stage_terminated_before_native_write'})
                child.stdin.close()
                child.stdout.close()

    def close(self):
        os.close(self.fd)


def session(args, idle_seconds=300):
    os.umask(0o077)
    try:
        require(len(args) == 4 and args[0] in ('init', 'run'), 'usage_init_or_run_root_generation_date_or_trigger')
        action, root, generation, extra = args
        if action == 'init':
            initialize(Path(root), generation, extra)
            return 0
        reader = LineInput(sys.stdin, idle_seconds)
        guard = DayGuard(Path(root), generation, extra, input_reader=reader)
        try:
            emit({'type': 'guard_acquired', 'record': guard.record})
            while True:
                line = reader.readline()
                if not line:
                    break
                require(len(line.encode()) <= 65536, 'bounded_guard_input_required')
                command = json.loads(line)
                if command == {'action': 'release'}:
                    emit({'type': 'guard_released'})
                    break
                emit(guard.dispatch(command))
        finally:
            guard.close()
        return 0
    except BlockingIOError:
        emit({'type': 'guard_busy', 'action': 'continue_original_executor'})
        return 75
    except Exception as error:
        emit({'type': 'guard_blocked', 'reason': str(error) if isinstance(error, ValueError) else type(error).__name__,
              'action': 'read_original_record_and_reconcile'})
        return 1


def main(args, idle_seconds=300):
    with quiet_input():
        return session(args, idle_seconds)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
