#!/usr/bin/env python3
"""Non-streaming Ollama benchmark for JYN_OS and SVL CoreOS 2 (stdlib only)."""
import argparse
import json
import re
import statistics
import sys
import time
import urllib.request


def post(host, path, data, timeout):
    req = urllib.request.Request(host.rstrip("/") + path,
        data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        result = json.load(response)
    if not isinstance(result, dict) or result.get("error"):
        raise RuntimeError(f"{path}: {result}")
    return result


def measure(host, model, prompt, ctx, predict, timeout):
    start = time.monotonic()
    result = post(host, "/api/chat", {
        "model": model, "stream": False, "keep_alive": -1,
        "messages": [{"role": "user", "content": prompt}],
        "options": {"num_ctx": ctx, "num_predict": predict, "temperature": 0.3,
                    "top_p": 0.85, "num_batch": 512}
    }, timeout)
    wall = time.monotonic() - start
    reply = result.get("message", {}).get("content", "")
    if result.get("done") is not True or not isinstance(reply, str) or not reply.strip():
        raise RuntimeError("Incomplete or empty response")
    actual = result.get("routed_model") or result.get("model")
    if actual != model or result.get("substituted"):
        raise RuntimeError(f"Unexpected model: {actual!r} (requested {model})")
    count = result.get("eval_count", 0)
    eval_ns = result.get("eval_duration", 0)
    if not isinstance(count, (int, float)) or not isinstance(eval_ns, (int, float)) or count <= 0 or eval_ns <= 0:
        raise RuntimeError("Ollama did not report usable generation metrics")
    return {"wall_s": round(wall, 3), "load_s": round(result.get("load_duration", 0) / 1e9, 3),
            "prompt_eval_s": round(result.get("prompt_eval_duration", 0) / 1e9, 3),
            "tokens": count, "tokens_per_s": round(count * 1e9 / eval_ns, 2),
            "done_reason": result.get("done_reason"), "truncated": result.get("done_reason") == "length"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="http://127.0.0.1:11434")
    parser.add_argument("--model", default="svl364-apex-uncensored:latest")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--ctx", type=int, default=2048)
    parser.add_argument("--predict", type=int, default=768)
    parser.add_argument("--timeout", type=float, default=300)
    args = parser.parse_args()
    if not 2 <= args.runs <= 20 or not 512 <= args.ctx <= 32768 or not 1 <= args.predict <= args.ctx or args.timeout <= 0:
        parser.error("Invalid benchmark parameters")
    try:
        show = post(args.host, "/api/show", {"model": args.model}, min(args.timeout, 30))
        size = str(show.get("details", {}).get("parameter_size", ""))
        if args.model.startswith("svl364-apex-uncensored") and not re.fullmatch(r"7[01](?:\.\d+)?\s*B", size, re.I):
            raise RuntimeError(f"Apex 70B not verified; reported parameter_size={size!r}")
        print(json.dumps({"model": args.model, "parameter_size": size,
                          "quantization": show.get("details", {}).get("quantization_level")}, ensure_ascii=False), flush=True)
        rows = []
        for i in range(args.runs):
            row = measure(args.host, args.model,
                          "Wyjaśnij po polsku różnicę między RAM a VRAM w kontekście lokalnego modelu AI.",
                          args.ctx, args.predict, args.timeout)
            rows.append(row)
            print(json.dumps({"run": i + 1, **row}, ensure_ascii=False), flush=True)
        warm = rows[1:]
        print(json.dumps({"warm_median_wall_s": statistics.median(r["wall_s"] for r in warm),
                          "warm_median_tokens_per_s": statistics.median(r["tokens_per_s"] for r in warm),
                          "any_truncated": any(r["truncated"] for r in rows)}))
        return 2 if any(r["truncated"] for r in rows) else 0
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        print(f"Benchmark failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
