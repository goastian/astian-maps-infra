import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyOfflinePackage } from "./package-format.mjs";

export async function openOfflineRegion(manifest, packageRoot, publicKeyPem) {
  const verification = await verifyOfflinePackage(manifest, packageRoot, publicKeyPem);
  if (!verification.ok) {
    throw new Error(`Offline package rejected: ${verification.errors.join("; ")}`);
  }
  const [searchIndex, routingGraph] = await Promise.all([
    readJson(resolve(packageRoot, manifest.artifacts.search.path)),
    readJson(resolve(packageRoot, manifest.artifacts.routing.path)),
  ]);
  return Object.freeze({ manifest, searchIndex, routingGraph });
}

export function searchOffline(searchIndex, query, limit = 10) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) return [];
  const queryTokens = normalizedQuery.split(" ");
  return searchIndex.places
    .map((place) => {
      const candidate = normalizeText(place.normalizedName || place.name);
      const matchingTokens = queryTokens.filter((token) => candidate.includes(token)).length;
      const score = candidate === normalizedQuery
        ? 100
        : candidate.startsWith(normalizedQuery)
          ? 80
          : matchingTokens * 10;
      return { place, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.place.name.localeCompare(right.place.name))
    .slice(0, limit)
    .map(({ place }) => place);
}

export function routeOffline(routingGraph, request) {
  if (!routingGraph.profiles.includes(request.profile)) {
    throw new TypeError(`Offline profile is unavailable: ${request.profile}`);
  }
  if (!Array.isArray(request.waypoints) || request.waypoints.length < 2 || request.waypoints.length > 10) {
    throw new TypeError("Offline routes require 2 to 10 waypoints.");
  }
  const graph = buildAdjacency(routingGraph);
  const snapped = request.waypoints.map((waypoint) => nearestNode(routingGraph.nodes, waypoint));
  const routeNodeIds = [];
  let distanceMeters = 0;
  let durationSeconds = 0;
  for (let index = 0; index < snapped.length - 1; index += 1) {
    const leg = shortestPath(graph, snapped[index].id, snapped[index + 1].id);
    if (!leg) throw new Error(`No offline route from ${snapped[index].id} to ${snapped[index + 1].id}.`);
    routeNodeIds.push(...(index === 0 ? leg.nodeIds : leg.nodeIds.slice(1)));
    distanceMeters += leg.distanceMeters;
    durationSeconds += leg.durationSeconds;
  }
  const nodesById = new Map(routingGraph.nodes.map((node) => [node.id, node]));
  return {
    regionId: routingGraph.regionId,
    profile: request.profile,
    distanceMeters,
    durationSeconds,
    snappedWaypointIds: snapped.map((node) => node.id),
    geometry: routeNodeIds.map((id) => {
      const node = nodesById.get(id);
      return { latitude: node.latitude, longitude: node.longitude };
    }),
  };
}

function buildAdjacency(routingGraph) {
  const adjacency = new Map(routingGraph.nodes.map((node) => [node.id, []]));
  for (const edge of routingGraph.edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) {
      throw new Error(`Offline routing edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
    adjacency.get(edge.from).push(edge);
    if (edge.bidirectional) {
      adjacency.get(edge.to).push({ ...edge, from: edge.to, to: edge.from });
    }
  }
  return adjacency;
}

function shortestPath(adjacency, startId, destinationId) {
  const best = new Map([[startId, { distanceMeters: 0, durationSeconds: 0, nodeIds: [startId] }]]);
  const pending = new Set(adjacency.keys());
  while (pending.size > 0) {
    const currentId = [...pending].reduce((winner, candidate) => {
      if (!best.has(candidate)) return winner;
      if (!winner || best.get(candidate).distanceMeters < best.get(winner).distanceMeters) return candidate;
      return winner;
    }, null);
    if (!currentId) return null;
    if (currentId === destinationId) return best.get(currentId);
    pending.delete(currentId);
    const current = best.get(currentId);
    for (const edge of adjacency.get(currentId)) {
      if (!pending.has(edge.to)) continue;
      const candidateDistance = current.distanceMeters + edge.distanceMeters;
      const previous = best.get(edge.to);
      if (!previous || candidateDistance < previous.distanceMeters) {
        best.set(edge.to, {
          distanceMeters: candidateDistance,
          durationSeconds: current.durationSeconds + edge.durationSeconds,
          nodeIds: [...current.nodeIds, edge.to],
        });
      }
    }
  }
  return null;
}

function nearestNode(nodes, waypoint) {
  if (!Number.isFinite(waypoint?.latitude) || !Number.isFinite(waypoint?.longitude)) {
    throw new TypeError("Offline waypoints require WGS84 coordinates.");
  }
  return nodes.reduce((nearest, node) => {
    const distance = squaredDistance(node, waypoint);
    return !nearest || distance < nearest.distance ? { node, distance } : nearest;
  }, null).node;
}

function squaredDistance(left, right) {
  const latitude = left.latitude - right.latitude;
  const longitude = (left.longitude - right.longitude) * Math.cos((right.latitude * Math.PI) / 180);
  return latitude * latitude + longitude * longitude;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
