#!/bin/sh
# Bootstrap cannot depend on Node/npm already being present.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_dir=$(dirname -- "$script_dir")
existing_only=0
if [ "${1:-}" = '--existing' ]; then existing_only=1; shift; fi
action=${1:-}
case "$action" in node|npm|build|install) shift ;; *) echo 'Usage: with-node.sh [--existing] node|npm|build|install [arguments...]' >&2; exit 1 ;; esac
need_npm=0
case "$action" in npm|build|install) need_npm=1 ;; esac
if [ "$action" = install ]; then
  for argument do
    case "$argument" in --source-app|--source-app=*) existing_only=1; need_npm=0 ;; esac
  done
fi

node_release='node-v22.23.2-darwin-arm64'
node_sha256='61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6'
cache_root=${HARNESS_NODE_CACHE:-"$repo_dir/.data/node"}
selected_node=''
selected_npm=''
last_error=''

if [ "$existing_only" -eq 0 ]; then
  if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    echo 'WorkLog: 자동 Node 준비와 앱 빌드는 macOS Apple Silicon(arm64)을 지원합니다.' >&2
    exit 1
  fi
  command -v otool >/dev/null 2>&1 || { echo 'WorkLog: Xcode Command Line Tools의 otool이 필요합니다.' >&2; exit 1; }
fi
if [ "$need_npm" -eq 1 ] && [ -n "${NPM:-}" ]; then
  npm_override=$(command -v "$NPM" 2>/dev/null) || { printf '%s\n' "WorkLog: NPM 실행 파일을 찾을 수 없습니다: $NPM" >&2; exit 1; }
  [ -x "$npm_override" ] || { printf '%s\n' "WorkLog: NPM 실행 파일을 실행할 수 없습니다: $NPM" >&2; exit 1; }
fi

try_node() {
  candidate=$1
  resolved=$(command -v "$candidate" 2>/dev/null) || { last_error="실행 파일을 찾을 수 없습니다: $candidate"; return 1; }
  [ -x "$resolved" ] || { last_error="실행할 수 없습니다: $candidate"; return 1; }
  if [ "$existing_only" -eq 1 ]; then
    checked=$(NODE_NO_WARNINGS=1 "$resolved" "$script_dir/node-probe.cjs" 2>&1) || { last_error=$checked; return 1; }
  else
    checked=$(NODE_NO_WARNINGS=1 "$resolved" "$script_dir/node-probe.cjs" --portable 2>&1) || { last_error=$checked; return 1; }
  fi
  [ -x "$checked" ] || { last_error="Node 검사 결과가 올바르지 않습니다: $candidate"; return 1; }
  npm_candidate=''
  if [ "$need_npm" -eq 1 ]; then
    if [ -n "${NPM:-}" ]; then
      npm_candidate=$npm_override
    else
      npm_candidate="$(dirname -- "$checked")/npm"
    fi
    [ -x "$npm_candidate" ] || { last_error="이 Node의 npm을 찾을 수 없습니다: $npm_candidate (NPM으로 경로를 지정할 수 있습니다.)"; return 1; }
  fi
  selected_node=$checked
  selected_npm=$npm_candidate
}

explicit_node=${HARNESS_BUNDLE_NODE:-${NODE:-}}
if [ -n "$explicit_node" ]; then
  if ! try_node "$explicit_node"; then
    printf '%s\n' "WorkLog: 지정한 Node를 사용할 수 없습니다. $last_error" 'HARNESS_BUNDLE_NODE 또는 NODE에 호환되는 실행 파일 경로를 지정하세요.' >&2
    exit 1
  fi
