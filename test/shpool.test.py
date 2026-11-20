#!/usr/bin/env python3
# Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
"""The terminal launcher (lib/terminal.sh) against a real shpool.

    python3 test/shpool.test.py PATH_TO_SHPOOL

Opens terminals as the editor would (the launcher, on a pseudo-terminal,
in a workspace folder) with a throwaway home directory, and checks that
each gets a session of its own and that a new terminal picks up a shell
whose terminal has gone.  Then the pool-terminal commands (gosh-remote #3):
lib/sessions.sh lists the sessions with the terminal holding each, renames
one and detaches one, and the launcher's --attach takes a terminal to a
session by name, refusing one in use unless forced.
"""
import base64, fcntl, json, os, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, time

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
launcher = os.path.join(home, ".local", "bin", "gosh-remote-terminal")
shutil.copy(os.path.join(here, "..", "lib", "terminal.sh"), launcher)
os.chmod(launcher, 0o755)
env = {"HOME": home, "PATH": "/usr/local/bin:/usr/bin:/bin", "XDG_RUNTIME_DIR": os.path.join(scratch, "r"),
       "SHELL": "/bin/sh", "TERM": "xterm"}

failures = []


def check(name, ok, detail=""):
    print("%-66s %s %s" % (name, "ok" if ok else "FAIL", detail), flush=True)
    if not ok:
        failures.append(name)


def terminal(*args):
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.chdir(workspace)
        os.execve(launcher, ["gosh-remote-terminal"] + list(args), env)
    return pid, fd


def pool(action, name="", new=""):
    """lib/sessions.sh as the extension sends it (lib/sessions.js), run here: what it reports."""
    q = lambda v: "'" + v.replace("'", "'\\''") + "'"
    with open(os.path.join(here, "..", "lib", "sessions.sh")) as f:
        script = "ACTION=%s\nNAME=%s\nNEW_NAME=%s\n" % (q(action), q(name), q(new)) + f.read()
    out = subprocess.run(["sh"], input=script, env=env, capture_output=True, text=True, timeout=30).stdout
    return dict(m.groups() for m in re.finditer(r"^GOSHREMOTE ([A-Za-z]+)==(.*)==$", out, re.M))


def holders():
    """Each session's name, and the terminals (launcher pids) attached to it, from lib/sessions.sh's list."""
    got = pool("list")
    listed = json.loads(base64.b64decode(got["sessions"]))
    parents = dict(tuple(map(int, p.split())) for p in got["processes"].split(",") if p.strip())
    return got, {s["name"]: sorted(parents.get(a["pid"]) for a in s["attachments"]) for s in listed["sessions"]}


def gone(pid, wait=5.0):
    end = time.time() + wait
    while time.time() < end:
        if os.waitpid(pid, os.WNOHANG)[0] == pid:
            return True
        time.sleep(0.1)
    return False


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
    return {f[0].strip(): f[-1].strip() for f in (line.split("\t") for line in out.strip().split("\n")[1:] if line)}


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

    # pool terminals (gosh-remote #3)
    got, held = holders()
    check("list: home, the launcher, and rename (gosh-shpool) reported", got.get("home") == home and got.get("launcher") == "yes"
          and got.get("rename") == "yes", str({k: got.get(k) for k in ("home", "launcher", "rename")}))
    check("list: each session's terminal found by its launcher's pid", sorted(held.values()) == sorted([[p2], [p3]]),
          "%s (terminals %d, %d)" % (held, p2, p3))
    # p3 is the terminal that picked up the first one's shell, with its background job
    s3 = next((n for n, t in held.items() if t == [p3]), "?")
    s2 = next((n for n, t in held.items() if t == [p2]), "?")

    got = pool("rename", s3, "kept.one")
    _, held = holders()
    check("rename: the session has its new name, still in its terminal", got.get("result") == "renamed"
          and held == {"kept.one": [p3], s2: [p2]}, "%s %s" % (got, held))
    got = pool("rename", s2, "kept.one")
    check("rename: to a name another session has, refused", "error" in got and "done" not in got, str(got))

    got = pool("detach", "kept.one")
    check("detach: its terminal ends", got.get("result") == "detached" and gone(p3), str(got))
    for _ in range(50):  # the daemon notes the detach a moment after the terminal has gone
        now = sessions()
        if now.get("kept.one") == "disconnected":
            break
        time.sleep(0.1)
    check("detach: the session stays, with no terminal", now.get("kept.one") == "disconnected", str(now))

    p4, f4 = terminal()
    talk(f4, "", 4.0)
    now = sessions()
    check("a new terminal does not take a renamed session by itself", now == {"kept.one": "disconnected",
          "editor-work_space-1": "attached", "editor-work_space-2": "attached"}, str(now))

    p5, f5 = terminal("--attach", "kept.one")
    talk(f5, "", 4.0)
    said = talk(f5, "jobs\n")
    check("--attach NAME: back in that session's shell, background job and all", "sleep 600" in said, repr(said[-200:]))

    p6, f6 = terminal("--attach", "kept.one")
    said = talk(f6, "", 4.0)
    check("--attach NAME, in use elsewhere: refused, and says so", "did not attach to kept.one" in said, repr(said[-300:]))
    talk(f6, "\n", 1.0)
    check("  and closes on Enter", gone(p6))

    p7, f7 = terminal("--attach", "kept.one", "--force")
    talk(f7, "", 4.0)
    said = talk(f7, "jobs\n")
    _, held = holders()
    check("--attach NAME --force: takes it over from the other terminal", "sleep 600" in said and gone(p5)
          and held.get("kept.one") == [p7], "%s %r" % (held, said[-200:]))

    p8, f8 = terminal("--attach", "-x")
    said = talk(f8, "", 2.0)
    check("--attach with a name that is not one: refused", "is not a session name" in said and gone(p8), repr(said[-200:]))
finally:
    subprocess.run([shpool, "kill", "editor-work_space-1", "editor-work_space-2", "kept.one"], env=env, capture_output=True, timeout=30)
    # What is left of this test's own (its shpool daemon, its terminals' shells): by process id, and only
    # processes whose program or home is under this test's scratch directory. Never by a pattern on
    # command lines: other sessions on this machine are not the test's (the owner's rule).
    # The daemon this test started, by the pid file shpool keeps in this test's runtime directory
    # (everywhere; macOS has no /proc for what follows).
    try:
        with open(os.path.join(scratch, "r", "shpool", "daemonized-shpool.pid")) as f:
            os.kill(int(f.read().strip()), 15)
    except (OSError, ValueError):
        pass
    for pid in (p for p in (os.listdir("/proc") if os.path.isdir("/proc") else []) if p.isdigit()):
        try:
            exe = os.readlink("/proc/%s/exe" % pid)
            with open("/proc/%s/environ" % pid, "rb") as f:
                home_of = [v for v in f.read().split(b"\0") if v.startswith(b"HOME=")]
        except OSError:
            continue
        if exe.startswith(scratch + os.sep) or home_of == [("HOME=" + home).encode()]:
            try:
                os.kill(int(pid), 15)
            except OSError:
                pass
    shutil.rmtree(scratch, ignore_errors=True)

sys.exit(1 if failures else 0)
