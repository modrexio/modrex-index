#!/usr/bin/env bash

set -euo pipefail

tag=${1:?usage: publish-release-asset.sh <tag> <file>}
source_file=${2:?usage: publish-release-asset.sh <tag> <file>}
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
[[ -f "$source_file" ]] || { echo "Asset does not exist: $source_file" >&2; exit 1; }

asset_name=$(basename "$source_file")
run_id=${GITHUB_RUN_ID:-local}
run_attempt=${GITHUB_RUN_ATTEMPT:-1}
staged_name="${asset_name}.${run_id}.${run_attempt}.staged"
backup_name="${asset_name}.${run_id}.${run_attempt}.previous"
staged_file="$(dirname "$source_file")/$staged_name"
local_size=$(stat -c '%s' "$source_file")
local_digest="sha256:$(sha256sum "$source_file" | awk '{print $1}')"

cp "$source_file" "$staged_file"
trap 'rm -f "$staged_file"' EXIT
release_json=''

fetch_release() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if release_json=$(gh api "repos/$repo/releases/tags/$tag"); then return 0; fi
    echo "Release lookup attempt $attempt failed; retrying." >&2
    sleep $((attempt * 10))
  done
  return 1
}

asset_json_by_name() {
  jq -c --arg name "$1" '.assets[] | select(.name == $name)' <<<"$release_json" | tail -n 1
}

staged_asset_is_valid() {
  local asset_json
  fetch_release || return 1
  asset_json=$(asset_json_by_name "$staged_name")
  [[ -n "$asset_json" ]] &&
    [[ $(jq -r '.state' <<<"$asset_json") == uploaded ]] &&
    [[ $(jq -r '.size' <<<"$asset_json") == "$local_size" ]] &&
    [[ $(jq -r '.digest // empty' <<<"$asset_json") == "$local_digest" ]]
}

wait_for_staged_asset() {
  local attempt
  for attempt in 1 2 3 4 5; do
    staged_asset_is_valid && return 0
    sleep $((attempt * 5))
  done
  return 1
}

delete_asset_by_name() {
  local asset_json asset_id
  fetch_release || return 1
  asset_json=$(asset_json_by_name "$1")
  [[ -n "$asset_json" ]] || return 0
  asset_id=$(jq -r '.id' <<<"$asset_json")
  gh api --method DELETE "repos/$repo/releases/assets/$asset_id" >/dev/null
}

rename_asset() {
  local asset_id=$1 new_name=$2 attempt actual_name
  for attempt in 1 2 3 4 5; do
    if gh api --method PATCH "repos/$repo/releases/assets/$asset_id" -f name="$new_name" >/dev/null; then
      return 0
    fi

    # A 5xx can arrive after GitHub applied the rename, so check before retrying.
    if fetch_release; then
      actual_name=$(jq -r --argjson id "$asset_id" \
        '.assets[] | select(.id == $id) | .name' <<<"$release_json")
      [[ "$actual_name" == "$new_name" ]] && return 0
    fi
    echo "Rename attempt $attempt failed for asset $asset_id; retrying." >&2
    sleep $((attempt * 10))
  done
  return 1
}

# Upload under a unique name first. A failed upload cannot remove the live asset.
uploaded=0
for attempt in 1 2 3 4 5; do
  if gh release upload "$tag" "$staged_file" || wait_for_staged_asset; then
    uploaded=1
    break
  fi

  # GitHub can leave an incomplete "starter" asset after an upstream failure.
  delete_asset_by_name "$staged_name" || true
  echo "Staged upload attempt $attempt failed; the live $asset_name was not touched." >&2
  sleep $((attempt * 15))
done

if [[ "$uploaded" != 1 ]] || ! wait_for_staged_asset; then
  echo "Could not upload and verify $asset_name; the live asset was not touched." >&2
  exit 1
fi

staged_json=$(asset_json_by_name "$staged_name")
staged_id=$(jq -r '.id' <<<"$staged_json")
old_json=$(asset_json_by_name "$asset_name")
old_id=''

if [[ -n "$old_json" ]]; then
  old_id=$(jq -r '.id' <<<"$old_json")
  if ! rename_asset "$old_id" "$backup_name"; then
    echo "Could not preserve the current $asset_name; leaving it unchanged." >&2
    exit 1
  fi
fi

if ! rename_asset "$staged_id" "$asset_name"; then
  echo "Could not promote the staged $asset_name; restoring the previous asset." >&2
  if [[ -n "$old_id" ]] && ! rename_asset "$old_id" "$asset_name"; then
    echo "Rollback failed. The previous asset is still available as $backup_name." >&2
  fi
  exit 1
fi

if [[ -n "$old_id" ]]; then
  gh api --method DELETE "repos/$repo/releases/assets/$old_id" >/dev/null ||
    echo "Warning: could not remove backup asset $backup_name." >&2
fi

echo "Published and verified $asset_name."
