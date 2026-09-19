"""Compile in a disposable process so cancellation also terminates compiler children."""
import asyncio
import json
import shutil
import sys

from app.agent.models import Project
from app.services.arduino_cli import ArduinoCLIService


async def main():
    try:
        project = Project.model_validate_json(sys.stdin.read(1000000))
        compiler = ArduinoCLIService()
        if not shutil.which(compiler.cli_path):
            result = {"success": False, "error_kind": "toolchain_unavailable",
                      "error": "arduino-cli is not installed or not on the backend PATH."}
        else:
            result = await compiler.compile(
                [file.model_dump() for file in project.files], "arduino:avr:uno"
            )
    except Exception:
        result = {"success": False, "error": "Arduino compiler failed. Check the backend toolchain."}
    print("\n__VELXIO_AGENT_RESULT__" + json.dumps(result), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
