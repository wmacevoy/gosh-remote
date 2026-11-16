#!/usr/bin/env python3
# Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
"""The terminal launcher (lib/terminal.sh) against a real shpool.

    python3 test/shpool.test.py PATH_TO_SHPOOL

Opens terminals as the editor would (the launcher, on a pseudo-terminal,
in a workspace folder) with a throwaway home directory, and checks that
each gets a session of its own and that a new terminal picks up a shell
whose terminal has gone.
"""
import fcntl, os, pty, select, shutil, struct, subprocess, sys, tempfile, termios, time

shpool = os.path.abspath(sys.argv[1])
here = os.path.dirname(os.path.abspath(__file__))

# short, because a Unix socket's path has to be
scratch = tempfile.mkdtemp(prefix="rm-", dir="/tmp")
home = os.path.join(scratch, "h")
workspace = os.path.join(home, "work space")
os.makedirs(os.path.join(home, ".local", "bin"))
os.makedirs(workspace)
os.makedirs(os.path.join(scratch, "r"))
shutil.copy(shpool, os.path.join(home, ".local", "bin", "shpool"))
launcher = os.path.join(home, ".local", "bin", "remote-gosh-terminal")
shutil.copy(os.path.join(here, "..", "lib", "terminal.sh"), launcher)
os.chmod(launcher, 0o755)
env = {"HOME": home, "PATH": "/usr/local/bin:/usr/bin:/bin", "XDG_RUNTIME_DIR": os.path.join(scratch, "r"),
       "SHELL": "/bin/sh", "TERM": "xterm"}

failures = []


def check(name, ok, detail=""):
    print("%-66s %s %s" % (name, "ok" if ok else "FAIL", detail), flush=True)
    if not ok:
        failures.append(name)


def terminal():
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.chdir(workspace)
        os.execve(launcher, ["remote-gosh-terminal"], env)
    return pid, fd


def talk(fd, text, wait=1.5):
    if text:
        os.write(fd, text.encode())
    out = b""
    end = time.time() + wait
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
    return out.decode("latin-1")


def sessions():
    out = subprocess.run([shpool, "list"], env=env, capture_output=True, text=True, timeout=30).stdout
    return dict(line.split("\t")[0::max(1, len(line.split("\t")) - 1)] for line in out.strip().split("\n")[1:] if line)


try:
    # two at the same moment, as when the editor restores them, with no daemon running yet
    p1, f1 = terminal()
    p2, f2 = terminal()
    talk(f1, "", 5.0)
    talk(f2, "", 1.0)
    said = talk(f1, "echo MARK-$((40+2)); pwd\n")
    check("a terminal is a working shell, in the workspace folder", "MARK-42" in said and "work space" in said, repr(said[-200:]) if "MARK-42" not in said else "")
    now = sessions()
    check("two terminals opened together get a session each", now == {"editor-work_space-1": "attached", "editor-work_space-2": "attached"}, str(now))

    # one terminal's editor goes away without a word, with something running in it
    talk(f1, "sleep 600 &\n")
    os.close(f1)
    os.kill(p1, 9)
    time.sleep(6)
    now = sessions()
    check("its shell is kept, with no terminal", sorted(now.values()) == ["attached", "disconnected"], str(now))

    p3, f3 = terminal()
    talk(f3, "", 4.0)
    said = talk(f3, "jobs\n")
    check("a new terminal picks that shell up, background job and all", "sleep 600" in said, repr(said[-200:]) if "sleep 600" not in said else "")
    now = sessions()
    check("and no extra session was made", now == {"editor-work_space-1": "attached", "editor-work_space-2": "attached"}, str(now))
finally:
    subprocess.run([shpool, "kill", "editor-work_space-1", "editor-work_space-2"], env=env, capture_output=True, timeout=30)
    subprocess.run(["pkill", "-f", os.path.join(scratch, "r")], capture_output=True)
    shutil.rmtree(scratch, ignore_errors=True)

sys.exit(1 if failures else 0)
