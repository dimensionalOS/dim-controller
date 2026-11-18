"""install_hook.py finds the venv a running blueprint uses. Stdlib + pytest only; Linux (reads /proc).

Run with any python:  python3 -m pytest server/python/tests/test_install_hook.py -q -p no:cacheprovider
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import venv

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_hook  # noqa: E402


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc")
def test_finds_the_venv_python_not_the_shared_interpreter_it_links_to(tmp_path):
    venv.create(tmp_path / "venv", symlinks=True)
    venv_python = tmp_path / "venv" / "bin" / "python"
    shared_python = venv_python.resolve()
    env = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
    sleep = ["-c", "import time; time.sleep(60)"]
    in_venv = subprocess.Popen([str(venv_python), *sleep], env=env)
    outside = subprocess.Popen([str(shared_python), *sleep], env=env)
    try:
        assert Path(os.readlink(f"/proc/{in_venv.pid}/exe")) != venv_python  # the kernel reports the shared one
        assert install_hook.process_python(in_venv.pid) == venv_python
        with pytest.raises(SystemExit, match="--venv"):
            install_hook.process_python(outside.pid)
    finally:
        in_venv.kill()
        outside.kill()
