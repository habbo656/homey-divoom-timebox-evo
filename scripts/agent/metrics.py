"""Agent run metrics: build, validate and index the records published on gh-pages (deterministic, no model).

  metrics.py run OUT ARTIFACTS key=value…   pipeline run record from the run context and the stage records
  metrics.py uat OUT ARTIFACTS key=value…   UAT verdict record (agent-uat.yml)
  metrics.py validate FILE                  exit 0 and print the record's file name, or exit 2 with the violations
  metrics.py index ROOT                     rebuild ROOT/data/index.json from ROOT/data/runs/

ARTIFACTS is the folder the workflow downloaded its artifacts to; every ARTIFACTS/*/metrics.json is a stage record
written by .github/actions/claude. A stage record that does not validate is left out; the run record must validate
against .github/agent/metrics.schema.json as a whole or it is not written (exit 2). Every string in a record needs an
enum, a const or a pattern in the schema: the site is public and gets no free text. docs/pipeline.md, Run metrics.
"""
import json
import math
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCHEMA = os.path.join(ROOT, ".github", "agent", "metrics.schema.json")
STAGES = ["refine", "develop", "review", "hwtest", "uat", "screen", "other"]
INTS = {"run_id", "run_attempt", "issue", "pr", "round", "rejected"}
BOOLS = {"gate"}
RUN_KEYS = {"run_id", "run_attempt", "issue", "pr", "round", "kind", "path", "risk", "size", "gate", "review", "hwtest", "status"}
UAT_KEYS = {"run_id", "run_attempt", "issue", "pr", "milestone", "verdict", "rejected", "gate", "status"}
KEYWORDS = {"$schema", "$defs", "$ref", "title", "description", "oneOf", "type", "const", "enum", "pattern", "minimum",
            "maximum", "maxItems", "items", "properties", "required", "additionalProperties"}
TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
}


class SchemaError(Exception):
    pass


def same(a, b):
    return type(a) is type(b) and a == b


