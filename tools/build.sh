#!/usr/bin/env bash
# Builds dist/SupernoteKOSync-<version>.snplg: runs the tests, bundles the JS, compiles the
# native module and verifies the package before copying it out.
#
# Needs Node 22+, a JDK 17+ and an Android SDK (platform 35, build-tools 35, NDK).
# Set JAVA_HOME / ANDROID_HOME, or put them in ~/.cache/supernote-build/env.json:
#   {"JAVA_HOME": "...", "ANDROID_HOME": "..."}
#
#   tools/build.sh            release package
#   tools/build.sh --harness  developer package with the device test harness (tools/device.py)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS=false
[[ "${1:-}" == "--harness" ]] && HARNESS=true
PLUGIN="$ROOT/plugin"
ENV_FILE="${SUPERNOTE_BUILD_ENV:-$HOME/.cache/supernote-build/env.json}"
if [[ -z "${JAVA_HOME:-}" || -z "${ANDROID_HOME:-}" ]] && [[ -f "$ENV_FILE" ]]; then
  export JAVA_HOME="${JAVA_HOME:-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["JAVA_HOME"])' "$ENV_FILE")}"
  export ANDROID_HOME="${ANDROID_HOME:-$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["ANDROID_HOME"])' "$ENV_FILE")}"
fi
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 17+}"
: "${ANDROID_HOME:?Set ANDROID_HOME to an Android SDK}"
export ANDROID_SDK_ROOT="$ANDROID_HOME" PATH="$JAVA_HOME/bin:$PATH"

cd "$PLUGIN"
[[ -d node_modules ]] || npm ci
npm test
npx tsc --noEmit

rm -rf build android/app/build
FLAGS=src/buildFlags.ts
cp "$FLAGS" "$FLAGS.release"
trap 'mv "$PLUGIN/$FLAGS.release" "$PLUGIN/$FLAGS"' EXIT
if $HARNESS; then
  sed -i.bak 's/DEVELOPER_HARNESS = false/DEVELOPER_HARNESS = true/' "$FLAGS" && rm -f "$FLAGS.bak"
fi
bash ./buildPlugin.sh "$PLUGIN" 2>&1 | tee "$ROOT/dist-build.log" >/dev/null || true

VERSION="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
NAME="$(python3 -c 'import json;print(json.load(open("package.json"))["name"])')"
PKG="build/outputs/$NAME.snplg"
[[ -f "$PKG" ]] || { echo "Build failed: no package (see dist-build.log)" >&2; exit 1; }
python3 - "$PKG" <<'PY'
import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = set(z.namelist())
cfg = json.loads(z.read("PluginConfig.json"))
problems = []
if cfg.get("nativeCodePackage") != "/app.npk" or "app.npk" not in names:
    problems.append("native module (app.npk) missing")
if not any(n.endswith(".bundle") for n in names):
    problems.append("JavaScript bundle missing")
npk = zipfile.ZipFile(z.open("app.npk")) if "app.npk" in names else None
if npk and not any("KosyncModule" in n or n.endswith(".dex") for n in npk.namelist()):
    problems.append("native classes missing")
if problems:
    sys.exit("Package check failed: " + ", ".join(problems))
print("Package check passed:", sorted(names))
PY
mkdir -p "$ROOT/dist"
SUFFIX=""; $HARNESS && SUFFIX="-harness"
OUT="SupernoteKOSync-$VERSION$SUFFIX.snplg"
cp "$PKG" "$ROOT/dist/$OUT"
( cd "$ROOT/dist" && shasum -a 256 "$OUT" > "$OUT.sha256" )
mv "$ROOT/dist-build.log" "$ROOT/dist/build.log"
echo "Built dist/$OUT"
