#!/usr/bin/env python3
"""Put dim-controller's hook (dim_controller_hook/) into the venv a dimos blueprint runs from, or take it out.

    install_hook.py                     # every venv a running `dimos run` uses (from dimos's run registry)
    install_hook.py --venv PATH         # that venv (or its python)
    install_hook.py --uninstall [...]   # take it out again
    install_hook.py --status [...]      # say where it is installed

The hook loads when a process starts, so a blueprint that is already running sees it after a restart. Stdlib only:
it runs under any python.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

PACKAGE = Path(__file__).resolve().parent / "dim_controller_hook"
PTH_NAME = "dim_controller_hook.pth"
# one line, run by site.py at startup; harmless when the package has since been removed
PTH_LINE = 'import importlib.util as _u; _u.find_spec("dim_controller_hook") and __import__("dim_controller_hook.boot")\n'
RUNS = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "dimos" / "runs"


def running_pythons() -> list[Path]:
    """The python of every live `dimos run` in dimos's run registry (each worktree's own venv)."""
    pythons: list[Path] = []
    for entry in sorted(RUNS.glob("*.json")):
        try:
            pid = int(json.loads(entry.read_text())["pid"])
            os.kill(pid, 0)
            python = process_python(pid)
        except (OSError, ValueError, KeyError):
            continue
        if python not in pythons:
            pythons.append(python)
    return pythons


def process_python(pid: int) -> Path:
    """The venv python that process `pid` was started with: the interpreter path on its command line, else its
    VIRTUAL_ENV. Exits asking for --venv when neither is in a venv."""
    candidates: list[Path] = []
    if sys.platform.startswith("linux"):
        argv0 = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[0].decode()
        environ = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        # the path as typed, not /proc/<pid>/exe: a venv's bin/python is a symlink to a shared interpreter (uv's,
        # pyenv's, the system's) and Python finds its venv from the unresolved path. A bare name was looked up on
        # PATH, which VIRTUAL_ENV covers.
        if "/" in argv0:
            candidates.append(Path(os.readlink(f"/proc/{pid}/cwd"), argv0))
        venvs = [item.split(b"=", 1)[1].decode() for item in environ if item.startswith(b"VIRTUAL_ENV=")]
        candidates += [Path(venv, "bin", "python") for venv in venvs]
    else:
        answer = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True)
        if answer.stdout.strip():
            candidates.append(Path(answer.stdout.strip()))
    for python in candidates:
        configs = [python.parent / "pyvenv.cfg", python.parent.parent / "pyvenv.cfg"]  # where Python looks for one
        if python.exists() and any(config.is_file() for config in configs):
            return python
    tried = ", ".join(map(str, candidates)) or "nothing"
    raise SystemExit(f"can't tell which venv `dimos run` {pid} uses (no venv python in: {tried}): pass the venv (--venv)")


def python_of(venv: Path) -> Path:
    if venv.is_file():
        return venv
    for candidate in (venv / "bin" / "python", venv / "bin" / "python3"):
        if candidate.exists():
            return candidate
    raise SystemExit(f"no python in {venv}")


def site_packages(python: Path) -> Path:
    answer = subprocess.run(
        [str(python), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        capture_output=True,
        text=True,
        check=True,
    )
    return Path(answer.stdout.strip())


def install(target: Path) -> None:
    destination = target / "dim_controller_hook"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(PACKAGE, destination, ignore=shutil.ignore_patterns("__pycache__"))
    (target / PTH_NAME).write_text(PTH_LINE)


def uninstall(target: Path) -> None:
    shutil.rmtree(target / "dim_controller_hook", ignore_errors=True)
    (target / PTH_NAME).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--venv", type=Path, action="append", help="a venv (or its python); repeatable")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--uninstall", action="store_true")
    action.add_argument("--status", action="store_true")
    args = parser.parse_args()

    pythons = [python_of(venv) for venv in args.venv] if args.venv else running_pythons()
    if not pythons:
        raise SystemExit(f"no running `dimos run` in {RUNS}: pass --venv")
    for python in pythons:
        target = site_packages(python)
        if args.status:
            installed = (target / PTH_NAME).exists() and (target / "dim_controller_hook").exists()
            print(f"{'installed' if installed else 'not installed'}: {target}")
        elif args.uninstall:
            uninstall(target)
            print(f"removed: {target}")
        else:
            install(target)
            print(f"installed: {target} (restart the blueprint to load it)")


if __name__ == "__main__":
    main()
