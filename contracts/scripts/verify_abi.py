"""Compare the compiled wire ABI with the approved interface candidate (not a runtime test)."""
import json
from pathlib import Path

contracts = Path(__file__).resolve().parents[1]

def abi_type(item):
    if item["type"].startswith("tuple"):
        return "(" + ",".join(abi_type(c) for c in item["components"]) + ")" + item["type"][5:]
    return item["type"]

def wire(item):
    kind = item["type"]
    inputs = tuple(abi_type(a) for a in item.get("inputs", []))
    outputs = tuple(abi_type(a) for a in item.get("outputs", []))
    indices = tuple(a["indexed"] for a in item.get("inputs", [])) if kind == "event" else ()
    return (kind, item.get("name", ""), inputs, outputs, item.get("stateMutability"), indices, item.get("anonymous"))

for name in ["WalletDelegate", "SignaturePaymaster"]:
    expected = json.loads((contracts.parent / f"protocol/abi/{name}.v1.abi.json").read_text())
    actual = json.loads((contracts / f"out/{name}.sol/{name}.json").read_text())["abi"]
    expected_set, actual_set = set(map(wire, expected)), set(map(wire, actual))
    if expected_set != actual_set or len(actual_set) != len(actual):
        raise SystemExit(f"{name}: ABI mismatch; missing={expected_set-actual_set}, extra={actual_set-expected_set}, duplicate={len(actual_set)!=len(actual)}")
    print(f"{name}: {len(actual)} compiled ABI entries match candidate wire types, mutability, events and errors")

print("Parameter display names/internalType labels are not wire data; actual tuple components retain the approved order.")
