# Using VSCodium with a host behind a meetup

How to open a folder on a host that nothing can connect to (a build server whose firewall is
closed, or a desktop at home) in VSCodium, through a gosh meetup on a small AWS server. This page
uses the names from one real setup: the host is `make`, and the AWS server is `gosh-meetup`.
Swap in your own names.

The README's [Getting started](README.md#getting-started) comes first. This page adds the meetup
to it.

**What has been tried.** One setup has been run this way: VSCodium on macOS, the meetup on AWS,
and `make` (Debian 12) reached through a reverse tunnel. Nothing else has been tried, and no test
of this extension covers it.

## How it fits together

```
laptop (VSCodium) ──ssh──▶ gosh-meetup (AWS) ◀──reverse ssh tunnel── make
        │                     │ UDP 3478                               │
        └────── gosh session: straight to make if a way is found, ─────┘
                else datagrams go through the meetup
```

- **ssh** gets to `make` through the tunnel that `make` keeps open to `gosh-meetup`. The extension
  uses it to set up the host and start the session.
- **The meetup** (`gosh-server meetup 3478` on `gosh-meetup`) helps the two ends of the session
  find a way to each other by UDP. If they find none, it passes their datagrams along. It cannot
  read the session.
- **The extension has no meetup setting.** It starts the gosh client with VSCodium's own
  environment, and the meetup reaches the client through two variables in that environment. So
  **VSCodium has to be started with them set.** That is the reason for the script below.

## 1. The meetup server

Set it up as gosh's `docs/AWS.md`, *Case 2*, describes: gosh installed there,
`gosh-server meetup 3478` running, and UDP 3478 and TCP 22 open. On your laptop, give it an
ssh alias:

```
Host gosh-meetup
    HostName meetup.example.org
    User alpine
```

Check it: `ssh -o BatchMode=yes gosh-meetup gosh-server --version` prints gosh's version. If the
command is not found, gosh is in `~/.local/bin` and the server's non-login shell doesn't put that
on its PATH. The ticket command below allows for that.

## 2. The host's tunnel to it

On `make`, keep a reverse tunnel open, so that port 2222 on the meetup server's loopback is
`make`'s sshd. As a systemd service, run by a user of its own whose key is allowed only that:

```ini
[Service]
User=meetup-tunnel
ExecStart=/usr/bin/ssh -N -R 2222:localhost:22 -i /var/lib/meetup-tunnel/id_ed25519 \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o BatchMode=yes tunnel@meetup.example.org
Restart=always
RestartSec=20
```

If the meetup server stops, the tunnel tries again every 20 seconds until it is back.

## 3. ssh aliases on the laptop

```
# make, through its tunnel.
Host make-via-meetup
    HostName localhost
    Port 2222
    User me
    ProxyJump gosh-meetup
    HostKeyAlias make.example.org
```

`HostKeyAlias` makes ssh check `make`'s own host key, not the key of "localhost". Check it:
`ssh -o BatchMode=yes make-via-meetup true && echo ok` prints `ok`. Until it does, nothing below
will work, because the extension logs in by ssh and has nowhere to ask for anything.

## 4. Start VSCodium with the meetup

These are what `gosh --meetup=gosh-meetup:3478` would hand its relay (gosh, `docs/gosh.1`):

| Variable | Value |
| --- | --- |
| `GOSH_MEETUP` | the meetup's `HOST:PORT`, e.g. `meetup.example.org:3478` (a host name, not the ssh alias) |
| `GOSH_MEETUP_TICKET_COMMAND` | the command that fetches a ticket, its words joined by character 31 (`\x1f`) |
| `GOSH_RELAY_LOG` | optional: a file where the local relay writes each step it takes |

Then start VSCodium **from that shell**, and open the folder:

```sh
codium --folder-uri "vscode-remote://gosh+make-via-meetup/home/me/projects/gosh"
```

If VSCodium is already running, quit it fully first (Cmd-Q). Otherwise `codium` hands the folder
to the running instance, which doesn't have the variables, and the session never uses the meetup.

## The example: `make-gosh`

The owner's own launcher, made general. It checks that ssh gets through, sets the variables,
restarts VSCodium if needed, and opens the folder. Without `--meetup` it connects to `make`
directly. Put it anywhere on your PATH, and change the values at the top.

