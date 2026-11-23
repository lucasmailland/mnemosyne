#!/usr/bin/env bash
# validate.sh — Grafana dashboard provisioning validator
#
# Checks:
#   1. dashboards.yml is present (provider config)
#   2. All *.json files are valid JSON
#   3. All dashboards have a non-empty "uid" field
#   4. All dashboard UIDs are unique
#   5. All datasource refs in panels use "${datasource}" (not hardcoded UIDs)
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAIL=0
UID_LIST_FILE="$(mktemp)"
PY_CHECKER="$(mktemp /tmp/ds_check_XXXXXX.py)"
trap 'rm -f "${UID_LIST_FILE}" "${PY_CHECKER}"' EXIT

# Write the Python datasource-check script to a temp file
cat > "${PY_CHECKER}" << 'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

violations = []

def walk(obj, path=""):
    if isinstance(obj, dict):
        if obj.get("type") == "datasource" and "uid" in obj:
            uid_val = obj["uid"]
            allowed = {"${datasource}", "-- Grafana --", "${DS_PROMETHEUS}"}
            if uid_val not in allowed and not uid_val.startswith("${"):
                violations.append(f"{path}.uid = {uid_val!r}")
        for k, v in obj.items():
            walk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            walk(v, f"{path}[{i}]")

walk(data)
for v in violations:
    print(v)
PYEOF

# ── Check 1: dashboards.yml present ──────────────────────────────────────────
if [[ ! -f "${SCRIPT_DIR}/dashboards.yml" ]]; then
  echo "ERROR: dashboards.yml not found in ${SCRIPT_DIR}" >&2
  FAIL=1
else
  echo "OK: dashboards.yml present"
fi

# ── Check 2+3+5: JSON validity, uid presence, datasource refs ────────────────
for json_file in "${SCRIPT_DIR}"/*.json; do
  filename="$(basename "${json_file}")"

  # Check 2: valid JSON
  if ! python3 -c "import json,sys; json.load(sys.stdin)" < "${json_file}" 2>/dev/null; then
    echo "ERROR: ${filename} is not valid JSON" >&2
    FAIL=1
    continue
  fi
  echo "OK: ${filename} — valid JSON"

  # Check 3: uid field present and non-empty
  uid="$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('uid',''))" < "${json_file}")"
  if [[ -z "${uid}" ]]; then
    echo "ERROR: ${filename} is missing a non-empty 'uid' field" >&2
    FAIL=1
    continue
  fi
  echo "OK: ${filename} — uid=${uid}"

  # Accumulate UIDs for uniqueness check (check 4)
  echo "${uid}:${filename}" >> "${UID_LIST_FILE}"

  # Check 5: datasource refs use template variable, not hardcoded strings
  bad_refs="$(python3 "${PY_CHECKER}" "${json_file}")"
  if [[ -n "${bad_refs}" ]]; then
    echo "ERROR: ${filename} has hardcoded datasource UIDs (expected \${datasource}):" >&2
    echo "${bad_refs}" | sed 's/^/  /' >&2
    FAIL=1
  else
    echo "OK: ${filename} — datasource refs use template variable"
  fi
done

# ── Check 4: unique UIDs ──────────────────────────────────────────────────────
if [[ -f "${UID_LIST_FILE}" && -s "${UID_LIST_FILE}" ]]; then
  duplicate_uids="$(cut -d: -f1 "${UID_LIST_FILE}" | sort | uniq -d)"
  if [[ -n "${duplicate_uids}" ]]; then
    while IFS= read -r dup_uid; do
      files_with_dup="$(grep "^${dup_uid}:" "${UID_LIST_FILE}" | cut -d: -f2 | tr '\n' ' ')"
      echo "ERROR: duplicate uid '${dup_uid}' found in: ${files_with_dup}" >&2
      FAIL=1
    done <<< "${duplicate_uids}"
  else
    echo "OK: all dashboard UIDs are unique"
  fi
fi

# ── Check 6: prometheus-rules.yml is valid YAML with 'groups' key ────────────
RULES_FILE="${SCRIPT_DIR}/../prometheus-rules.yml"
if [[ ! -f "${RULES_FILE}" ]]; then
  echo "ERROR: prometheus-rules.yml not found at ${RULES_FILE}" >&2
  FAIL=1
elif ! python3 -c "import yaml" 2>/dev/null; then
  # "Cannot check" is not "check failed". This block used to hide the real error
  # behind 2>/dev/null and report the FILE as invalid, so a machine whose python3
  # simply lacks PyYAML was told its Prometheus rules were broken. On this repo's
  # own macOS default (/usr/bin/python3) that is the normal case.
  echo "SKIP: prometheus-rules.yml — python3 has no PyYAML, cannot parse it here" >&2
  echo "      (install it, or use a python3 that has it, to enable this check)" >&2
else
  yaml_error="$(python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "${RULES_FILE}" 2>&1)" || {
    echo "ERROR: prometheus-rules.yml is not valid YAML:" >&2
    echo "${yaml_error}" >&2
    FAIL=1
  }
  if [[ "${FAIL}" -eq 0 ]]; then
    echo "OK: prometheus-rules.yml — valid YAML"
    has_groups="$(python3 -c "import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); print('yes' if 'groups' in d else 'no')" "${RULES_FILE}" 2>/dev/null)"
    if [[ "${has_groups}" != "yes" ]]; then
      echo "ERROR: prometheus-rules.yml missing top-level 'groups' key" >&2
      FAIL=1
    else
      echo "OK: prometheus-rules.yml — has 'groups' key"
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ "${FAIL}" -eq 0 ]]; then
  echo "All Grafana dashboard checks passed."
  exit 0
else
  echo "One or more Grafana dashboard checks FAILED." >&2
  exit 1
fi
