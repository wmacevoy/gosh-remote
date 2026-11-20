# Handoff, 2026-11-20: gosh-remote now carries gosh-shpool

Written at the end of a session on the server side, for testing connections from the local side.
Delete this file once it has been read and acted on.

## What changed today

1. **remote-gosh is now gosh-remote**, all of it (commit `6bf1ad0`). That covers:
   - the GitHub repo, `wmacevoy/gosh-remote` (private; the old URL redirects);
   - the extension's name and display name, `gosh-remote` / "Gosh - Remote";
   - its settings, `goshRemote.*` (was `remoteGosh.*`): **set them again** under the new names;
   - its commands, now titled "Gosh-Remote: …";
   - the names it leaves on hosts, `~/.local/bin/gosh-remote-terminal` and
     `gosh-remote-terminals-UID`. The old `remote-gosh-*` ones stay on hosts, unused, and can be
     deleted;
   - the local copies folder, now `~/gosh-remote-copies`.
2. **The shpool it carries is now gosh-shpool `0.11.7-gosh.2`, not plain shpool 0.11.6.**
   - What gosh-shpool is: shpool 0.11.7 plus `shpool rename` and `SHPOOL_SESSION_ID`, and fixes
     for two terminal-emulator bugs that could lose what was on screen on reattach.
     <https://github.com/wmacevoy/gosh-shpool> (public).
   - How it's fetched: `tools/build-shpool.js` downloads the release for each kind of host and
     checks it against the SHA-256 written in the script. It no longer builds anything, so Rust is
     no longer needed.
   - The Linux builds are static, so Alpine hosts now get shpool too (`bundledShpool` maps
     `alpine-*` onto them).

## Upstream PRs (each change in gosh-shpool is offered upstream)

| PR | What | State when written |
| --- | --- | --- |
| [shell-pool/shpool#459](https://github.com/shell-pool/shpool/pull/459) | `shpool rename`, `SHPOOL_SESSION_ID` | ready for review; CI waits for a maintainer to approve it |
| [shell-pool/shpool_vt100#2](https://github.com/shell-pool/shpool_vt100/pull/2) | line-mode restore left out the prompt line and misplaced the cursor | open |
| [shell-pool/shpool_vt100#3](https://github.com/shell-pool/shpool_vt100/pull/3) | restoring the cursor lost a pending wrap, so the next character overwrote the last | open |

When a shpool release includes them, drop the matching patches in gosh-shpool's `seam/`, move its
`core/` pin, release, and update `VERSION` and the hashes in `tools/build-shpool.js` here.

## Testing connections from the local side

```
git pull                         # in gosh-remote (renamed from remote-gosh)
pixi install                     # a clone that moved folders needs: rm -rf .pixi first
pixi run shpool                  # fetches and checks the three shpools into shpool/
pixi run test
pixi run vsix                    # gosh-remote-0.1.0.vsix
```

Install the `.vsix`, then set `goshRemote.persistentTerminals` to `shpool` (and any other
`goshRemote.*` settings you had under `remoteGosh.*`).

**A host that already has a shpool keeps it.** The extension only installs its own shpool on a
host with none (`host.shpool === 'no'` in `lib/connect.js`). So a host given 0.11.6 by an earlier
connection still runs 0.11.6, which has no `rename`. To test gosh-shpool on such a host, replace
it and restart its daemon:

```
shpool list                      # note anything worth keeping: the next step ends those sessions
pkill -x shpool                  # the old daemon; the next terminal starts the new one
rm ~/.local/bin/shpool           # then connect: the extension puts its own there
```

Upgrading a shpool the extension put there itself is not done yet; it is worth an issue.

Things to check:

- connect, and open terminals with persistent terminals on: they are `editor-WORKSPACE-N` sessions
  (`shpool list` on the host);
- `shpool rename editor-WORKSPACE-1 something` on the host: the terminal's prompt shows the new name
  at its next prompt, and `echo $SHPOOL_SESSION_NAME` agrees. The terminal tab won't follow yet;
  that's issue #3's item 4;
- reconnect after dropping the network (issue #2 is still open: a reconnect throws the gosh session
  away), and what the terminals come back to;
- an Alpine host, if you have one: it should now be given shpool.

## Still open

- gosh-remote #3: the commands are in (Attach Terminal to Session..., Rename Terminal's
  Session..., Detach Terminal's Session; README, "Pool terminals"), tested against a real shpool
  but not yet inside VSCodium. Still open from it: a window that comes back taking its own
  sessions back by itself (item 2, now by hand: Attach, Take It Over), and the tab of a terminal
  the editor opened by itself showing its session's name (item 4, now only after a rename or for
  terminals opened by Attach).
- gosh-remote #2: reconnects. #1: the how-to.
- gosh-shpool: shpool's `signal_exit_unlinks_sockets` test (`shpool/tests/events.rs`) failed once
  on Ubuntu CI. It sends SIGTERM as soon as the sockets exist, apparently before the daemon has
  installed its handler. That's another timing flake for a seam patch like `04-test-timing.patch`,
  and it might be a real startup bug.
- gosh-shpool's `seam/01-rename.patch` header still says "remote-gosh issue #3" (cosmetic).

## Where things are (server side)

- `~/projects/gosh-remote`: this repo (`main`).
- `~/projects/gosh-shpool`: the patched shpool build, with submodules `core/` (shpool v0.11.7) and
  `vt100/` (shpool_vt100 0.1.3), patches in `seam/`, and `tools/build.sh` / `tools/check.sh`.
- `~/projects/shpool` and `~/projects/shpool_vt100`: the forks the upstream PRs come from.
- Rust here comes from `~/projects/remote-mosh/.pixi/envs/shpool/bin` (prepend it to `PATH`);
  Node.js from pixi.
