"""固定主机入口：拉取通过 CI 的公开 main，在隔离环境验证后排空切换。"""

import base64
from contextlib import closing
import datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import uuid

REPOSITORY = "sfcloud-ai/ai-infra-reports"
SERVICE = "ai-report-publisher.service"
CONFIG = Path("/etc/ai-report-publisher-cd.json")
SHA = re.compile(r"[0-9a-f]{40}")
TABLES = {"scope", "jobs", "ready_migrations", "notice_scope", "notices", "notice_commands"}


class Deferred(Exception):
    """只读条件尚未满足，本轮不切换服务。"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic(path, data, mode=0o600):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(path, value):
    atomic(path, (json.dumps(value, sort_keys=True) + "\n").encode())


def admin_path(path, directory=False):
    info = path.lstat()
    predicate = stat.S_ISDIR if directory else stat.S_ISREG
    if (path.resolve() != path or not predicate(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) & 0o022 or (not directory and info.st_nlink != 1)):
        raise ValueError("unsafe_admin_path")
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError("unsafe_admin_parent")


def load_config():
    admin_path(CONFIG)
    config = json.loads(CONFIG.read_text())
    fields = {"base", "control", "state", "publisher_config", "unit", "node", "git", "image", "uid", "gid", "validation_uid"}
    if set(config) != fields:
        raise ValueError("unexpected_cd_config")
    if (any(type(config[k]) is not int or config[k] <= 0 for k in ("uid", "gid", "validation_uid"))
            or config["validation_uid"] == config["uid"]
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", config["image"])):
        raise ValueError("invalid_cd_identity")
    for key in ("base", "control", "state", "publisher_config", "unit", "node", "git"):
        path = Path(config[key])
        if not path.is_absolute() or path.resolve() != path or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(path)):
            raise ValueError("invalid_cd_path")
    for key in ("base", "control", "node", "git"):
        admin_path(Path(config[key]), directory=True)
    admin_path(Path(config["base"]) / "releases", directory=True)
    if stat.S_IMODE(Path(config["control"]).stat().st_mode) != 0o700:
        raise ValueError("private_cd_control_required")
    admin_path(Path(config["unit"]))
    for key, mode in (("state", 0o700), ("publisher_config", 0o600)):
        info = Path(config[key]).lstat()
        if info.st_uid != config["uid"] or info.st_gid != config["gid"] or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError("publisher_private_layout_changed")
    publisher = json.loads(Path(config["publisher_config"]).read_text())
    if publisher["state_dir"] != config["state"]:
        raise ValueError("publisher_state_binding_changed")
    return config


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        raise ValueError("unexpected_source_redirect")


def fetch(url, limit):
    if urllib.parse.urlsplit(url).hostname not in ("api.github.com", "codeload.github.com"):
        raise ValueError("unexpected_source_host")
    request = urllib.request.Request(url, headers={"User-Agent": "ai-infra-publisher-cd",
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("source_response_too_large")
    return raw


def github(path):
    return json.loads(fetch("https://api.github.com/repos/" + REPOSITORY + path, 2 * 1024 * 1024))


def select_candidate(current, api=github):
    if not SHA.fullmatch(current):
        raise ValueError("invalid_active_commit")
    target = api("/git/ref/heads/main")["object"]
    if target.get("type") != "commit" or not SHA.fullmatch(target.get("sha", "")):
        raise ValueError("invalid_main_ref")
    commit = target["sha"]
    if commit == current:
        return None
    comparison = api("/compare/" + current + "..." + commit + "?per_page=1")
    if (comparison.get("status") != "ahead" or comparison.get("base_commit", {}).get("sha") != current
            or comparison.get("merge_base_commit", {}).get("sha") != current):
        raise ValueError("main_is_not_forward_only")
    query = "/actions/workflows/validate.yml/runs?branch=main&event=push&head_sha=" + commit + "&per_page=20"
    runs = api(query).get("workflow_runs", [])
    matching = [run for run in runs if run.get("head_sha") == commit and run.get("head_branch") == "main"
                and run.get("event") == "push" and run.get("path") == ".github/workflows/validate.yml"
                and run.get("repository", {}).get("full_name") == REPOSITORY]
    if not matching:
        raise Deferred("main_ci_not_found")
    latest = max(matching, key=lambda run: (run["id"], run.get("run_attempt", 1)))
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        raise Deferred("main_ci_not_successful")
    return {"commit": commit, "run_id": latest["id"], "run_attempt": latest.get("run_attempt", 1)}


def archive_files(raw, commit):
    if not SHA.fullmatch(commit) or len(raw) > 32 * 1024 * 1024:
        raise ValueError("source_archive_identity")
    prefix, files, total, names = "ai-infra-reports-" + commit, {}, 0, set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for item in archive:
            name = PurePosixPath(item.name)
            if (len(names) >= 10000 or str(name) in names or name.is_absolute() or ".." in name.parts
                    or not name.parts or name.parts[0] != prefix or not (item.isdir() or item.isfile())):
                raise ValueError("unsafe_source_archive")
            names.add(str(name))
            relative = PurePosixPath(*name.parts[1:])
            if relative.parts and relative.parts[0] in (".git", "node_modules", ".publisher-cd-release.json"):
                raise ValueError("unexpected_source_directory")
            if item.isdir():
                continue
            total += item.size
            if not relative.parts or item.size < 0 or total > 150 * 1024 * 1024:
                raise ValueError("expanded_source_limit")
            with archive.extractfile(item) as stream:
                data = stream.read(item.size + 1)
            if len(data) != item.size:
                raise ValueError("incomplete_archive_file")
            files[str(relative)] = (data, bool(item.mode & 0o111))
    if not {"package.json", "package-lock.json", "scripts/publisher-service.mjs"} <= set(files):
        raise ValueError("publisher_release_entry_missing")
    return files


def snapshot(path, settled=True):
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as database:
        database.execute("PRAGMA query_only=ON")
        database.execute("BEGIN")
        if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("ledger_integrity")
        if database.execute("SELECT count(*) FROM sqlite_master WHERE type IN ('view','trigger')").fetchone()[0]:
            raise ValueError("unsupported_ledger_object")
        tables = database.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        if not {"scope", "jobs"} <= {row[0] for row in tables} <= TABLES:
            raise ValueError("unsupported_ledger_schema")
        result = []
        for name, sql in tables:
            columns = database.execute("PRAGMA table_info(" + name + ")").fetchall()
            if any(not re.fullmatch(r"[a-z_][a-z0-9_]*", col[1]) for col in columns):
                raise ValueError("unsupported_ledger_column")
            keys = [col[1] for col in sorted(columns, key=lambda col: col[5]) if col[5]]
            rows = database.execute("SELECT * FROM " + name + " ORDER BY " + (",".join(keys) if keys else "rowid"))
            result.append([name, sql, [[{"base64": base64.b64encode(value).decode()} if isinstance(value, bytes) else value
                                      for value in row] for row in rows]])
        if settled:
            for name, phase in (("jobs", "receipt_sent"), ("notices", "sender_reported"), ("notice_commands", "response_sent")):
                if name in {row[0] for row in tables} and database.execute("SELECT count(*) FROM " + name + " WHERE phase!=?", (phase,)).fetchone()[0]:
                    raise Deferred("in_flight_or_unknown_operation")
        return hashlib.sha256(json.dumps(result, separators=(",", ":")).encode()).hexdigest()


def run(arguments, timeout=30, cwd=None):
    result = subprocess.run(arguments, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=timeout, env={"PATH": "/usr/bin:/bin", "HOME": "/root"})
    if result.returncode:
        raise ValueError("bounded_command_failed")
    return result.stdout.decode().strip()


def container(config, work, arguments, network="none", uid=None, extra=(), readonly=False):
    name = "report-cd-" + uuid.uuid4().hex
    user = str(config["validation_uid"] if uid is None else uid)
    group = str(config["gid"]) if uid == config["uid"] else user
    command = ["/usr/bin/docker", "run", "--rm", "--pull", "never", "--name", name,
        "--network", network, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", user + ":" + group, "--pids-limit", "128", "--memory", "1g", "--cpus", "1",
        "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m,uid=" + user + ",gid=" + group,
        "--mount", "type=bind,src=" + str(work) + ",dst=/work" + (",readonly" if readonly else ""), "--workdir", "/work",
        "--mount", "type=bind,src=" + config["node"] + ",dst=/node,readonly",
        "--mount", "type=bind,src=" + config["git"] + ",dst=/git,readonly"]
    command += list(extra) + ["--entrypoint", "/usr/bin/env", config["image"], "-i",
        "PATH=/node/bin:/git/bin:/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp",
        "REPORT_GIT_BIN=/git/bin/git", "GIT_EXEC_PATH=/git/libexec/git-core", "NODE_ENV=test"] + arguments
    try:
        return run(command, timeout=900)
    finally:
        subprocess.run(["/usr/bin/docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30, check=False)


def properties():
    values = run(["/bin/systemctl", "show", SERVICE, "--property=MainPID,ActiveState,SubState,WorkingDirectory,User,Group,NoNewPrivileges,ProtectSystem,ProtectHome,ReadWritePaths,Restart"])
    return dict(line.split("=", 1) for line in values.splitlines())


def health(config, commit, after=None, pid=None):
    value = json.loads((Path(config["state"]) / "health.json").read_text())
    checked = datetime.datetime.fromisoformat(value["checked_at"].replace("Z", "+00:00"))
    age = (datetime.datetime.now(datetime.timezone.utc) - checked).total_seconds()
    return (value.get("healthy") is True and value.get("commit") == commit and 0 <= age < 180
            and value.get("successful_checks", 0) >= 2 and (after is None or checked >= after)
            and (pid is None or "pid" not in value or str(value["pid"]) == str(pid)))


def resumable_original(path):
    """仅允许原代码继续已知阶段；未知外部写入仍需核对，不重放。"""
    allowed = {"jobs": {"received", "pr_open", "merged", "verified", "receipt_sent"},
               "notices": {"reserved", "sender_reported"},
               "notice_commands": {"received", "response_ready", "response_sent"}}
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as database:
        tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for name, phases in allowed.items():
            if name in tables and not {row[0] for row in database.execute("SELECT DISTINCT phase FROM " + name)} <= phases:
                raise Deferred("unknown_write_prevents_original_resume")


def dependency_tree(work):
    """先验证依赖根本身，再遍历；容器写入的链接不能引导 root 读取主机目录。"""
    modules = work / "node_modules"
    if modules.is_symlink() or not stat.S_ISDIR(modules.lstat().st_mode) or modules.resolve() != modules:
        raise ValueError("unsafe_dependency_root")
    modules.resolve().relative_to(work.resolve())
    for base, directories, names in os.walk(modules, followlinks=False):
        for name in directories + names:
            path = Path(base) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                if Path(os.readlink(path)).is_absolute():
                    raise ValueError("absolute_dependency_link")
                try:
                    path.resolve().relative_to(work.resolve())
                except ValueError as error:
                    raise ValueError("dependency_link_escapes_release") from error
            elif not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError("unsafe_dependency_type")
    return modules


def unit_for(unit, release, node, config):
    lines, counts = [], {"WorkingDirectory": 0, "ExecStart": 0}
    for line in unit.splitlines():
        key = line.partition("=")[0]
        if key in counts:
            counts[key] += 1
            line = ("WorkingDirectory=" + str(release) if key == "WorkingDirectory" else
                    "ExecStart=" + str(node / "bin/node") + " scripts/publisher-service.mjs " + str(config) + " --live")
        lines.append(line)
    if counts != {"WorkingDirectory": 1, "ExecStart": 1}:
        raise ValueError("ambiguous_service_unit")
    return "\n".join(lines) + "\n"


def require_same_filesystem(operation, release_parent):
    if operation.stat().st_dev != release_parent.stat().st_dev:
        raise Deferred("cross_filesystem_staging_not_supported")
    # 同一设备的两个 bind mount 仍可能拒绝 rename；在停服务前验证实际路径。
    name = ".publisher-cd-rename-" + uuid.uuid4().hex
    source, target = operation / name, release_parent / name
    source.mkdir(mode=0o700)
    identity = source.stat()
    try:
        if target.exists() or target.is_symlink():
            raise ValueError("unexpected_promotion_probe_target")
        try:
            os.rename(source, target)
            os.rename(target, source)
        except OSError as error:
            raise Deferred("stage_promotion_not_available") from error
    finally:
        for path in (source, target):
            if path.exists() or path.is_symlink():
                current = path.lstat()
                if (not stat.S_ISDIR(current.st_mode) or path.resolve() != path
                        or (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino)):
                    raise ValueError("promotion_probe_identity_changed")
                path.rmdir()


def stage(config, candidate, operation):
    commit = candidate["commit"]
    require_same_filesystem(operation, Path(config["base"]) / "releases")
    if shutil.disk_usage(operation).free < 2 * 1024 ** 3:
        raise Deferred("insufficient_release_capacity")
    files = archive_files(fetch("https://codeload.github.com/" + REPOSITORY + "/tar.gz/" + commit, 32 * 1024 * 1024), commit)
    work = operation / "work"
    work.mkdir(mode=0o755)
    for name, (data, executable) in files.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755 if executable else 0o644)
    for base, directories, names in os.walk(work):
        os.chown(base, config["validation_uid"], config["validation_uid"])
        for name in names:
            os.chown(Path(base) / name, config["validation_uid"], config["validation_uid"])
    npm = ["/node/bin/node", "/node/lib/node_modules/npm/bin/npm-cli.js"]
    container(config, work, npm + ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], network="bridge")
    log = container(config, work, npm + ["run", "check"])
    atomic(operation / "validation.log", log.encode())
    for name, (data, _) in files.items():
        path = work / name
        if path.is_symlink() or path.read_bytes() != data:
            raise ValueError("validated_source_changed")
    modules = dependency_tree(work)
    # 每次预检均暂存于本轮私有目录；CI 暂时不可用不会占住正式 SHA 路径。
    release = operation / "release"
    release.mkdir(mode=0o755)
    for name, (data, executable) in files.items():
        path = release / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o555 if executable else 0o444)
    shutil.copytree(modules, release / "node_modules", symlinks=True)
    atomic(release / ".publisher-cd-release.json", (json.dumps({"commit": commit}) + "\n").encode(), mode=0o444)
    for base, directories, names in os.walk(release, followlinks=False):
        os.chmod(base, 0o555)
        for name in names:
            path = Path(base) / name
            if not path.is_symlink():
                os.chmod(path, 0o555 if path.stat().st_mode & 0o111 else 0o444)
    proof = {**candidate, "source_files": {name: hashlib.sha256(data).hexdigest() for name, (data, _) in files.items()},
             "config_sha256": digest(Path(config["publisher_config"])), "unit_sha256": digest(Path(config["unit"])),
             "validation": "npm run check", "validation_network": "none", "production_credentials_mounted": False}
    save(operation / "staged.json", proof)
    if work.resolve() != work or work.parent != operation:
        raise ValueError("unexpected_staging_cleanup_path")
    shutil.rmtree(work)
    return proof


def dependency_mount_paths(base, link, target):
    """历史依赖只允许保留 release 内的 node_modules 目录，不扩大挂载范围。"""
    prefix = base / "releases"
    for path in (link, target):
        if not path.is_absolute():
            raise ValueError("relative_legacy_dependency_link")
        try:
            parts = path.relative_to(prefix).parts
        except ValueError as error:
            raise ValueError("legacy_dependency_outside_releases") from error
        if len(parts) != 2 or not SHA.fullmatch(parts[0]) or parts[1] != "node_modules":
            raise ValueError("legacy_dependency_not_a_release_directory")
    return ["--mount", "type=bind,src=" + str(target) + ",dst=" + str(link) + ",readonly"]


def legacy_dependency_mount(config, release):
    modules = release / "node_modules"
    if not modules.is_symlink():
        return []
    if modules.lstat().st_uid != 0:
        raise ValueError("legacy_dependency_link_not_admin_owned")
    link, target = Path(os.readlink(modules)), modules.resolve()
    result = dependency_mount_paths(Path(config["base"]), link, target)
    admin_path(release, directory=True)
    admin_path(target, directory=True)
    return result


def compatibility(config, release, operation, expected):
    """仅打开隔离的账本副本，不提供生产凭据或网络。"""
    probe = operation / ("probe-" + uuid.uuid4().hex)
    probe.mkdir(mode=0o700)
    database = probe / "handoff.sqlite"
    with closing(sqlite3.connect((Path(config["state"]) / "handoff.sqlite").as_uri() + "?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(database)) as target:
            source.backup(target)
            # 副本先关闭 WAL；避免只读指纹检查留下 root 拥有的 WAL/SHM。
            if target.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                raise ValueError("isolated_copy_journal_not_reset")
    if snapshot(database) != expected:
        raise ValueError("state_changed_during_backup")
    copied = json.loads(Path(config["publisher_config"]).read_text())
    copied["state_dir"] = "/probe"
    (probe / "publisher.json").write_text(json.dumps(copied))
    for path in (probe, database, probe / "publisher.json"):
        os.chown(path, config["uid"], config["gid"])
        path.chmod(0o700 if path.is_dir() else 0o600)
    script = "import{readFileSync}from'node:fs';import{HandoffState,handoffScope}from'./scripts/handoff-state.mjs';import{NoticeOutbox,notificationScope}from'./scripts/notice-outbox.mjs';import{validateConfig}from'./scripts/run-handoff.mjs';const c=validateConfig(JSON.parse(readFileSync('/probe/publisher.json')));const s=new HandoffState('/probe/handoff.sqlite',handoffScope(c));try{if(c.notification_destination)new NoticeOutbox(s,notificationScope(c));}finally{s.close();}"
    container(config, release, ["/node/bin/node", "--input-type=module", "-e", script], uid=config["uid"], readonly=True,
              extra=["--mount", "type=bind,src=" + str(probe) + ",dst=/probe"] + legacy_dependency_mount(config, release))
    if snapshot(database) != expected:
        raise ValueError("automatic_state_migration_not_supported")


def _tick(config):
    control = Path(config["control"])
    active = json.loads((control / "active.json").read_text())
    if set(active) != {"commit"} or not SHA.fullmatch(active["commit"]):
        raise ValueError("invalid_cd_active_record")
    pending = control / "pending.json"
    if pending.exists():
        raise ValueError("cd_operation_requires_read_only_reconciliation")
    current = active["commit"]
    if not health(config, current):
        raise Deferred("current_service_not_healthy")
    snapshot(Path(config["state"]) / "handoff.sqlite")
    candidate = select_candidate(current)
    if candidate is None:
        return {"status": "current", "commit": current}
    blocked = control / "blocked.json"
    if blocked.exists() and json.loads(blocked.read_text()).get("commit") == candidate["commit"]:
        raise Deferred("candidate_previously_failed_inspect_record")
    operation = control / (candidate["commit"] + "-" + uuid.uuid4().hex)
    operation.mkdir(mode=0o700)
    proof = stage(config, candidate, operation)
    commit = candidate["commit"]
    release = Path(config["base"]) / "releases" / commit
    unit = Path(config["unit"])
    if select_candidate(current) != candidate or digest(unit) != proof["unit_sha256"] or digest(Path(config["publisher_config"])) != proof["config_sha256"]:
        raise Deferred("deployment_inputs_changed")
    snapshot(Path(config["state"]) / "handoff.sqlite")
    require_same_filesystem(operation, release.parent)
    if release.exists() or release.is_symlink():
        raise ValueError("candidate_directory_already_exists")
    old = properties()
    import pwd, grp
    if (pwd.getpwnam(old["User"]).pw_uid != config["uid"]
            or grp.getgrnam(old["Group"]).gr_gid != config["gid"]):
        raise ValueError("publisher_service_account_changed")
    if (old["WorkingDirectory"] != str(Path(config["base"]) / "releases" / current)
            or old["ActiveState"] != "active" or old["Restart"] != "no"
            or old["ReadWritePaths"] != config["state"] or old["NoNewPrivileges"] != "yes"
            or old["ProtectSystem"] != "strict" or old["ProtectHome"] != "yes"):
        raise ValueError("publisher_unit_binding_changed")
    before = unit.read_bytes()
    atomic(operation / "before.service", before)
    target = unit_for(before.decode(), release, Path(config["node"]), Path(config["publisher_config"]))
    record = {"phase": "drain_intent", "before": current, "target": commit, "operation": str(operation),
              "pid": old["MainPID"], "config_sha256": proof["config_sha256"], "before_unit_sha256": proof["unit_sha256"],
              "target_unit_sha256": hashlib.sha256(target.encode()).hexdigest()}
    save(pending, record)
    run(["/bin/systemctl", "kill", "--kill-who=main", "--signal=SIGTERM", SERVICE])
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        status = properties()
        if status["MainPID"] == "0" and status["ActiveState"] == "inactive":
            break
        time.sleep(1)
    else:
        raise ValueError("publisher_drain_unconfirmed")
    expected = snapshot(Path(config["state"]) / "handoff.sqlite")
    record.update(phase="drained", state_sha256=expected)
    save(pending, record)
    compatibility(config, operation / "release", operation, expected)
    compatibility(config, Path(old["WorkingDirectory"]), operation, expected)
    if select_candidate(current) != candidate or digest(unit) != proof["unit_sha256"] or digest(Path(config["publisher_config"])) != proof["config_sha256"]:
        raise ValueError("drained_deployment_inputs_changed")
    record["phase"] = "activation_intent"
    save(pending, record)
    os.replace(operation / "release", release)
    atomic(unit, target.encode(), mode=0o644)
    run(["/usr/bin/systemd-analyze", "verify", str(unit)])
    run(["/bin/systemctl", "daemon-reload"])
    record["phase"] = "start_intent"
    save(pending, record)
    started_after = datetime.datetime.now(datetime.timezone.utc)
    run(["/bin/systemctl", "start", SERVICE])
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        status = properties()
        if (status["ActiveState"] == "active" and status["MainPID"] != "0"
                and status["WorkingDirectory"] == str(release)
                and health(config, commit, after=started_after, pid=status["MainPID"])):
            save(control / "active.json", {"commit": commit})
            record["phase"] = "healthy"
            save(operation / "completed.json", record)
            pending.unlink()
            return {"status": "updated", "commit": commit, "previous": current}
        if status["ActiveState"] in ("failed", "inactive"):
            break
        time.sleep(2)
    raise ValueError("publisher_health_requires_reconciliation")


def recover_known_attempt(config):
    """本轮失败后先核对真实进程与落盘结果，再恢复兼容旧代码；不恢复数据库。"""
    control = Path(config["control"])
    pending = control / "pending.json"
    record = json.loads(pending.read_text())
    operation = Path(record["operation"])
    if operation.parent != control or operation.resolve() != operation:
        raise ValueError("unexpected_cd_operation_path")
    unit = Path(config["unit"])
    if (digest(unit) not in (record["before_unit_sha256"], record["target_unit_sha256"])
            or digest(Path(config["publisher_config"])) != record["config_sha256"]
            or digest(operation / "before.service") != record["before_unit_sha256"]):
        raise ValueError("cd_recovery_inputs_changed")
    status = properties()
    if status["ActiveState"] == "active":
        expected_directory = str(Path(config["base"]) / "releases" / record["target"])
        if status["WorkingDirectory"] != expected_directory or digest(unit) != record["target_unit_sha256"]:
            raise ValueError("original_drain_outcome_unconfirmed")
        record.update(phase="rollback_drain_intent", rollback_pid=status["MainPID"])
        save(pending, record)
        run(["/bin/systemctl", "kill", "--kill-who=main", "--signal=SIGTERM", SERVICE])
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            status = properties()
            if status["MainPID"] == "0" and status["ActiveState"] in ("inactive", "failed"):
                break
            time.sleep(1)
    if status["MainPID"] != "0" or status["ActiveState"] not in ("inactive", "failed"):
        raise ValueError("rollback_drain_unconfirmed")
    if record["phase"] == "drain_intent" and digest(unit) == record["before_unit_sha256"]:
        database = Path(config["state"]) / "handoff.sqlite"
        snapshot(database, settled=False)
        resumable_original(database)
        record["phase"] = "original_resume_intent"
        save(pending, record)
        started_after = datetime.datetime.now(datetime.timezone.utc)
        run(["/bin/systemctl", "start", SERVICE])
        deadline = time.monotonic() + 300
        before = Path(config["base"]) / "releases" / record["before"]
        while time.monotonic() < deadline:
            status = properties()
            if (status["ActiveState"] == "active" and status["MainPID"] != "0"
                    and status["WorkingDirectory"] == str(before)
                    and health(config, record["before"], after=started_after, pid=status["MainPID"])):
                record["phase"] = "deferred_original_resumed"
                save(operation / "completed.json", record)
                pending.unlink()
                return {"status": "deferred", "reason": "work_arrived_during_drain", "commit": record["before"]}
            if status["ActiveState"] in ("failed", "inactive"):
                break
            time.sleep(2)
        raise ValueError("original_resume_health_requires_reconciliation")
    current_state = snapshot(Path(config["state"]) / "handoff.sqlite")
    before = Path(config["base"]) / "releases" / record["before"]
    compatibility(config, before, operation, current_state)
    record.update(phase="rollback_intent", rollback_state_sha256=current_state)
    save(pending, record)
    atomic(unit, (operation / "before.service").read_bytes(), mode=0o644)
    run(["/bin/systemctl", "daemon-reload"])
    started_after = datetime.datetime.now(datetime.timezone.utc)
    run(["/bin/systemctl", "start", SERVICE])
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        status = properties()
        if (status["ActiveState"] == "active" and status["MainPID"] != "0"
                and status["WorkingDirectory"] == str(before)
                and health(config, record["before"], after=started_after, pid=status["MainPID"])):
            record["phase"] = "rolled_back"
            save(control / "active.json", {"commit": record["before"]})
            save(control / "blocked.json", {"commit": record["target"], "operation": str(operation)})
            save(operation / "completed.json", record)
            pending.unlink()
            return {"status": "rolled_back", "commit": record["before"], "failed_candidate": record["target"], "state_restored": False}
        if status["ActiveState"] in ("failed", "inactive"):
            break
        time.sleep(2)
    raise ValueError("rollback_health_requires_reconciliation")


def tick(config):
    pending = Path(config["control"]) / "pending.json"
    # 上轮中断只允许只读核对，不盲目再次发送停止、启动或切换指令。
    if pending.exists():
        raise ValueError("cd_operation_requires_read_only_reconciliation")
    try:
        return _tick(config)
    except Exception:
        if pending.exists():
            return recover_known_attempt(config)
        raise


def main():
    import fcntl
    if sys.platform != "linux" or os.getuid() != 0 or sys.argv[1:] != ["tick"]:
        raise ValueError("fixed_linux_cd_entry_required")
    config = load_config()
    lock = os.open(Path(config["control"]) / "deployment.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            print(json.dumps(tick(config)))
        except Deferred as error:
            print(json.dumps({"status": "deferred", "reason": str(error)}))
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"status":"blocked","reason":"inspect_durable_cd_operation_before_retry"}', file=sys.stderr)
        raise SystemExit(1)
