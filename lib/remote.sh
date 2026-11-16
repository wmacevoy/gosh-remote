# Copyright 2026 Warren D. MacEvoy. GPL-3.0-or-later. See github.com/wmacevoy/gosh/LICENSE-GOSH, and LICENSE-MOSH.
#
# Run on the remote machine by lib/connect.js, which puts settings above
# this line.  It makes sure three things are there and running, and
# reports where they are:
#
#   1. this release of gosh (installed into ~/.local/bin if missing),
#   2. the editor's server, listening on a loopback port,
#   3. a gosh session forwarding a port on the user's machine to it.
#
# Everything it has to say goes on lines of the form  GOSHREMOTE key==value==
# so that whatever a login script prints cannot be mistaken for it.

report() { printf 'GOSHREMOTE %s==%s==\n' "$1" "$2"; }
fail() { report error "$*"; exit 1; }

fetch() { # URL FILE
    if command -v curl >/dev/null 2>&1; then
        curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget --tries=3 --timeout=15 --quiet -O "$2" "$1"
    else
        fail "the remote machine has neither curl nor wget"
    fi
}

# The SHA-256 of a file, or nothing if this machine has no way to work it out.
digest() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= *//'
    fi
}

# FILE WANT NAME: fails unless FILE's SHA-256 is WANT (the review of 2026-11-16: nothing downloaded is
# run until it matches what was published).
check() {
    have=$(digest "$1")
    [ -n "$have" ] || fail "cannot check $3: the remote machine has no sha256sum, shasum or openssl"
    [ -n "$2" ] && [ "$have" = "$2" ] || fail "$3 does not match its published checksum (expected ${2:-none}, got $have)"
}

PATH="$HOME/.local/bin:$PATH"
export PATH

case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "remote machines running $(uname -s) are not supported" ;;
esac
case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv8l) arch=armhf ;;
    *) fail "remote machines with a $(uname -m) processor are not supported" ;;
esac
if [ "$os" = linux ] && grep -qs '^ID=alpine' /etc/os-release; then
    os=alpine
fi
report platform "$os-$arch"

work=$(mktemp -d 2>/dev/null || mktemp -d -t remote-gosh) || fail "cannot make a temporary directory"
trap 'rm -rf "$work"' EXIT

# ---- 1. gosh

# Which gosh is here: since gosh 599429f the first line of gosh-server --version says
# ("gosh-server, of gosh vVERSION"). Installed again when it is not the one asked for.
release() { gosh-server --version 2>/dev/null | sed -n '1s/^gosh-server, of gosh v//p'; }
installed=$(release)
if [ "$installed" != "$GOSH_VERSION" ]; then
    report status "installing gosh $GOSH_VERSION"
    case "$GOSH_RELEASES" in https://*|file://*) ;; *) fail "gosh releases are fetched by https only, not from $GOSH_RELEASES" ;; esac
    fetch "$GOSH_RELEASES/v$GOSH_VERSION/SHA256SUMS" "$work/SHA256SUMS" \
        || fail "could not download the gosh release's SHA256SUMS from $GOSH_RELEASES"
    fetch "$GOSH_RELEASES/v$GOSH_VERSION/install.sh" "$work/install.sh" \
        || fail "could not download the gosh installer from $GOSH_RELEASES"
    check "$work/install.sh" "$(sed -n 's/^\([0-9a-f]\{64\}\) [ *]install\.sh$/\1/p' "$work/SHA256SUMS")" "gosh's install.sh"
    GOSH_VERSION="$GOSH_VERSION" GOSH_RELEASES="$GOSH_RELEASES" sh "$work/install.sh" >"$work/install.log" 2>&1 \
        || fail "installing gosh failed: $(tail -n 3 "$work/install.log" | tr '\n' ' ')"
    installed=$(release)
    [ "$installed" = "$GOSH_VERSION" ] || fail "gosh $GOSH_VERSION was installed but gosh-server does not run, or says it is ${installed:-nothing}"
fi
report gosh "$installed"

# ---- 2. the editor's server

data="$HOME/$SERVER_DATA_FOLDER"
dir="$data/bin/$SERVER_COMMIT"
program="$dir/bin/$SERVER_APP_NAME"
log="$data/.$SERVER_COMMIT.log"
pidfile="$data/.$SERVER_COMMIT.pid"
tokenfile="$data/.$SERVER_COMMIT.token"

if [ ! -x "$program" ]; then
    report status "installing the editor's server"
    url=$(printf '%s' "$SERVER_URL_TEMPLATE" | sed \
        -e "s/\${quality}/$SERVER_QUALITY/g" -e "s/\${version}/$SERVER_VERSION/g" \
        -e "s/\${commit}/$SERVER_COMMIT/g" -e "s/\${os}/$os/g" -e "s/\${arch}/$arch/g" \
        -e "s/\${release}/$SERVER_RELEASE/g")
    mkdir -p "$dir" || fail "cannot create $dir"
    fetch "$url" "$work/server.tar.gz" || fail "could not download the editor's server from $url"
    # VSCodium publishes the SHA-256 of each asset beside it, as ASSET.sha256
    fetch "$url.sha256" "$work/server.sha256" || fail "could not download the editor's server's checksum from $url.sha256"
    check "$work/server.tar.gz" "$(sed -n '1s/^\([0-9a-fA-F]\{64\}\).*/\1/p' "$work/server.sha256" | tr 'A-F' 'a-f')" "the editor's server"
    tar -xzf "$work/server.tar.gz" -C "$dir" --strip-components 1 || fail "could not unpack the editor's server"
    [ -x "$program" ] || fail "the editor's server was unpacked but $program is not there"
