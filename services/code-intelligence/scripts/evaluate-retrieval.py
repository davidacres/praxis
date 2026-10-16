"""Evaluate an explicit labelled corpus against an already provisioned local index."""
import argparse
import hashlib
import json
import statistics
import subprocess
import time
from collections import Counter
from pathlib import Path, PurePosixPath

CATEGORIES = {"exact", "terminology", "behaviour", "crossProject", "negative", "stale"}


def score(expected, retrieved):
    """Unique relevant symbols; unlabelled/negative queries never earn recall."""
    expected = set(expected)
    ranked = retrieved[:10]
    if not expected:
        return {"recallAt10": None, "mrrAt10": None, "top1": None}
    relevant = expected.intersection(ranked)
    first = next((index + 1 for index, value in enumerate(ranked) if value in expected), None)
    return {"recallAt10": len(relevant) / len(expected), "mrrAt10": 1 / first if first else 0,
            "top1": bool(ranked and ranked[0] in expected)}


def validate(corpus):
    if not isinstance(corpus, dict) or corpus.get("version") != 1 or not isinstance(corpus.get("queries"), list):
        raise ValueError("Expected a version-1 corpus with a queries array.")
    queries = corpus["queries"]
    if not 1 <= len(queries) <= 1000:
        raise ValueError("Corpus must contain 1–1000 queries.")
    identifiers, texts = set(), {}
    for case in queries:
        if not isinstance(case, dict):
            raise ValueError("Every query must be an object.")
        if not isinstance(case.get("id"), str) or not case["id"] or case["id"] in identifiers:
            raise ValueError("Every query needs a unique nonempty id.")
        identifiers.add(case["id"])
        if case.get("category") not in CATEGORIES or case.get("split") not in {"tuning", "heldOut"}:
            raise ValueError("Unknown category or split: " + case["id"])
        text = case.get("query")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise ValueError("Invalid query text: " + case["id"])
        normalized = " ".join(text.lower().split())
        if normalized in texts:
            raise ValueError("Duplicate query text, including across splits: " + case["id"])
        texts[normalized] = case["id"]
        labels = case.get("expected")
        if not isinstance(labels, list) or len(labels) > 20:
            raise ValueError("Expected selectors array is required: " + case["id"])
        if case["category"] == "negative" and labels:
            raise ValueError("Negative queries cannot have positive relevance labels.")
        if case["category"] != "negative" and not labels:
            raise ValueError("Nonnegative queries need explicit current relevance labels.")
        if "ambiguousExact" in case and (case["category"] != "exact" or not isinstance(case["ambiguousExact"], bool)):
            raise ValueError("ambiguousExact is a boolean reserved for exact queries.")
        if case["category"] == "exact" and ((case.get("ambiguousExact") is True and len(labels) < 2)
                                                   or (case.get("ambiguousExact") is not True and len(labels) != 1)):
            raise ValueError("Exact queries require one label, or explicit ambiguity with multiple labels.")
        for label in labels:
            if not isinstance(label, dict) or set(label) - {"name", "qualifiedName", "signature", "contextId"} or any(
                    not isinstance(value, str) or not value for value in label.values()):
                raise ValueError("Invalid symbol selector: " + case["id"])
            if not label.get("name") or not label.get("qualifiedName"):
                raise ValueError("Labels require name and qualifiedName: " + case["id"])
        paths = case.get("expectedEvidence", [])
        if not isinstance(paths, list) or any(not isinstance(path, str) or not path or PurePosixPath(path).is_absolute()
                                               or ".." in PurePosixPath(path).parts or "\\" in path for path in paths):
            raise ValueError("Expected evidence must be an array of relative source paths.")
    review_count = corpus.get("reviewedExplanationCount", 0)
    if not isinstance(review_count, int) or isinstance(review_count, bool) or review_count < 0:
        raise ValueError("reviewedExplanationCount must be a nonnegative integer.")
    counts = Counter(case["category"] for case in queries)
    return {"sourceRevisionDeclared": isinstance(corpus.get("sourceRevision"), str) and bool(corpus["sourceRevision"].strip()),
            "nearDuplicateSplitReviewDeclared": corpus.get("nearDuplicateSplitReviewed") is True,
            "atLeast120Queries": len(queries) >= 120,
            "heldOutEveryCategory": all(any(case["category"] == category and case["split"] == "heldOut"
                                               for case in queries) for category in CATEGORIES),
            "atLeast20PerCategory": all(counts[category] >= 20 for category in CATEGORIES),
            "tuning40HeldOut80": sum(case["split"] == "tuning" for case in queries) == 40
            and sum(case["split"] == "heldOut" for case in queries) == 80,
            "reviewDeclared": corpus.get("reviewed") is True and isinstance(corpus.get("reviewedBy"), str) and bool(corpus["reviewedBy"].strip())
            and all(case.get("reviewed") is True and (case["category"] == "negative" or case.get("expectedEvidence")) for case in queries)}


