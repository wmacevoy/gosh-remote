# Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
# Run on the host, over ssh, by the Gosh - Remote extension for its commands on pool terminals
# (gosh-remote #3): attach a terminal to any shpool session, rename one, detach one.
# lib/sessions.js puts these before it, shell-quoted:
#   ACTION     list, rename or detach
#   NAME       the session, for rename and detach
#   NEW_NAME   its new name, for rename
# It answers in lines "GOSHREMOTE key==value==", as lib/remote.sh does.

PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export PATH

say() { printf 'GOSHREMOTE %s==%s==\n' "$1" "$2"; }
oneline() { tr '\n' ' ' | sed 's/ *$//'; }
b64() { if base64 </dev/null >/dev/null 2>&1; then base64 | tr -d '\n'; else openssl base64 -A; fi; }

if ! command -v shpool >/dev/null 2>&1; then
    say error "shpool is not on the host"
    exit 0
fi

case ${ACTION:-} in
    list)
        say home "$HOME"
        if [ -x "$HOME/.local/bin/gosh-remote-terminal" ]; then say launcher yes; else say launcher no; fi
        # gosh-shpool has rename; plain shpool (0.11.7 and before) does not
        if shpool help 2>/dev/null | grep -q '^  rename '; then say rename yes; else say rename no; fi
        if ! json=$(shpool list --json 2>&1); then
            say error "shpool list --json failed: $(printf '%s' "$json" | oneline)"
            exit 0
        fi
        say sessions "$(printf '%s' "$json" | b64)"
        # Each attached session names the pid of its "shpool attach"; its parent is the launcher,
        # which is the process the editor knows the terminal by.  "PID PPID,PID PPID,..."
        say processes "$(ps -A -o pid= -o ppid= -o comm= 2>/dev/null | awk '$3 ~ /shpool$/ { printf "%s %s,", $1, $2 }')"
        ;;
    rename)
        if out=$(shpool rename "$NAME" "$NEW_NAME" 2>&1); then say result renamed
        else say error "$(printf '%s' "$out" | oneline)"; exit 0; fi
        ;;
    detach)
        if out=$(shpool detach "$NAME" 2>&1); then say result detached
        else say error "$(printf '%s' "$out" | oneline)"; exit 0; fi
        ;;
    *)
        say error "no such action: ${ACTION:-}"
        exit 0
        ;;
esac
say done yes