fi

listening() { sed -n 's/.*Extension host agent listening on \([0-9][0-9]*\).*/\1/p' "$log" 2>/dev/null | head -n 1; }

# Whether the process saved is the editor's server still, and not another that has its number since.
ours() {
    saved=$(cat "$pidfile" 2>/dev/null)
    # (by the token file it was given: its launcher hands every argument on to what it runs)
    [ -n "$saved" ] && kill -0 "$saved" 2>/dev/null && ps -p "$saved" -o args= 2>/dev/null | grep -qF -- "$tokenfile"
}

port=
if ours; then
    port=$(listening) # one is already running: use it
fi
if [ -z "$port" ]; then
    report status "starting the editor's server"
    ( umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \n' >"$tokenfile" )
    rm -f "$log"
    nohup "$program" --start-server --host=127.0.0.1 --port=0 \
        --connection-token-file "$tokenfile" --telemetry-level off \
        --enable-remote-auto-shutdown --accept-server-license-terms >"$log" 2>&1 </dev/null &
    echo $! >"$pidfile"
    tries=0
    while [ -z "$port" ] && [ $tries -lt 120 ]; do
        sleep 0.25
        tries=$((tries + 1))
        port=$(listening)
        kill -0 "$(cat "$pidfile")" 2>/dev/null || break
    done
    [ -n "$port" ] || fail "the editor's server did not start: $(tail -n 3 "$log" 2>/dev/null | tr '\n' ' ')"
fi
report serverPort "$port"
report token "$(cat "$tokenfile")"

# ---- optionally, terminals that outlive the editor

# With shpool, a terminal's shell belongs to a daemon on this machine
# rather than to the editor's server, so it survives the editor being
# quit and can be picked up again, from the editor or from anywhere.
# The editor is told to start terminals with a launcher that attaches to
# a shpool session, through this machine's own settings for it.

launcher="$HOME/.local/bin/remote-gosh-terminal"
profile="shpool (persistent)"
settings="$data/data/Machine/settings.json"
case "$os" in darwin) settings_os=osx ;; *) settings_os=linux ;; esac

cat >"$work/settings.js" <<'JS'
// usage: node settings.js FILE OS PROFILE LAUNCHER set|unset
const fs = require('fs');
const path = require('path');
const [file, os, profile, launcher, mode] = process.argv.slice(2);
const profiles = `terminal.integrated.profiles.${os}`;
const chosen = `terminal.integrated.defaultProfile.${os}`;
let text = null;
try {
    text = fs.readFileSync(file, 'utf8');
} catch (error) {
    if (error.code !== 'ENOENT') { throw error; }
}
let settings;
try {
    settings = text === null || text.trim() === '' ? {} : JSON.parse(text);
} catch (error) {
    process.exit(3); // someone's settings with comments in: not ours to rewrite
}
const before = JSON.stringify(settings);
if (mode === 'set') {
    settings[profiles] = { ...settings[profiles], [profile]: { path: launcher } };
    settings[chosen] = profile;
} else {
    if (settings[profiles] && settings[profiles][profile]) {
        delete settings[profiles][profile];
        if (Object.keys(settings[profiles]).length === 0) { delete settings[profiles]; }
    }
    if (settings[chosen] === profile) { delete settings[chosen]; }
}
if (JSON.stringify(settings) !== before) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 4)}\n`);
}
JS

set_terminals() { # set|unset
    "$dir/node" "$work/settings.js" "$settings" "$settings_os" "$profile" "$launcher" "$1" 2>/dev/null
}

if [ "${PERSISTENT_TERMINALS:-off}" = shpool ]; then
    if PATH="$HOME/.cargo/bin:$PATH" command -v shpool >/dev/null 2>&1; then
        mkdir -p "$HOME/.local/bin"
        printf '%s' "$LAUNCHER_SCRIPT" >"$launcher"
        chmod 755 "$launcher"
        if set_terminals set; then
            report terminals shpool
        else
            report note "Terminals were not made persistent: the editor's settings on the host ($settings) could not be rewritten."
        fi
    else
        set_terminals unset
        report note "Terminals are not persistent: shpool is not on the host, and this build of the extension has none for a $os-$arch host. Install it there with 'cargo install shpool' (or 'brew install shpool' on macOS)."
    fi
else
    set_terminals unset
fi

# ---- 3. a gosh session that forwards to it

# It has no terminal to serve, so its command just waits.  Should the
# user's machine vanish for good, it gives up after a week.
MOSH_SERVER_NETWORK_TMOUT=604800
export MOSH_SERVER_NETWORK_TMOUT

spec="$LOCAL_PORT:127.0.0.1:$port"
started=
for locale in "" en_US.UTF-8 C.UTF-8; do # the server insists on a UTF-8 locale
    started=$(
        [ -n "$locale" ] && { LC_ALL=$locale; export LC_ALL; }
        gosh-server new -s -L "$spec" -- sh -c 'while :; do sleep 86400; done' 2>/dev/null </dev/null
    ) && case "$started" in *"MOSH CONNECT "*) break ;; esac
    started=
done
[ -n "$started" ] || fail "gosh-server would not start on the remote machine"

set -- $(printf '%s\n' "$started" | sed -n 's/^MOSH CONNECT \([0-9][0-9]*\) \([A-Za-z0-9\/+]*\).*/\1 \2/p')
[ $# -eq 2 ] || fail "could not understand what gosh-server said"
report goshPort "$1"
report goshKey "$2"
report spec "$spec"

# The address this machine was reached at is the one to send the session's datagrams to.
set -- ${SSH_CONNECTION:-}
report goshAddress "${3:-}"
report done yes
