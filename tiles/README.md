# OpenMapTiles pipeline

The Phase 0 smoke path uses Planetiler's maintained OpenMapTiles profile and a
small Geofabrik region:

```bash
infra/tiles/build-region.sh monaco
```

The smoke build writes `data/tiles/planet.pmtiles`; start Martin with:

```bash
docker compose --profile geodata up martin
```

For Monaco the script uses Planetiler's versioned miniature water and Natural
Earth fixtures, so the smoke path does not download the global support layers.
Other regions intentionally use the complete upstream sources.

Production does not build inside the serving cluster. A scheduled, isolated
builder downloads a pinned OSM planet snapshot, produces a versioned PMTiles
artifact, validates representative tiles and uploads it to S3-compatible object
storage. Martin instances receive a new immutable URL only after validation.
The previous two manifests remain available for rollback.

The smoke script pins Planetiler `0.10.2`. Override `PLANETILER_IMAGE` only in
a reviewed dependency update; production builders must additionally pin the
container digest in their deployment manifest.

Every release has a JSON manifest based on
`release-manifest.schema.json`. Validate it before changing the active CDN
pointer:

```bash
node infra/tiles/validate-manifest.mjs path/to/release.json
```

Changing the small active manifest, rather than overwriting a PMTiles object,
makes promotion atomic and rollback deterministic.

Every published TileJSON must include the OSM and OpenMapTiles attribution and
the source snapshot timestamp. Weekly rebuild is the initial service objective.
