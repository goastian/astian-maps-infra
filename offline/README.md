# Paquetes regionales offline

El formato v1 activa una región únicamente después de verificar, en este orden:

1. esquema y rutas relativas seguras;
2. firma Ed25519 del manifiesto canónico;
3. tamaño y SHA-256 de mapa, índice de búsqueda y grafo de routing;
4. cabecera PMTiles v3 y versión de los índices Astian.

Una descarga incompleta o alterada nunca reemplaza la región activa. El cliente
conserva hasta dos `rollbackPackageIds`, descarga a un directorio temporal y
hace el cambio de puntero sólo después del gate completo.

Construcción reproducible (la clave privada vive en KMS/HSM o en un secreto de
release, nunca en Git):

```bash
node infra/offline/build-package.mjs \
  --package-id monaco.2026-07-29.v1 \
  --region-id monaco \
  --region-name Monaco \
  --bounds 7.409,43.724,7.440,43.755 \
  --map data/tiles/planet.pmtiles \
  --search infra/offline/fixtures/monaco/search-index.json \
  --routing infra/offline/fixtures/monaco/routing-graph.json \
  --private-key /run/secrets/offline-signing-key.pem \
  --key-id offline-release-2026-01 \
  --created-at 2026-07-29T00:00:00Z \
  --data-timestamp 2026-07-18T00:00:00Z \
  --output dist/offline/monaco.2026-07-29.v1
```

Verificación independiente:

```bash
node infra/offline/verify-package.mjs \
  dist/offline/monaco.2026-07-29.v1/package-manifest.json \
  infra/offline/keys/offline-release-2026-01.public.pem
```

Los JSON pequeños incluidos para Monaco son fixtures de aceptación. Un release
regional real reemplaza esos archivos por índices generados desde la misma
instantánea OSM que PMTiles; la firma garantiza coherencia e integridad, no la
calidad o actualidad del dataset.
