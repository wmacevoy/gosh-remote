#!/bin/sh
# Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
# Put here by the Gosh - Remote editor extension, which has the editor
# start its terminals with this instead of a shell.
#
# It attaches the terminal to a shpool session, so that the shell in it
# outlives the editor.  Sessions are named after the directory the
# terminal starts in (the workspace): editor-NAME-1, editor-NAME-2, ...
# A new terminal takes the first of them that no terminal is attached
# to, which is how reopening the editor finds the shells it left.
#
# From any other login:   shpool list;  shpool attach editor-NAME-1
#
#   gosh-remote-terminal --attach NAME [--force]
# attaches to that session instead (made if there is none), taking it
# from whatever has it with --force.  The extension's "Attach Terminal to
# Session..." opens terminals this way (gosh-remote #3).  A session given
# a name of its own (renamed) is not taken by a new terminal by itself:
# only this way, or by "shpool attach" from a login.

PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export PATH

plain() { exec "${SHELL:-/bin/sh}" -l; }

if [ "${1:-}" = --attach ]; then
    name=${2:-}
    force=
    [ "${3:-}" = --force ] && force=-f
    case $name in
        ''|-*|*[!A-Za-z0-9._:@+=-]*)
            echo "gosh-remote: '$name' is not a session name." >&2
            exit 2 ;;
    esac
    command -v shpool >/dev/null 2>&1 || { echo "gosh-remote: shpool is not on this host." >&2; exit 1; }
    started=$(date +%s)
    shpool attach $force --dir "$PWD" "$name"
    status=$?
    # Back within seconds: it did not attach.  (shpool says why, but exits 0 for a session another
    # terminal has.)  No ordinary shell instead: this terminal was asked for that session, and why
    # it has not got it should stay on screen.
    if [ $(($(date +%s) - started)) -lt 3 ]; then
        printf 'gosh-remote: shpool did not attach to %s (it said %s). Press Enter to close. ' "$name" "$status" >&2
        read -r _
    fi
    exit $status
fi

command -v shpool >/dev/null 2>&1 || plain

prefix="editor-$(basename "$PWD" | tr -c 'A-Za-z0-9._\n-' '_')"

# Several terminals can start at the same moment (the editor restores
# them together), so a name is claimed before it is used.
# The claims are this user's alone: a directory someone else made (or a link to one) is not used,
# since whoever owns it could claim names first (the review of 2026-11-16).
claims="${XDG_RUNTIME_DIR:-/tmp}/gosh-remote-terminals-$(id -u)"
mkdir -p "$claims" 2>/dev/null
if [ -L "$claims" ] || [ ! -d "$claims" ] || [ ! -O "$claims" ]; then
    echo "gosh-remote: $claims is not this user's own directory; this is an ordinary shell instead." >&2
    plain
fi
chmod 700 "$claims" 2>/dev/null

sessions=$(shpool list 2>/dev/null)
n=1
name="$prefix-$n"
while [ $n -le 64 ]; do
    name="$prefix-$n"
    if printf '%s\n' "$sessions" | awk -v name="$name" '$1 == name && tolower($NF) == "attached" { found = 1 } END { exit !found }'; then
        n=$((n + 1)) # a terminal already has it
    elif mkdir "$claims/$name" 2>/dev/null; then
        break
    elif [ -n "$(find "$claims/$name" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
        rmdir "$claims/$name" 2>/dev/null # a claim left behind: try this name again
    else
        n=$((n + 1)) # another terminal is taking it right now
    fi
done
if [ $n -gt 64 ]; then
    echo "gosh-remote: all 64 of this workspace's terminal sessions are in use; this is an ordinary shell instead." >&2
    plain
fi
# The claim only has to last until shpool shows the session as attached.
( sleep 5; rmdir "$claims/$name" 2>/dev/null ) >/dev/null 2>&1 &

started=$(date +%s)
shpool attach --dir "$PWD" "$name"
status=$?
if [ $status -ne 0 ] && [ $(($(date +%s) - started)) -lt 3 ]; then
    echo "gosh-remote: shpool would not attach (it said $status); this is an ordinary shell instead." >&2
    plain
fi
exit $status
