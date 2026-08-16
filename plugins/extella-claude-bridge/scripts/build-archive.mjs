#!/usr/bin/env node
// Собрать архив локальной части: install.py в корне плюс рантайм моста.
//
// Архив едет покупателю целиком (B7), поэтому кладём ровно перечисленные файлы
// и проверяем, что среди них нет ничего похожего на секрет. Сборка
// детерминированная: одинаковый вход даёт одинаковый zip, чтобы расхождение
// было видно по контрольной сумме, а не по дате.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, copyFile, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_DIR = resolve(PLUGIN_DIR, "..", "extella-codex-bridge");
const OUTPUT = resolve(PLUGIN_DIR, "dist", "extella-claude-bridge-archive.zip");

const FROM_CODEX = [
  "bridge-entry.mjs",
  "bridge-core.mjs",
  "bridge-server.mjs",
  "execution-profiles.mjs",
  "extella-guide-source.mjs",
  "invoke-provider.mjs",
  "adapter-claude.mjs",
  "claude-cli-contract.mjs",
];
const FROM_CLAUDE = ["configure-claude-bridge-macos.mjs"];

// Архив уезжает покупателю целиком, поэтому содержимое проверяется, а не
// подразумевается: ищем то, что похоже на ключ или токен по значению.
const SECRET_SHAPES = [
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // jwt
  /sk-[A-Za-z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

async function assertNoSecrets(path, source) {
  for (const shape of SECRET_SHAPES) {
    if (shape.test(source)) {
      throw new Error(`${path}: содержимое похоже на секрет (${shape})`);
    }
  }
}

async function main() {
  const staging = await mkdtemp(join(tmpdir(), "extella-claude-archive-"));
  try {
    await mkdir(join(staging, "scripts"), { recursive: true });
    await mkdir(join(staging, "schemas"), { recursive: true });

    const manifest = [];
    for (const [sourceDir, names] of [[CODEX_DIR, FROM_CODEX], [PLUGIN_DIR, FROM_CLAUDE]]) {
      for (const name of names) {
        const from = join(sourceDir, "scripts", name);
        const source = await readFile(from, "utf8");
        await assertNoSecrets(name, source);
        await copyFile(from, join(staging, "scripts", name));
        manifest.push([`scripts/${name}`, createHash("sha256").update(source).digest("hex")]);
      }
    }
    const schema = join(CODEX_DIR, "schemas", "provider-result.schema.json");
    await copyFile(schema, join(staging, "schemas", "provider-result.schema.json"));
    manifest.push(["schemas/provider-result.schema.json",
      createHash("sha256").update(await readFile(schema, "utf8")).digest("hex")]);

    const installer = join(PLUGIN_DIR, "archive", "install.py");
    const installerSource = await readFile(installer, "utf8");
    await assertNoSecrets("install.py", installerSource);
    await copyFile(installer, join(staging, "install.py"));
    await chmod(join(staging, "install.py"), 0o755);
    manifest.push(["install.py",
      createHash("sha256").update(installerSource).digest("hex")]);

    await writeFile(
      join(staging, "MANIFEST.sha256"),
      manifest.map(([name, digest]) => `${digest}  ${name}`).join("\n") + "\n",
      "utf8",
    );

    await mkdir(dirname(OUTPUT), { recursive: true });
    await rm(OUTPUT, { force: true });
    // -X убирает метаданные macOS, из-за которых zip перестаёт быть
    // воспроизводимым от сборки к сборке.
    await execFileAsync("zip", ["-q", "-r", "-X", OUTPUT, "."], { cwd: staging });

    const bytes = await readFile(OUTPUT);
    console.log(JSON.stringify({
      status: "built",
      archive: OUTPUT,
      bytes: bytes.length,
      files: manifest.length + 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }, null, 2));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`build-archive: ${error.message}`);
  process.exitCode = 1;
});
