#!/bin/sh
# Put here by the Remote - Mosh editor extension, which has the editor
# start its terminals with this instead of a shell.
#
# It attaches the terminal to a shpool session, so that the shell in it
# outlives the editor.  Sessions are named after the directory the
# terminal starts in (the workspace): editor-NAME-1, editor-NAME-2, ...
# A new terminal takes the first of them that no terminal is attached
# to, which is how reopening the editor finds the shells it left.
#
# From any other login:   shpool list;  shpool attach editor-NAME-1

PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export PATH

plain() { exec "${SHELL:-/bin/sh}" -l; }
command -v shpool >/dev/null 2>&1 || plain

prefix="editor-$(basename "$PWD" | tr -c 'A-Za-z0-9._\n-' '_')"

# Several terminals can start at the same moment (the editor restores
# them together), so a name is claimed before it is used.
claims="${XDG_RUNTIME_DIR:-/tmp}/remote-mosh-terminals-$(id -u)"
mkdir -p "$claims" 2>/dev/null
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
# The claim only has to last until shpool shows the session as attached.
( sleep 5; rmdir "$claims/$name" 2>/dev/null ) >/dev/null 2>&1 &

started=$(date +%s)
shpool attach --dir "$PWD" "$name"
status=$?
if [ $status -ne 0 ] && [ $(($(date +%s) - started)) -lt 3 ]; then
    echo "remote-mosh: shpool would not attach (it said $status); this is an ordinary shell instead." >&2
    plain
fi
exit $status
