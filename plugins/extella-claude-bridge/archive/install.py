#!/usr/bin/env python3
"""Разложить локальную часть моста Extella ↔ Claude Code на машине покупателя.

Почему это существует: Expert — запись в базе, у неё нет каталога рядом. Первая
версия искала установщик моста через `__file__` и падала на любой машине без
репозитория, потому что проверялась только запуском из каталога с исходниками.
Рантайм доставляется архивом листинга — это и есть штатный способ по H10.

Установщик неинтерактивен (B2), честен кодом возврата (B3) и пишет привязку
агента (B4). Службу он НЕ поднимает: для этого нужен токен аккаунта, и её
ставит этап `bridge` установочного Expert после явного подтверждения стоимости.
"""

import json
import os
import pathlib
import shutil
import sys

PRODUCT = "extella_claude_bridge"
HOME = pathlib.Path.home()
TARGET = HOME / PRODUCT
HERE = pathlib.Path(__file__).resolve().parent

RUNTIME_FILES = [
    "scripts/bridge-entry.mjs",
    "scripts/bridge-core.mjs",
    "scripts/bridge-server.mjs",
    "scripts/execution-profiles.mjs",
    "scripts/extella-guide-source.mjs",
    "scripts/invoke-provider.mjs",
    "scripts/adapter-claude.mjs",
    "scripts/claude-cli-contract.mjs",
    "scripts/configure-claude-bridge-macos.mjs",
    "schemas/provider-result.schema.json",
]


def fail(message: str, code: int = 1):
    # Честный код возврата: ноль при поломке означает, что покупателя спишут
    # за нерабочую установку.
    print(f"install: {message}", file=sys.stderr)
    sys.exit(code)


def main() -> None:
    if sys.platform != "darwin":
        fail("локальная часть моста Claude пока поддерживает только macOS")

    missing = [name for name in RUNTIME_FILES if not (HERE / name).is_file()]
    if missing:
        fail(f"в архиве нет файлов рантайма: {', '.join(missing[:3])}")

    TARGET.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(TARGET, 0o700)
    for name in RUNTIME_FILES:
        destination = TARGET / name
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(HERE / name, destination)
        os.chmod(destination, 0o600)

    # B4: панель и Expert должны знать, с каким агентом работать.
    binding = {
        "agent_id": os.environ.get("EXTELLA_AGENT_ID", ""),
        "app_name": os.environ.get("EXTELLA_APP_NAME", PRODUCT),
        "app_version": os.environ.get("EXTELLA_APP_VERSION", ""),
        "runtime_dir": str(TARGET),
    }
    path = TARGET / "agent_binding.json"
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(binding, stream, ensure_ascii=False, indent=1)

    installed = sum(1 for name in RUNTIME_FILES if (TARGET / name).is_file())
    if installed != len(RUNTIME_FILES):
        fail(f"разложено {installed} файлов из {len(RUNTIME_FILES)}")

    print(json.dumps({
        "status": "installed",
        "runtime_dir": str(TARGET),
        "files": installed,
        "service_started": False,
        "note": "службу ставит этап bridge установочного Expert после подтверждения стоимости",
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 — падение обязано быть видимым
        fail(f"{type(error).__name__}: {error}")