def errors(value, schema, root, path="$"):
    """The violations of value against schema (the subset of JSON Schema that metrics.schema.json uses)."""
    unknown = set(schema) - KEYWORDS
    if unknown:
        raise SchemaError(f"unsupported keywords {sorted(unknown)} at {path}")
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].removeprefix("#/").split("/"):
            node = node[part]
        return errors(value, node, root, path)
    if "oneOf" in schema:
        n = sum(not errors(value, s, root, path) for s in schema["oneOf"])
        return [] if n == 1 else [f"{path}: matches {n} of the oneOf schemas"]
    errs = []
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(TYPES[t](value) for t in types):
            return [f"{path}: wrong type"]
    if "const" in schema and not same(value, schema["const"]):
        errs.append(f"{path}: not the constant")
    if "enum" in schema and not any(same(value, e) for e in schema["enum"]):
        errs.append(f"{path}: not in the enum")
    if isinstance(value, str):
        if not ({"enum", "const", "pattern"} & set(schema)):
            raise SchemaError(f"string without enum, const or pattern at {path} (no free text)")
        # fullmatch: a trailing newline cannot slip past "$".
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            errs.append(f"{path}: does not match the pattern")
    if TYPES["number"](value):
        if isinstance(value, float) and not math.isfinite(value):
            errs.append(f"{path}: not finite")
        if "minimum" in schema and value < schema["minimum"]:
            errs.append(f"{path}: below the minimum")
        if "maximum" in schema and value > schema["maximum"]:
            errs.append(f"{path}: above the maximum")
    if isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errs.append(f"{path}: too many items")
        for i, item in enumerate(value):
            errs += errors(item, schema.get("items", {}), root, f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in value:
                errs.append(f"{path}: missing {k}")
        for k, v in value.items():
            if k in props:
                errs += errors(v, props[k], root, f"{path}.{k}")
            elif schema.get("additionalProperties", True) is False:
                # The key itself is untrusted: name it only when it is a plain identifier.
                errs.append(f"{path}: unexpected field {k if re.fullmatch(r'[a-z_]{1,40}', str(k)) else '(not shown)'}")
    return errs


def schema():
    return json.load(open(SCHEMA))


def validate(record):
    s = schema()
    return errors(record, s, s)


def convert(key, value):
    if value == "":
        return None
    if key in INTS:
        return int(value) if re.fullmatch(r"[0-9]{1,15}", value) else value
    if key in BOOLS:
        return {"true": True, "false": False}.get(value, value)
    return value


def context_size():
    out = subprocess.run(["bash", os.path.join(HERE, "context-size.sh")], capture_output=True, text=True, cwd=ROOT)
    sizes = dict(line.split("=", 1) for line in out.stdout.splitlines() if "=" in line)
    keys = ["total", "claude_md", "agents", "prompts", "skills", "docs"]
    return {k: int(sizes[k]) if sizes.get(k, "").isdigit() else 0 for k in keys}


def prompt_commit():
    """The newest commit that changed what the agents are told: definitions, prompt templates, CLAUDE.md."""
    out = subprocess.run(["git", "log", "-1", "--format=%H", "--", ".claude/agents", ".github/agent", "CLAUDE.md"],
                         capture_output=True, text=True, cwd=ROOT)
    sha = out.stdout.strip()[:12]
    return sha if re.fullmatch(r"[0-9a-f]{12}", sha) else None


def load(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return None


def stages(artifacts):
    s = schema()
    found = []
    for name in sorted(os.listdir(artifacts)) if os.path.isdir(artifacts) else []:
        rec = load(os.path.join(artifacts, name, "metrics.json"))
        if rec is None:
            continue
        errs = errors(rec, s["$defs"]["stage"], s)
        if errs:
            print(f"::warning::stage record in {name!r} left out: {'; '.join(errs[:5])}", file=sys.stderr)
            continue
        found.append(rec)
    return sorted(found, key=lambda r: STAGES.index(r["stage"]))


def review_counts(artifacts):
    r = load(os.path.join(artifacts, "review", "review.json"))
    r = r if isinstance(r, dict) else {}
    return {f"review_{k}": r.get(k) if TYPES["integer"](r.get(k)) else None for k in ("blockers", "majors", "minors")}


def build(kind, artifacts, pairs):
    allowed = RUN_KEYS if kind == "run" else UAT_KEYS
    ctx = {}
    for pair in pairs:
        k, _, v = pair.partition("=")
        if k not in allowed:
            raise SystemExit(f"metrics.py: unknown key {k!r}")
        ctx[k] = convert(k, v)
    rec = {"schema": 1, "type": kind}
    rec.update({k: None for k in allowed})
    rec.update(ctx)
    rec["timestamp"] = int(time.time())
    rec["prompt_commit"] = prompt_commit()
    rec["context"] = context_size()
    rec["stages"] = stages(artifacts)
    if kind == "run":
        rec["round"] = rec["round"] or 1
        rec.update(review_counts(artifacts))
    rec["status"] = rec["status"] or "failed"
    return rec


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd in ("run", "uat"):
        out, artifacts = argv[2], argv[3]
        rec = build(cmd, artifacts, argv[4:])
        errs = validate(rec)
        if errs:
            print("::error::metrics record rejected: " + "; ".join(errs[:10]), file=sys.stderr)
            return 2
        json.dump(rec, open(out, "w"), separators=(",", ":"), sort_keys=True)
        return 0
    if cmd == "validate":
        rec = load(argv[2])
        errs = ["$: not JSON"] if rec is None else validate(rec)
        if errs:
            print("metrics record rejected: " + "; ".join(errs[:10]), file=sys.stderr)
            return 2
        print(f"{rec['run_id']}-{rec['run_attempt']}.json")
        return 0
    if cmd == "index":
        runs = os.path.join(argv[2], "data", "runs")
        names = sorted(n for n in os.listdir(runs) if re.fullmatch(r"[0-9]{1,15}-[0-9]{1,6}\.json", n))
        json.dump({"schema": 1, "runs": names}, open(os.path.join(argv[2], "data", "index.json"), "w"), indent=0)
        return 0
    print(__doc__, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