else
  # A rejected automatic candidate must not hide another usable local runtime.
  if command -v node >/dev/null 2>&1; then
    if ! try_node node; then printf '%s\n' "WorkLog: PATH Node를 건너뜁니다. $last_error" >&2; fi
  fi
  if [ -z "$selected_node" ] && [ -n "${NVM_BIN:-}" ]; then try_node "$NVM_BIN/node" || :; fi
  if [ -z "$selected_node" ]; then
    for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node; do
      if try_node "$candidate"; then break; fi
    done
  fi
  if [ -z "$selected_node" ] && [ "$existing_only" -eq 1 ]; then
    try_node "$HOME/Applications/WorkLog.app/Contents/MacOS/node" || :
    if [ -z "$selected_node" ]; then try_node "$repo_dir/dist/WorkLog.app/Contents/MacOS/node" || :; fi
  fi
  if [ -z "$selected_node" ]; then try_node "$cache_root/$node_release/bin/node" || :; fi
fi

if [ -z "$selected_node" ]; then
  if [ "$existing_only" -eq 1 ] || [ "${HARNESS_NODE_DOWNLOAD:-1}" = 0 ]; then
    printf '%s\n' 'WorkLog: 사용 가능한 Node 22.17+를 찾지 못했습니다. NODE/HARNESS_BUNDLE_NODE 경로를 지정하거나 make build로 먼저 준비하세요. 자동 다운로드는 수행하지 않았습니다.' >&2
    exit 1
  fi
  mkdir -p "$cache_root"
  cache_root=$(CDPATH= cd -- "$cache_root" && pwd -P)
  destination="$cache_root/$node_release"
  # Never replace an unknown or damaged cache directory as a side effect of bootstrap.
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    printf '%s\n' "WorkLog: 기존 Node 캐시를 사용할 수 없습니다. 보존했습니다: $destination" "다른 HARNESS_NODE_CACHE 또는 Node 경로를 지정하세요. $last_error" >&2
    exit 1
  fi
  lock_dir="$cache_root/.bootstrap-lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "WorkLog: Node 준비 잠금을 확인하세요: $lock_dir (다른 설치가 진행 중일 수 있습니다.)" >&2
    exit 1
  fi
  staging=''
  cleanup() { if [ -n "$staging" ]; then rm -rf -- "$staging"; fi; rmdir "$lock_dir"; }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    printf '%s\n' "WorkLog: 다른 실행이 Node 캐시를 준비했습니다. 다시 실행하세요: $destination" >&2
    exit 1
  fi
  staging=$(mktemp -d "$cache_root/.download.XXXXXX")
  archive="$staging/$node_release.tar.gz"
  printf '%s\n' "WorkLog: Node 22.23.2를 준비합니다: $destination" >&2
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 2 \
    --output "$archive" "https://nodejs.org/dist/v22.23.2/$node_release.tar.gz"
  actual_sha256=$(shasum -a 256 "$archive")
  actual_sha256=${actual_sha256%% *}
  if [ "$actual_sha256" != "$node_sha256" ]; then echo 'WorkLog: Node 다운로드 SHA-256이 일치하지 않습니다. 설치하지 않았습니다.' >&2; exit 1; fi
  tar -xzf "$archive" -C "$staging"
  try_node "$staging/$node_release/bin/node" || { printf '%s\n' "WorkLog: 다운로드한 Node 검증 실패. $last_error" >&2; exit 1; }
  mv "$staging/$node_release" "$destination"
  try_node "$destination/bin/node" || { printf '%s\n' "WorkLog: Node 캐시 검증 실패. $last_error" >&2; exit 1; }
  cleanup
  trap - EXIT INT TERM
fi

PATH="$(dirname -- "$selected_node"):$PATH"
HARNESS_BUNDLE_NODE=$selected_node
export PATH HARNESS_BUNDLE_NODE
printf '%s\n' "WorkLog: Node 재사용 $selected_node" >&2
if [ "$action" = build ]; then
  "$selected_npm" ci
  exec "$selected_npm" run build:mac
fi
if [ "$action" = install ]; then
  if [ "$need_npm" -eq 1 ]; then "$selected_npm" ci; fi
  exec "$selected_node" "$script_dir/install-source.mjs" "$@"
fi
if [ "$action" = npm ]; then exec "$selected_npm" "$@"; fi
exec "$selected_node" "$@"
