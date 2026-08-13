import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GUIDE_CONTENT_URL,
  GUIDE_README_URL,
  GuideSourceError,
  compareContentVersions,
  loadExtellaGuideSource,
} from "../scripts/extella-guide-source.mjs";

function guideContent(version, body = "<p>Безопасный текст</p>") {
  return JSON.stringify({
    "версия_содержимого": version,
    "разделы": [
      {
        "номер": "09",
        "заголовок": "Мост",
        "тело": body,
      },
    ],
  });
}

function sourceFetch({ content, readme = "# README" }) {
  return async (url) => {
    if (url === GUIDE_CONTENT_URL) return new Response(content, { status: 200 });
    if (url === GUIDE_README_URL) return new Response(readme, { status: 200 });
    throw new Error(`Unexpected guide URL: ${url}`);
  };
}

test("content versions compare by date and numeric revision", () => {
  assert.ok(compareContentVersions("2026-08-13.10", "2026-08-13.9") > 0);
  assert.ok(compareContentVersions("2026-08-14.0", "2026-08-13.99") > 0);
  assert.equal(compareContentVersions("2026-08-13.4", "2026-08-13.4"), 0);
});

test("guide source removes executable HTML and persists only its accepted version", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "extella-guide-source-"));
  try {
    const result = await loadExtellaGuideSource({
      stateDir,
      fetchImpl: sourceFetch({
        content: guideContent(
          "2026-08-13.4",
          '<p onclick="steal()">Текст</p><script>steal()</script><a href="javascript:steal()">ссылка</a>',
        ),
        readme: '<img src="javascript:steal()"><strong>README</strong>',
      }),
    });

    assert.equal(result.contentVersion, "2026-08-13.4");
    assert.match(result.context, /Текст/);
    assert.match(result.context, /README/);
    assert.doesNotMatch(result.context, /steal|onclick|javascript:/i);

    const state = await readFile(join(stateDir, "extella-guide-source-version.json"), "utf8");
    assert.equal(state, '{"content_version":"2026-08-13.4"}\n');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("guide source refuses a rollback after a newer version was accepted", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "extella-guide-source-"));
  try {
    await loadExtellaGuideSource({
      stateDir,
      fetchImpl: sourceFetch({ content: guideContent("2026-08-13.5") }),
    });
    await assert.rejects(
      loadExtellaGuideSource({
        stateDir,
        fetchImpl: sourceFetch({ content: guideContent("2026-08-13.4") }),
      }),
      (error) => error instanceof GuideSourceError && error.code === "extella_guide_source_rollback_detected",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