def aggregate(results):
    summary = {}
    for mode in ("lexical", "hybrid"):
        for category in sorted(CATEGORIES | {"all"}):
            cases = [case for case in results if case["mode"] == mode and case["split"] == "heldOut"
                     and (category == "all" or case["category"] == category)]
            labelled = [case for case in cases if case["recallAt10"] is not None]
            times = sorted(case["latencyMs"] for case in cases)
            summary[f"{mode}/{category}"] = {
                "queries": len(cases), "labelledQueries": len(labelled),
                "errors": sum(bool(case.get("error")) for case in cases),
                "recallAt10": statistics.mean(case["recallAt10"] for case in labelled) if labelled else None,
                "mrrAt10": statistics.mean(case["mrrAt10"] for case in labelled) if labelled else None,
                "p95Ms": times[max(0, (95 * len(times) + 99) // 100 - 1)] if times else None}
    return summary


def evaluate(corpus, invoke):
    protocol = validate(corpus)
    labelled = {}
    for case in corpus["queries"]:
        ids = set()
        for selector in case["expected"]:
            found = invoke("find_symbol", {**selector, "limit": 50})
            items = found.get("data", {}).get("items", [])
            if found.get("error") or len(items) != 1:
                raise ValueError(f"Label {case['id']} must resolve to exactly one current symbol: {selector}")
            ids.add(items[0]["symbolId"])
        labelled[case["id"]] = ids
    before = invoke("get_index_status", {})
    if before.get("error"):
        raise ValueError("Cannot read index status: " + json.dumps(before["error"]))
    results = []
    for case in corpus["queries"]:
        for mode in ("lexical", "hybrid"):
            started = time.perf_counter()
            try:
                response = invoke("search_code", {"query": case["query"], "mode": mode, "limit": 10})
            except (subprocess.TimeoutExpired, OSError, ValueError) as error:
                response = {"error": {"code": type(error).__name__, "message": str(error)}}
            elapsed = (time.perf_counter() - started) * 1000
            data = response.get("data", {})
            matches = data.get("matches", [])
            ids = [match["symbol"]["symbolId"] for match in matches]
            evidence = {item["id"]: item for item in response.get("evidence", [])}
            missing_evidence = [match["symbol"]["symbolId"] for match in matches
                                if match["symbol"]["symbolId"] in labelled[case["id"]]
                                and not any(evidence.get(identity, {}).get("path") in case.get("expectedEvidence", [])
                                            for identity in match.get("evidenceIds", []))]
            results.append({"id": case["id"], "category": case["category"], "split": case["split"], "mode": mode,
                            "ambiguousExact": case.get("ambiguousExact", False),
                            **score(labelled[case["id"]], ids), "latencyMs": elapsed, "error": response.get("error"),
                            "indexGeneration": response.get("indexGeneration"), "queryEpoch": response.get("queryEpoch"),
                            "semanticAvailable": "vector" in data.get("channelsUsed", [])
                            and data.get("eligibleSymbolCount", 0) > 0
                            and data.get("vectorCoveredSymbolCount") == data.get("eligibleSymbolCount"),
                            "missingExpectedEvidence": missing_evidence,
                            "duplicateResults": len(ids) != len(set(ids)),
                            "retrieved": [{"symbolId": match["symbol"]["symbolId"],
                                           "qualifiedName": match["symbol"]["qualifiedName"]} for match in matches]})
    after = invoke("get_index_status", {})
    summary = aggregate(results)
    recall = summary["hybrid/all"]["recallAt10"]
    category_deltas = [summary[f"hybrid/{category}"]["recallAt10"] - summary[f"lexical/{category}"]["recallAt10"]
                       for category in CATEGORIES if summary[f"hybrid/{category}"]["recallAt10"] is not None]
    exact = [case for case in results if case["category"] == "exact" and case["mode"] == "hybrid" and case["split"] == "heldOut" and not case["ambiguousExact"]]
    ambiguous = [case for case in results if case["category"] == "exact" and case["mode"] == "hybrid"
                 and case["split"] == "heldOut" and case["ambiguousExact"]]
    contexts = before.get("data", {}).get("contexts", [])
    gates = {**protocol,
             "completeCompilerContexts": bool(contexts)
             and before.get("freshness", {}).get("state") == "current"
             and all(context.get("resolution") == "complete" for context in contexts),
             "stableSnapshot": not after.get("error") and before.get("indexGeneration") == after.get("indexGeneration")
             and before.get("queryEpoch") == after.get("queryEpoch")
             and all(case["indexGeneration"] == before.get("indexGeneration") and case["queryEpoch"] == before.get("queryEpoch") for case in results),
             "noToolErrors": all(not case["error"] for case in results),
             "noDuplicateResults": all(not case["duplicateResults"] for case in results),
             "fullSemanticCoverage": all(case["semanticAvailable"] for case in results if case["mode"] == "hybrid"),
             "exactTop1": bool(exact) and all(case["top1"] for case in exact),
             "ambiguousExactRecall": all(case["recallAt10"] == 1 for case in ambiguous),
             "heldOutRecallAtLeast080": recall is not None and recall >= .8,
             "noCategoryRegressionOver005": bool(category_deltas) and all(delta >= -.05 for delta in category_deltas),
             "expectedEvidencePresent": all(not case["missingExpectedEvidence"] for case in results),
             "negativeAbstentionReviewDeclared": corpus.get("negativeAbstentionReviewed") is True}
    generated_in_scope = corpus.get("generatedExplanationsInScope", True)
    if not isinstance(generated_in_scope, bool) or (not generated_in_scope and corpus.get("releaseMilestone") != "M3"):
        raise ValueError("Only an explicit M3 retrieval release may exclude generated explanations.")
    if generated_in_scope:
        gates["thirtyExplanationsReviewDeclared"] = corpus.get("reviewedExplanationCount", 0) >= 30
    return {"version": 1, "declaredSourceRevision": corpus.get("sourceRevision"),
            "generatedExplanationsInScope": generated_in_scope,
            "notApplicable": [] if generated_in_scope else ["Generated explanation review: M3 exposes deterministic structural facts; optional LLM generation is M5."],
            "measurement": "Sequential CLI/owner transport included; not the capacity performance protocol",
            "contexts": contexts,
            "before": {key: before.get(key) for key in ("indexGeneration", "queryEpoch")},
            "after": {key: after.get(key) for key in ("indexGeneration", "queryEpoch")},
            "summary": summary, "gates": gates, "passedDeclaredGates": all(gates.values()), "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not str(args.output).endswith(".praxis.json"):
        parser.error("Output must end in .praxis.json.")
    raw = args.corpus.read_bytes()
    if len(raw) > 4 * 1024 * 1024:
        parser.error("Corpus exceeds 4 MiB.")
    corpus = json.loads(raw)

    def invoke(tool, arguments):
        command = [str(args.executable.resolve()), "query", tool,
                   json.dumps({**arguments, "repositoryId": args.repository, "responseBudgetTokens": 8000}),
                   "--data", str(args.data.resolve())]
        process = subprocess.run(command, capture_output=True, text=True, timeout=125, check=False)
        response = json.loads(process.stdout)
        if not isinstance(response, dict) or response.get("schemaVersion") != "1.2":
            raise ValueError("Expected a schema-version 1.2 tool response.")
        if process.returncode and not response.get("error"):
            raise ValueError(f"CLI exited {process.returncode} without a tool error.")
        return response

    report = evaluate(corpus, invoke)
    report["corpusHash"] = "sha256:" + hashlib.sha256(raw).hexdigest()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "gates": report["gates"]}))
    return 0 if report["passedDeclaredGates"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
