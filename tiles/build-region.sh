#!/usr/bin/env bash
set -euo pipefail

region="${1:-monaco}"
output_dir="${2:-data/tiles}"
planetiler_image="${PLANETILER_IMAGE:-ghcr.io/onthegomap/planetiler:0.10.2}"
mkdir -p "$output_dir"

profile_args=()
if [[ "$region" == "monaco" ]]; then
  # Keep the Phase 0 smoke build small. These fixtures are maintained by the
  # pinned Planetiler release and avoid downloading the global support layers.
  source_dir="${output_dir}/sources"
  natural_earth_path="${source_dir}/natural_earth_vector.sqlite.zip"
  mkdir -p "$source_dir"
  if [[ ! -f "$natural_earth_path" ]]; then
    curl --fail --silent --show-error --location --retry 3 \
      --output "${natural_earth_path}.partial" \
      "https://github.com/onthegomap/planetiler/raw/v0.10.2/planetiler-core/src/test/resources/natural_earth_vector.sqlite.zip"
    mv -- "${natural_earth_path}.partial" "$natural_earth_path"
  fi
  profile_args+=(
    "--water-polygons-url=https://github.com/onthegomap/planetiler/raw/v0.10.2/planetiler-core/src/test/resources/water-polygons-split-3857.zip"
    "--natural-earth-path=/data/sources/natural_earth_vector.sqlite.zip"
  )
fi

docker run --rm \
  -v "$PWD/$output_dir:/data" \
  "$planetiler_image" \
  --download \
  --area="$region" \
  --output="/data/planet.pmtiles" \
  "${profile_args[@]}" \
  --force

printf 'Built %s/planet.pmtiles from the %s extract\n' "$output_dir" "$region"
