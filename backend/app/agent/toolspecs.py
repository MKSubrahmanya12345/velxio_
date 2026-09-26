"""Native tool specs for the Bedrock transports (v2).

One list, two wire formats:
  Converse  -> [{"toolSpec": {"name", "description", "inputSchema": {"json": schema}}}]
  Mantle    -> [{"type": "function", "function": {"name", "description", "parameters": schema}}]

There is no bespoke response schema anywhere: the transport enforces the
tool-call shape, which is what deletes the whole salvage/fixer class.
"""
from __future__ import annotations

_TYPE = {"type": "object", "additionalProperties": False}

_FILE_NAME = {"type": "string", "description": (
    "Flat file name: sketch.ino, a .h header, main.py (Pi), or diagram.json.")}

SPECS: list[dict] = [
    {
        "name": "list_files",
        "description": "List the workspace files with sizes. The workspace is "
                       "sketch.ino (or main.py on Pi), optional .h headers, and "
                       "diagram.json (board, parts, connections).",
        "schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "read_file",
        "description": "Read one workspace file whole.",
        "schema": {"type": "object", "required": ["name"], "additionalProperties": False,
                   "properties": {"name": _FILE_NAME}},
    },
    {
        "name": "write_file",
        "description": "Create or replace a whole file. Use for new files and "
                       "for code. For diagram.json prefer edit_file when fixing "
                       "one wire or part; whole writes are for a fresh circuit.",
        "schema": {"type": "object", "required": ["name", "content"],
                   "additionalProperties": False,
                   "properties": {"name": _FILE_NAME,
                                  "content": {"type": "string"}}},
    },
    {
        "name": "edit_file",
        "description": "Replace ONE exact span: old_string must appear exactly "
                       "once in the file. The default tool for fixing "
                       "diagram.json and code — a one-line fix stays one line.",
        "schema": {"type": "object", "required": ["name", "old_string", "new_string"],
                   "additionalProperties": False,
                   "properties": {"name": _FILE_NAME,
                                  "old_string": {"type": "string"},
                                  "new_string": {"type": "string"}}},
    },
    {
        "name": "catalog",
        "description": "Look up parts (ids, pins, libraries, sim support) or, "
                       "with an empty query, the selected board's pinout.",
        "schema": {"type": "object", "additionalProperties": False,
                   "properties": {"query": {"type": "string",
                                            "description": "e.g. 'oled', 'servo', 'dht'; empty = board pinout"}}},
    },
    {
        "name": "check",
        "description": "Lint the workspace: parses diagram.json and every source "
                       "file, then runs the deterministic electrical analysis "
                       "(unwired pins, shorts, series resistors, I2C clashes, "
                       "PWM/ADC mismatches). Returns clean + problem lines. "
                       "Runs automatically before every compile anyway.",
        "schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "compile",
        "description": "Run the real toolchain on the workspace. Returns the "
                       "compiler's stdout/stderr tail like a normal command. "
                       "check() problems block the build until fixed.",
        "schema": {"type": "object", "additionalProperties": False,
                   "properties": {"fast": {"type": "boolean",
                                           "description": "shorter build (final verify still uses a full compile)"}}},
    },
    {
        "name": "simulate",
        "description": "AVR boards only: run the compiled firmware headless and "
                       "report pin transitions, serial output and stimulus "
                       "notes. Two bounds: observe_ms of simulated time and a "
                       "fixed wall-clock kill.",
        "schema": {"type": "object", "additionalProperties": False,
                   "properties": {
                       "observe_ms": {"type": "integer",
                                      "description": "simulated ms to observe (100-10000, default 3000)"},
                       "interactions": {"type": "array", "description": (
                           "e.g. [{\"kind\":\"press\",\"componentId\":\"btn1\",\"at_ms\":500}] — "
                           "kinds: press, switch, pot, rotary"),
                                        "items": {"type": "object"}}},
                   },
    },
    {
        "name": "done",
        "description": "Finish the run. A deterministic check verifies that "
                       "every catalog part the user named exists in the circuit "
                       "(missing -> fix it and call done again). The workspace "
                       "diff then goes to the user as a pending checkpoint.",
        "schema": {"type": "object", "required": ["summary"], "additionalProperties": False,
                   "properties": {
                       "summary": {"type": "string",
                                   "description": "one short paragraph for the user"},
                       "plan": {"type": "array", "items": {"type": "string"},
                                "description": "up to 8 short steps you took"},
                       "expectations": {"type": "object", "description": (
                           "falsifiable live checks, AVR boards: {pins:[{pin,on,off,within_ms}], "
                           "serial:[{matches}], interactions:[{kind,componentId,pin?,at_ms?,hold_ms?,"
                           "closed?,value?,delta?}], observe_ms}")},
                   }},
    },
]


def converse_tools() -> list[dict]:
    return [{"toolSpec": {"name": s["name"], "description": s["description"],
                          "inputSchema": {"json": s["schema"]}}}
            for s in SPECS]


def mantle_tools() -> list[dict]:
    return [{"type": "function",
             "function": {"name": s["name"], "description": s["description"],
                          "parameters": s["schema"]}}
            for s in SPECS]


def by_name(name: str) -> dict | None:
    for spec in SPECS:
        if spec["name"] == name:
            return spec
    return None
