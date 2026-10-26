# Cross-building the Windows installer from macOS

The fork's GitHub Actions are disabled upstream-side, so Windows artifacts are
produced locally on macOS. This note records what the cross build needs and what
it cannot do, so the next run does not rediscover it.

## Constraints

`electron-builder --win` on macOS has three gaps in this repository:

1. **Windows Hello helper** — `scripts/beforePackCursorSdk.cjs` runs
   `scripts/build-windows-hello-helper.cjs`, which only compiles with MSVC
   (`spawnSync cl.exe ENOENT` off Windows). Pre-place a prebuilt
   `electron/bridges/windowsHelloHelper/build/x64/NetcattyWindowsHello.exe`
   (any x64 build of the same helper works; it is not version-locked) and skip
   `beforePack`.
2. **Native modules** — `npmRebuild` default fails with
   `node-gyp does not support cross-compiling native modules from source`
   (`@serialport/bindings-cpp`). Set `npmRebuild: false`; the win32 prebuilds of
   `@serialport/bindings-cpp`, `node-pty` (node-addon-api, so ABI-stable) and
   `@cursor/sdk-win32-x64` are already in `node_modules`.
3. **node-pty conpty patch** — `scripts/afterPackMacUuid.cjs` calls
   `rebuildPatchedNodePty()` for `win32`, which shells out to
   `@electron/rebuild --build-from-source`. Skip `afterPack` and instead copy
   `node_modules/node-pty/prebuilds/win32-x64/{pty.node,conpty.node,
   conpty_console_list.node,winpty.dll,winpty-agent.exe,conpty/*}` into the
   packaged `resources/app.asar.unpacked/node_modules/node-pty/build/Release/`
   after packing. The packaged app must not ship the macOS `pty.node` or
   `spawn-helper` from `node_modules/node-pty/build/Release`.

Network: GitHub releases are unusable from this network (~20 KB/s, the electron
win32-x64 archive alone needs hours). Use the npmmirror CDN instead:

```
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://cdn.npmmirror.com/binaries/electron-builder-binaries/ \
npx electron-builder …
```

## Working sequence

```bash
# 1. unpacked app (needs the mirrors, otherwise the electron download times out)
cat > /tmp/eb-win.cjs <<'EOF'
const base = require('/abs/path/to/NetCatty/electron-builder.config.cjs');
const config = { ...base };
delete config.beforePack;
delete config.afterPack;
config.npmRebuild = false;
module.exports = config;
EOF
npx electron-builder --config /tmp/eb-win.cjs --win --x64 --dir --publish=never \
  -c.directories.output=/tmp/nce-windir -c.win.signAndEditExecutable=false

# 2. swap in the Windows node-pty binaries inside the unpacked app (see above),
#    then build the installers from the prepared directory
npx electron-builder --config /tmp/eb-win.cjs --win nsis portable zip --x64 \
  --prepackaged /tmp/nce-windir/win-unpacked \
  -c.win.signAndEditExecutable=false -c.directories.output=/tmp/nce-winout
```

`-c.win.signAndEditExecutable=false` avoids `rcedit`, which needs Wine on macOS.
Cost: `Netcatty.exe` keeps Electron's stock icon and version resource. Re-enable
it (or add `toolsets.wine` / a JS PE patcher such as `resedit`) when a polished
Windows build is needed, or build on Windows where both the helper and the
conpty patch compile natively.

## macOS

Unchanged and unaffected: `npm run build` then

```bash
npx electron-builder --mac dmg --arm64 --config electron-builder.config.cjs \
  -c.directories.output=/tmp/nce-out -c.mac.identity=null
```

The `--config` flag is mandatory; without it `asarUnpack` and the artifact name
are ignored and the dmg balloons to ~750 MB.
