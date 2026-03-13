#!/bin/bash
# ──────────────────────────────────────────────────────────────
# Mock Docker CLI — simulates Docker daemon for testing
#
# Each container gets a root directory at $MOCK_DOCKER_ROOT/<name>/fs/
# All exec commands run in this root (paths rewritten).
# ──────────────────────────────────────────────────────────────

MOCK_DOCKER_ROOT="${MOCK_DOCKER_ROOT:-/tmp/mock-docker}"
mkdir -p "$MOCK_DOCKER_ROOT"

get_dir() { echo "$MOCK_DOCKER_ROOT/$1"; }
get_fs()  { echo "$MOCK_DOCKER_ROOT/$1/fs"; }
exists()  { [ -d "$(get_dir "$1")" ]; }
state()   { [ -f "$(get_dir "$1")/state" ] && cat "$(get_dir "$1")/state" || echo "nonexistent"; }

cmd="$1"; shift

case "$cmd" in

info)
  for a in "$@"; do [[ "$a" == *ServerVersion* ]] && echo "24.0.7-mock" && exit 0; done
  echo "Mock Docker"; exit 0 ;;

run)
  name="" image="" workdir="" detach=false envvars=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d) detach=true; shift ;;
      --name) name="$2"; shift 2 ;;
      --label) shift 2 ;;
      -e) envvars+=("$2"); shift 2 ;;
      -w) workdir="$2"; shift 2 ;;
      -*) if [[ -n "$2" && "$2" != -* ]]; then shift 2; else shift; fi ;;
      *) [ -z "$image" ] && image="$1"; shift ;;
    esac
  done
  [[ "$image" == *nonexistent* ]] && echo "Unable to find image '$image' locally" >&2 && exit 1
  [ -z "$name" ] && name="mock-$(head -c 4 /dev/urandom | xxd -p)"
  d="$(get_dir "$name")"
  fs="$(get_fs "$name")"
  mkdir -p "$d" "$fs/tmp" "$fs/workspace"
  echo "running" > "$d/state"
  echo "$image" > "$d/image"
  echo "${workdir:-/}" > "$d/workdir"
  printf '%s\n' "${envvars[@]}" > "$d/envvars"
  [ -n "$workdir" ] && mkdir -p "$fs$workdir"
  [ "$detach" = true ] && echo "$name"
  exit 0 ;;