```bash
#!/usr/bin/env bash
# make-gosh: open a folder on make in VSCodium, over gosh-remote.
#
# Usage: make-gosh [--meetup]
#   (none)     straight to make: make is public, so gosh needs no meetup to find it.
#   --meetup   through make's tunnel to the meetup, as a host behind NAT is reached, with gosh
#              told to use the meetup (as `gosh --meetup=gosh-meetup` would).
#
# With --meetup, the meetup reaches the extension's gosh client only through VSCodium's
# environment, so VSCodium must be started by this script: if it is already running, it offers
# to quit it first.
set -euo pipefail

USE_MEETUP=0
for a in "$@"; do
  case $a in
    --meetup) USE_MEETUP=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "make-gosh: unknown argument: $a" >&2; exit 2 ;;
  esac
done

MEETUP=gosh-meetup                      # ssh alias of the meetup server
HOST=make                               # ssh alias of make, straight
VIA=make-via-meetup                     # ssh alias of make through its tunnel
REMOTE_DIR=/home/me/projects/gosh
APP=VSCodium

say() { printf 'make-gosh: %s\n' "$*"; }
die() { printf 'make-gosh: %s\n' "$*" >&2; exit 1; }

if [ "$USE_MEETUP" = 0 ]; then
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null || die "ssh $HOST does not log in"
  say "opening $REMOTE_DIR on $HOST in $APP (straight, no meetup)"
  codium --folder-uri "vscode-remote://gosh+$HOST$REMOTE_DIR"
  exit 0
fi
HOST=$VIA

# 1. If your meetup server stops itself when idle, start it (or reset its idle timer) here.

# 2. make's tunnel retries every 20 s once the meetup server is up.
say "waiting for make's tunnel through the meetup"
for i in $(seq 1 30); do
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOST" true 2>/dev/null && break
  [ "$i" = 30 ] && die "ssh $HOST does not log in after 90 s: is the tunnel service running on make?"
  sleep 3
done

# 3. What `gosh --meetup=$MEETUP` gives its relay: the meetup's address, and how to get a ticket.
name=$(ssh -G "$MEETUP" 2>/dev/null </dev/null | awk '$1=="hostname"{print $2}')
[ -n "$name" ] || die "ssh alias $MEETUP has no HostName"
export GOSH_MEETUP="$name:3478"
US=$'\x1f'
export GOSH_MEETUP_TICKET_COMMAND="ssh${US}-T${US}-o${US}BatchMode=yes${US}$MEETUP${US}--${US}sh -c 'PATH=\"\$HOME/.local/bin:\$PATH\"; export PATH; exec gosh-server meetup-ticket'"

# The local relay's log: the ways it tries, and why it stays on ssh, if it does.
mkdir -p "$HOME/Library/Logs/make-gosh"
export GOSH_RELAY_LOG="$HOME/Library/Logs/make-gosh/relay-$(date +%Y%m%d-%H%M%S).log"

# 4. VSCodium has to be started with that environment.
if pgrep -qf "$APP.app/Contents/MacOS/$APP"; then
  [ -t 0 ] || die "$APP is running; quit it (Cmd-Q) and run this again"
  read -r -p "make-gosh: $APP is running and cannot be given the meetup; quit it now? [y/N] " a
  case $a in y|Y|yes) ;; *) die "left $APP running; quit it and run this again" ;; esac
  osascript -e "quit app \"$APP\"" || die "could not quit $APP"
  for i in $(seq 1 30); do pgrep -qf "$APP.app/Contents/MacOS/$APP" || break; sleep 1; done
  pgrep -qf "$APP.app/Contents/MacOS/$APP" && die "$APP is still running (unsaved files?)"
fi

say "opening $REMOTE_DIR on $HOST in $APP (meetup $GOSH_MEETUP)"
codium --folder-uri "vscode-remote://gosh+$HOST$REMOTE_DIR"
say "the relay logs to $GOSH_RELAY_LOG"
```

The quitting and the log path are for macOS. On Linux, quit VSCodium by hand and choose another
place for the log.

## Did it work?

- **Gosh-Remote: Show Log** says `gosh: connected; forwarding.`
- The relay's log (`GOSH_RELAY_LOG`) says each step: "a ticket for the meetup at ...",
  "registered with the meetup at ...", and then either a way straight to the host or
  "a way through is open, to the meetup".
- **No line about the meetup in the relay's log:** VSCodium was not started with the variables.
  Quit it fully and start it from the script.
- **"Could not set up make-via-meetup":** ssh failed. Run
  `ssh -o BatchMode=yes make-via-meetup true` and fix what it says. Usually the meetup server is
  stopped, or the tunnel on `make` is down.
- **It connects, but the log never mentions a ticket:** `goshRemote.relay` is `never` or
  `always`. Neither uses the meetup: `never` doesn't use ssh, and `always` doesn't use UDP. Leave
  it at `auto`.

A session going through the meetup still keeps its ssh connection open, in case the meetup stops
answering. If the meetup server goes away mid-session, the session stays up over ssh, which is
slower.
