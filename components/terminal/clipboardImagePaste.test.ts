import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRemoteClipboardImagePath,
  handleRemoteClipboardImagePaste,
  quoteRemotePathForShell,
} from "./clipboardImagePaste";

test("remote clipboard image path is placed under the current directory", () => {
  assert.equal(
    buildRemoteClipboardImagePath("/srv/app", "netcatty paste:1.png"),
    "/srv/app/.netcatty-paste-images/netcatty_paste_1.png",
  );
});

test("remote clipboard image path falls back to home when cwd is unavailable", () => {
  assert.equal(
    buildRemoteClipboardImagePath(undefined, "shot.png"),
    "~/.netcatty-paste-images/shot.png",
  );
});

test("remote paths are quoted for shell-safe insertion", () => {
  assert.equal(
    quoteRemotePathForShell("/srv/app/.netcatty-paste-images/a b's.png"),
    "'/srv/app/.netcatty-paste-images/a b'\\''s.png'",
  );
});

test("remote clipboard image paste uploads and inserts the remote image path", async () => {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const scrolled: string[] = [];
  let focused = false;
  let closedSftpId: string | undefined;
  const transferPayloads: unknown[] = [];

  const handled = await handleRemoteClipboardImagePaste({
    bridge: {
      readClipboardImage: async () => ({
        path: "/tmp/netcatty/shot.png",
        name: "shot 1.png",
        mediaType: "image/png",
        size: 12,
      }),
      openSftpForSession: async (sessionId) => {
        assert.equal(sessionId, "session-1");
        return "sftp-1";
      },
      startStreamTransfer: async (options) => {
        transferPayloads.push(options);
        return { transferId: options.transferId, totalBytes: 12 };
      },
      closeSftp: async (sftpId) => {
        closedSftpId = sftpId;
      },
    },
    createTransferId: () => "transfer-1",
    getRemoteCwd: async () => "/home/alice/project",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: (sessionId, data) => writes.push({ sessionId, data }),
    },
    term: {
      focus: () => {
        focused = true;
      },
    },
    scrollToBottomAfterProgrammaticInput: (data) => scrolled.push(data),
  });

  assert.equal(handled, true);
  assert.deepEqual(transferPayloads, [
    {
      transferId: "transfer-1",
      sourcePath: "/tmp/netcatty/shot.png",
      targetPath: "/home/alice/project/.netcatty-paste-images/shot_1.png",
      sourceType: "local",
      targetType: "sftp",
      targetSftpId: "sftp-1",
      totalBytes: 12,
    },
  ]);
  assert.deepEqual(writes, [
    {
      sessionId: "session-1",
      data: "/home/alice/project/.netcatty-paste-images/shot_1.png",
    },
  ]);
  assert.deepEqual(scrolled, ["/home/alice/project/.netcatty-paste-images/shot_1.png"]);
  assert.equal(focused, true);
  assert.equal(closedSftpId, "sftp-1");
});

test("remote clipboard image paste reports unhandled when no image exists", async () => {
  const handled = await handleRemoteClipboardImagePaste({
    bridge: {
      readClipboardImage: async () => null,
      openSftpForSession: async () => "sftp-1",
      startStreamTransfer: async (options) => ({ transferId: options.transferId }),
    },
    getRemoteCwd: async () => "/home/alice",
    sessionId: "session-1",
    terminalBackend: {
      writeToSession: () => assert.fail("should not paste without an image"),
    },
  });

  assert.equal(handled, false);
});