exec)
  envs=() workdir="" container=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -e) envs+=("$2"); shift 2 ;;
      -w) workdir="$2"; shift 2 ;;
      -i|-t) shift ;;
      -*) if [[ -n "$2" && "$2" != -* ]]; then shift 2; else shift; fi ;;
      *) container="$1"; shift; break ;;
    esac
  done
  exists "$container" || { echo "Error: No such container: $container" >&2; exit 1; }
  [ "$(state "$container")" != "running" ] && echo "Error: Container not running" >&2 && exit 1

  fs="$(get_fs "$container")"
  # Load create-time env vars
  if [ -f "$(get_dir "$container")/envvars" ]; then
    while IFS= read -r ev; do
      [ -n "$ev" ] && export "${ev?}"
    done < "$(get_dir "$container")/envvars"
  fi
  # Load exec-time env vars (override create-time)
  for ev in "${envs[@]}"; do export "${ev?}"; done

  # Determine container working directory
  [ -z "$workdir" ] && workdir="$(cat "$(get_dir "$container")/workdir" 2>/dev/null)"
  [ -z "$workdir" ] && workdir="/"
  cwd="$fs$workdir"
  mkdir -p "$cwd" 2>/dev/null

  exec_cmd="$1"; shift
  case "$exec_cmd" in
    bash)
      if [ "$1" = "-c" ]; then
        shift
        bash_cmd="$1"

        # Export the container fs root so subshells can use it
        export __MOCK_FS="$fs"

        # Override key builtins to operate on container fs
        # pwd: strip fs prefix to show container-relative path
        pwd() {
          local real
          real="$(command pwd)"
          local rel="${real#$__MOCK_FS}"
          [ -z "$rel" ] && rel="/"
          echo "$rel"
        }
        export -f pwd

        cd "$cwd" 2>/dev/null || true

        # Rewrite absolute paths in the command to point to container fs
        # This handles: redirections (> /tmp/...), cat /tmp/..., etc.
        # Only rewrite /tmp/ and /workspace (common container paths used by the provider)
        # Rewrite ALL absolute /tmp/ and /workspace/ paths to container fs
        # Use sed for reliable multi-pattern replacement
        local_cmd="$(echo "$bash_cmd" | sed \
          -e "s|/tmp/|$fs/tmp/|g" \
          -e "s|/workspace|$fs/workspace|g" \
        )"

        eval "$local_cmd"
        exit $?
      fi
      ;;
    cat)
      # Rewrite path to container fs
      filepath="$1"
      if [[ "$filepath" == /* ]]; then
        cat "$fs$filepath"
      else
        cat "$filepath"
      fi
      exit $? ;;
    mkdir)
      # Rewrite paths to container fs
      args=() paths=()
      for a in "$@"; do
        if [[ "$a" == -* ]]; then args+=("$a")
        elif [[ "$a" == /* ]]; then paths+=("$fs$a")
        else paths+=("$a"); fi
      done
      command mkdir "${args[@]}" "${paths[@]}"
      exit $? ;;
    kill)
      command kill "$@" 2>/dev/null
      exit $? ;;
    ps)
      echo "    PID COMMAND         ARGS"
      echo "      1 sleep           sleep infinity"
      exit 0 ;;
    rm)
      # Rewrite paths
      args=() paths=()
      for a in "$@"; do
        if [[ "$a" == -* ]]; then args+=("$a")
        elif [[ "$a" == /* ]]; then paths+=("$fs$a")
        else paths+=("$a"); fi
      done
      command rm "${args[@]}" "${paths[@]}" 2>/dev/null
      exit $? ;;
    test)
      # Rewrite paths
      args=()
      for a in "$@"; do
        if [[ "$a" == /* && "$a" != -* ]]; then args+=("$fs$a")
        else args+=("$a"); fi
      done
      command test "${args[@]}"
      exit $? ;;
    *)
      "$exec_cmd" "$@"
      exit $? ;;
  esac ;;

cp)
  [ "$1" = "-" ] || exit 1
  shift
  target="$1"
  container="${target%%:*}"
  dest="${target#*:}"
  exists "$container" || { echo "Error: No such container: $container" >&2; exit 1; }
  fs="$(get_fs "$container")"
  # Extract tar into the container's fs root
  tar xf - -C "$fs$dest" 2>/dev/null
  exit $? ;;

rm)
  force=false; containers=()
  while [[ $# -gt 0 ]]; do
    case "$1" in -f) force=true; shift ;; *) containers+=("$1"); shift ;; esac
  done
  for c in "${containers[@]}"; do
    d="$(get_dir "$c")"
    [ -d "$d" ] && rm -rf "$d" || { [ "$force" = false ] && echo "Error: No such container: $c" >&2 && exit 1; }
  done
  exit 0 ;;

inspect)
  fmt="" container=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --format) fmt="$2"; shift 2 ;; *) container="$1"; shift ;; esac
  done
  exists "$container" || { echo "Error: No such container ($container)" >&2; exit 1; }
  s="$(state "$container")"
  [[ "$fmt" == *State.Status* ]] && echo "$s" && exit 0
  echo "{\"State\":{\"Status\":\"$s\"}}"; exit 0 ;;

pause)
  exists "$1" || { echo "Error: No such container: $1" >&2; exit 1; }
  echo "paused" > "$(get_dir "$1")/state"; echo "$1"; exit 0 ;;

unpause)
  exists "$1" || { echo "Error: No such container: $1" >&2; exit 1; }
  echo "running" > "$(get_dir "$1")/state"; echo "$1"; exit 0 ;;

start)
  exists "$1" || { echo "Error: No such container: $1" >&2; exit 1; }
  echo "running" > "$(get_dir "$1")/state"; echo "$1"; exit 0 ;;

port)
  exists "$1" || { echo "Error: No such container: $1" >&2; exit 1; }
  echo "Error: No public port '$2/tcp' published for $1" >&2; exit 1 ;;

*) echo "mock-docker: unknown command '$cmd'" >&2; exit 1 ;;
esac
