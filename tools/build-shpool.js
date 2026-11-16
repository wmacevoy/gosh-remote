'use strict';

// Builds the shpool that the extension carries for hosts without one,
// for the kind of machine this is run on, into
//
//     shpool/linux-x64/shpool   shpool/linux-arm64/shpool   shpool/darwin/shpool
//
// along with shpool's licence.  On a Mac it builds for both kinds of
// processor and joins the two.  Needs Rust (cargo); "pixi run shpool"
// supplies it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '0.11.6';
const root = path.join(__dirname, '..');
const work = path.join(root, '.shpool-build');

function run(command, args, options = {}) {
    console.log(`> ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) {
        throw new Error(`${command} failed`);
    }
}

function build(target) {
    const out = path.join(work, target || 'native');
    const args = ['install', 'shpool', '--version', `=${VERSION}`, '--locked', '--root', out];
    if (target) {
        args.push('--target', target);
    }
    run('cargo', args, { env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: '11.0' } });
    return path.join(out, 'bin', 'shpool');
}

let kind;
let built;
if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    kind = `linux-${process.arch}`;
    built = build();
    run('strip', [built]);
} else if (process.platform === 'darwin') {
    kind = 'darwin';
    built = path.join(work, 'shpool-universal');
    if (spawnSync('rustup', ['--version']).status === 0) {
        const halves = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(target => {
            run('rustup', ['target', 'add', target]);
            return build(target);
        });
        run('lipo', ['-create', '-output', built, ...halves]);
    } else {
        // A Rust that cannot be asked for the other kind of Mac (pixi's, for one).
        console.log(`warning: no rustup, so this shpool will only run on Macs with a ${process.arch} processor`);
        fs.mkdirSync(work, { recursive: true });
        fs.copyFileSync(build(), built);
    }
    run('strip', ['-x', built]);
    run('codesign', ['--force', '--sign', '-', built]);
} else {
    throw new Error(`shpool is not built for ${process.platform} on ${process.arch} hosts.`);
}

const destination = path.join(root, 'shpool', kind);
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(built, path.join(destination, 'shpool'));
fs.chmodSync(path.join(destination, 'shpool'), 0o755);

// Its licence goes wherever it does.  (The crate does not include the text,
// so a copy from shpool's repository is kept in third-party/.)
fs.copyFileSync(path.join(root, 'third-party', 'shpool-LICENSE'), path.join(root, 'shpool', 'LICENSE'));
fs.writeFileSync(path.join(root, 'shpool', 'README.md'),
    `shpool ${VERSION} (https://github.com/shell-pool/shpool), built unmodified from crates.io.\n`
    + 'Its licence is in LICENSE beside this file.  The extension copies it to hosts that have\n'
    + 'no shpool when persistent terminals are turned on.\n');

run(path.join(destination, 'shpool'), ['version']);
console.log(`built shpool ${VERSION} for ${kind} hosts: ${path.join('shpool', kind, 'shpool')}`);
