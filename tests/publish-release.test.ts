import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "wx-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.alloc(256);
  bytes.write("MZ");
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write("PE\0\0", 128);
  bytes.writeUInt16LE(0x8664, 132);
  bytes.writeUInt16LE(2, 150);
  bytes.writeUInt16LE(0x020b, 152);
  const exe = join(dir, "video_channel.exe");
  writeFileSync(exe, bytes);
  const uploader = join(dir, "uploader.cmd");
  const uploaderCode = join(dir, "uploader.cjs");
  writeFileSync(
    uploaderCode,
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PUBLISH_LOG, args[2] + '\\n');
fs.appendFileSync(process.env.PUBLISH_OPTIONS, JSON.stringify(args.slice(3)) + '\\n');
if (process.env.FAIL_UPLOAD === '1' || (process.env.FAIL_UPLOAD === '2' && args[2].endsWith('/latest.json'))) process.exit(1);
fs.copyFileSync(args[1], process.env.PUBLISH_CAPTURE);
`
  );
  writeFileSync(uploader, `@"${process.execPath}" "%~dp0uploader.cjs" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  const log = join(dir, "uploads.txt");
  const capture = join(dir, "uploaded.json");
  const options = join(dir, "options.txt");
  function run(failAt = 0, version = "1.0.4") {
    return spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "scripts/publish-release.ps1"),
        "-ExecutablePath",
        exe,
        "-Version",
        version,
        "-Uploader",
        uploader,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PUBLISH_LOG: log, PUBLISH_CAPTURE: capture, PUBLISH_OPTIONS: options, FAIL_UPLOAD: String(failAt) },
      }
    );
  }
  return { bytes, exe, log, capture, options, run };
}

test("发布先上传按哈希定位的 EXE，最后上传包含哈希和长度的清单", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const hash = createHash("sha256").update(f.bytes).digest("hex");
  assert.deepEqual(
    readFileSync(f.log, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim()),
    [`tos://crmspark/plus/video-channel/${hash}/video_channel.exe`, "tos://crmspark/plus/video-channel/latest.json"]
  );
  assert.deepEqual(
    readFileSync(f.options, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((s) => JSON.parse(s)),
    [["-vchecksum"], ["-vchecksum", "-contentType=application/json", "-cacheControl=no-cache,no-store,must-revalidate"]]
  );
  assert.deepEqual(JSON.parse(readFileSync(f.capture, "utf8")), {
    version: "1.0.4",
    platform: "win-x64",
    url: `https://crmspark.tos-cn-shanghai.volces.com/plus/video-channel/${hash}/video_channel.exe`,
    sha256: hash,
    bytes: f.bytes.length,
  });
});

test("EXE 上传失败不推进 latest.json", (t) => {
  const f = fixture(t);
  const result = f.run(1);
  assert.notEqual(result.status, 0);
  const lines = readFileSync(f.log, "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("/video_channel.exe"));
});

test("非 Windows x64 EXE 不允许发布", (t) => {
  const f = fixture(t);
  writeFileSync(f.exe, "broken");
  assert.notEqual(f.run().status, 0);
  assert.equal(existsSync(f.log), false);
});

test("清单上传失败不会伪报发布成功", (t) => {
  const f = fixture(t);
  const result = f.run(2);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Latest manifest upload failed/);
  assert.doesNotMatch(result.stdout, /Published video_channel/);
  assert.equal(readFileSync(f.log, "utf8").trim().split(/\r?\n/).length, 2);
});

test("发布兼容原构建支持的四段 Windows 版本号", (t) => {
  const f = fixture(t);
  const result = f.run(0, "1.0.4.1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(f.capture, "utf8")).version, "1.0.4.1");
});
