#!/usr/bin/env python3
"""Prepare-only until main's build: isolated launcher PTY/SIGINT probe.

Run from the canonical checkout only AFTER main's later build:
  env -i PATH=/opt/homebrew/bin:/usr/bin:/bin /usr/bin/python3 \
    scripts/probe-claude-launch-tty.py --after-main-build

No Claude, shell startup, auth, network, model, app data or installed runtime is
used. The compiled launcher uses its real process replacement with an actual mock executable.
All child homes/configuration and scripts live in one private temporary root.

Expected observations:
  direct-canonical: one terminal Ctrl+C -> one mock SIGINT, exit 130.
  launcher-canonical: one Ctrl+C -> one mock SIGINT, no redundant forward.
  launcher-raw: one Ctrl+C byte, zero SIGINT/forwards, exit 130.
  launcher-parent-only: one signal to the unchanged PID -> one mock SIGINT, exit 130.

Canonical terminal delivery already targets every foreground process. Report a
redundant-forward defect even if POSIX signal coalescing hides a second callback.
After replacement, the original PID is the mock itself; no forwarding layer remains.
The raw-mode mock is a TUI stand-in; this probe cannot establish vendor behavior.
"""
import argparse
import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import tempfile
import termios
import time

PREFIX = b"AE_TTY_FIXTURE "
CHILD = r"""
import process from 'node:process'
const raw = process.argv.includes('--raw-fixture')
let interrupts = 0
let bytes = 0
const emit = (event, extra = {}) =>
  process.stdout.write('AE_TTY_FIXTURE ' + JSON.stringify({ event, ...extra }) + '\n')
process.on('SIGINT', () => {
  interrupts++
  emit('child_sigint', { count: interrupts })
})
if (raw) process.stdin.setRawMode(true)
let input = ''
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    if (byte === 3) {
      bytes++
      emit('child_ctrl_c_byte', { count: bytes })
    } else if (byte === 10 || byte === 13) {
      if (input === 'finish') {
        emit('child_summary', { interrupts, ctrl_c_bytes: bytes })
        if (raw) process.stdin.setRawMode(false)
        process.exit(130)
      }
      input = ''
    } else input += String.fromCharCode(byte)
  }
})
const position = process.argv.indexOf('--settings')
const overlayExact = position >= 0 && process.argv[position + 1] ===
  '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com"}}'
emit('child_ready', { pid: process.pid, raw, tty: Boolean(process.stdin.isTTY), overlay_exact: overlayExact })
"""
PARENT = r"""
import process from 'node:process'
import { pathToFileURL } from 'node:url'
const [modulePath, root, _mock, mode] = process.argv.slice(2)
const { createClaudeLaunchCommand } = await import(pathToFileURL(modulePath).href)
const command = createClaudeLaunchCommand()
const code = await command(
  ['--', '--remote-control', ...(mode === 'raw' ? ['--raw-fixture'] : [])],
  undefined, root, () => {
    process.stdout.write('AE_TTY_FIXTURE {"event":"launcher_diagnostic"}\n')
  },
)
process.exitCode = code
"""


def require(condition, message):
    # A fixed message only: never render environment, child output or exceptions.
    if not condition:
        raise RuntimeError(message)


def run_case(name, node, compiled, root, mode, parent_only=False, direct=False, public=False, routed=False):
    master = None
    pid = None
    status = None
    events = []
    buffer = bytearray()
    deadline = time.monotonic() + 15

    def consume(timeout=0.1):
        nonlocal status
        progressed = False
        if select.select([master], [], [], timeout)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise RuntimeError("PTY read failed") from None
                chunk = b""
            progressed = bool(chunk)
            buffer.extend(chunk)
            require(len(buffer) < 1_000_000, "fixture output exceeded limit")
            while b"\n" in buffer:
                line, _, tail = buffer.partition(b"\n")
                buffer[:] = tail
                # Terminal echo may precede the marker; only fixed event JSON is used.
                offset = line.find(PREFIX)
                if offset >= 0:
                    try:
                        event = json.loads(line[offset + len(PREFIX):])
                    except (ValueError, UnicodeError):
                        raise RuntimeError("invalid fixture event") from None
                    require(isinstance(event, dict), "invalid fixture event shape")
                    events.append(event)
        if status is None:
            waited, result = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = result
        return progressed

    def wait_for(event):
        while not any(item.get("event") == event for item in events):
            require(status is None, "fixture exited before expected event")
            require(time.monotonic() < deadline, "fixture timed out")
            consume()

    try:
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.chdir(root)
                env = {
                    "HOME": str(root / "home"),
                    "PATH": str(node.parent) + ":/usr/bin:/bin",
                    "TMPDIR": str(root / "tmp"),
                    "CLAUDE_CONFIG_DIR": str(root / "home/.claude"),
                    "CODEX_HOME": str(root / "home/.codex"),
                    "ANYENGINE_ROOT": str(root / "engine"),
                    "LANG": "C",
                    "LC_ALL": "C",
                    "TERM": "xterm-256color",
                    "NO_COLOR": "1",
                }
                argv = [str(node), str(root / "child.mjs")]
                if not direct:
                    argv = [str(node), str(root / "parent.mjs"), str(compiled),
                            str(root / "engine"), str(root / "child.mjs"), mode]
                if public:
                    entry = compiled.parents[2] / "scripts/anyengine-cli.mjs"
                    argv = [str(node), str(entry), "claude"]
                    if routed:
                        argv.append("--routed")
                    argv += ["--", "--remote-control"]
                    if mode == "raw":
                        argv.append("--raw-fixture")
                os.execve(str(node), argv, env)
            except BaseException:
                os._exit(125)
        wait_for("child_ready")
        ready = next(item for item in events if item.get("event") == "child_ready")
        child_pid = ready.get("pid")
        require(isinstance(child_pid, int), "missing mock PID")
        same_group = (os.getpgid(pid) == os.getpgid(child_pid) == os.tcgetpgrp(master))
        require(same_group, "fixture did not share the foreground process group")
        require(ready.get("tty") is True, "mock stdin is not a TTY")
        isig = bool(termios.tcgetattr(master)[3] & termios.ISIG)
        require(isig == (mode != "raw"), "unexpected terminal ISIG mode")
        if parent_only:
            os.kill(pid, signal.SIGINT)
        else:
            os.write(master, b"\x03")
        wait_for("child_ctrl_c_byte" if mode == "raw" else "child_sigint")
        # Observe delayed delivery as well as a signal coalesced by the kernel.
        observe_until = time.monotonic() + 0.3
        while time.monotonic() < observe_until and status is None:
            consume(0.05)
        os.write(master, b"finish\n")
        while status is None:
            require(time.monotonic() < deadline, "fixture did not exit")
            consume()
        # Reaping the parent can precede the last PTY read.
        while consume(0):
            pass
        summaries = [item for item in events if item.get("event") == "child_summary"]
        require(len(summaries) == 1, "missing mock summary")
        child = summaries[0]
        parent = next((item for item in events if item.get("event") == "parent_summary"), {})
        interrupts = child.get("interrupts")
        raw_bytes = child.get("ctrl_c_bytes")
        forwarded = parent.get("forwarded", 0)
        received = parent.get("received", 0)
        code = os.waitstatus_to_exitcode(status)
        expected_interrupts = 0 if mode == "raw" else 1
        expected_forwards = 0
        expected_parent = 0
        redundant = bool(not direct and not parent_only and isig and forwarded > 0)
        passed = (
            code == 130 and interrupts == expected_interrupts
            and raw_bytes == (1 if mode == "raw" else 0)
            and forwarded == expected_forwards and received == expected_parent
            and (direct or (ready.get("overlay_exact") is (not routed) and child_pid == pid))
        )
        return {
            "case": name, "pass": passed, "exit_code": code,
            "same_foreground_group": same_group, "terminal_isig": isig,
            "original_pid_retained": child_pid == pid,
            "mock_sigint_callbacks": interrupts, "mock_ctrl_c_bytes": raw_bytes,
            "parent_sigint_callbacks": received, "forward_calls": forwarded,
            "redundant_terminal_forward": redundant,
        }
    finally:
        # pty.fork created this fixture's own session/process group. Never signal
        # a calling terminal, app, shell or process group discovered elsewhere.
        if pid and pid > 0:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if status is None:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
        if master is not None:
            os.close(master)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--after-main-build", action="store_true")
    parser.add_argument("--node", type=Path, default=Path("/opt/homebrew/bin/node"))
    args = parser.parse_args()
    if not args.after_main_build:
        parser.error("deferred: run only after main's later build with --after-main-build")
    repo = Path(__file__).resolve().parent.parent
    source = repo / "src/control-claude-launch.mts"
    compiled = repo / "dist/src/control-claude-launch.mjs"
    require(compiled.is_file(), "main's compiled launcher is missing")
    require(compiled.stat().st_mtime_ns >= source.stat().st_mtime_ns,
            "compiled launcher predates source; wait for main's build")
    require(args.node.is_absolute() and args.node.is_file(), "absolute Node binary required")
    args.node = args.node.resolve(strict=True)
    # Homebrew entry paths are symlinks; Node reports its resolved execPath.
    args.node = args.node.resolve(strict=True)
    # TemporaryDirectory is outside app data; no raw output log is ever written.
    with tempfile.TemporaryDirectory(prefix="anyengine-launcher-tty-", dir="/private/tmp") as name:
        root = Path(name)
        for directory in ["home", "home/.claude", "home/.codex", "engine", "tmp"]:
            (root / directory).mkdir(mode=0o700)
        (root / "child.mjs").write_text("#!" + str(args.node) + "\n" + CHILD)
        (root / "child.mjs").chmod(0o700)
        (root / "parent.mjs").write_text(PARENT)
        (root / "engine/config.json").write_text(json.dumps({
            "version": 1, "claude": {"cli": str(root / "child.mjs")},
        }))
        results = [
            run_case("direct-canonical", args.node, compiled, root, "canonical", direct=True),
            run_case("launcher-canonical", args.node, compiled, root, "canonical"),
            run_case("launcher-raw", args.node, compiled, root, "raw"),
            run_case("launcher-parent-only", args.node, compiled, root, "canonical", parent_only=True),
            run_case("public-canonical", args.node, compiled, root, "canonical", public=True),
            run_case("public-raw", args.node, compiled, root, "raw", public=True),
            run_case("public-parent-only", args.node, compiled, root, "canonical", parent_only=True, public=True),
            run_case("public-routed", args.node, compiled, root, "canonical", public=True, routed=True),
        ]
        for result in results:
            print(json.dumps(result, sort_keys=True))
        return 0 if all(result["pass"] for result in results) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(json.dumps({"pass": False, "fixture_error": str(error)}))
        raise SystemExit(2)
    except Exception:
        # Do not serialize arbitrary exception payloads, output or environments.
        print(json.dumps({"pass": False, "fixture_error": "fixture setup or cleanup failed"}))
        raise SystemExit(2)
