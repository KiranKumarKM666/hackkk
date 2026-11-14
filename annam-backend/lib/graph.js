// Road network as a graph: junctions = nodes, roads = edges with travel minutes.
// Demo graph is a 6x7 grid (42 nodes). To use real roads, load an OpenStreetMap
// extract into the same {nodes, adj} shape.
const MinHeap = require('./minheap');
const SPEED_KMH = 25;

function hav(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

class RoadGraph {
  constructor({ lat0, lng0, rows, cols, step }) {
    this.nodes = []; this.adj = []; this.cache = new Map();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      this.nodes.push({ id: r * cols + c, lat: lat0 + r * step, lng: lng0 + c * step });
      this.adj.push([]);
    }
    const link = (a, b) => {
      const A = this.nodes[a], B = this.nodes[b];
      const km = hav(A.lat, A.lng, B.lat, B.lng);
      const congestion = 1 + ((a * 7 + b * 13) % 5) / 10; // deterministic 1.0-1.4
      const min = (km / SPEED_KMH) * 60 * congestion;
      this.adj[a].push({ to: b, km, min });
      this.adj[b].push({ to: a, km, min });
    };
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      if (c + 1 < cols) link(id, id + 1);
      if (r + 1 < rows) link(id, id + cols);
    }
  }
  nearest(lat, lng) {
    let best = 0, bd = Infinity;
    for (const n of this.nodes) {
      const d = hav(lat, lng, n.lat, n.lng);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  }
  // Dijkstra with a min-heap. Returns {minutes, km, path}.
  shortest(from, to) {
    if (from === to) return { minutes: 0, km: 0, path: [from] };
    const key = from + '>' + to;
    if (this.cache.has(key)) return this.cache.get(key);
    const n = this.nodes.length;
    const dist = new Array(n).fill(Infinity), km = new Array(n).fill(0), prev = new Array(n).fill(-1);
    dist[from] = 0;
    const h = new MinHeap(); h.push(0, from);
    while (h.size) {
      const { key: d, value: u } = h.pop();
      if (d > dist[u]) continue;
      if (u === to) break;
      for (const e of this.adj[u]) {
        const nd = d + e.min;
        if (nd < dist[e.to]) { dist[e.to] = nd; km[e.to] = km[u] + e.km; prev[e.to] = u; h.push(nd, e.to); }
      }
    }
    const path = []; for (let v = to; v !== -1; v = prev[v]) path.push(v); path.reverse();
    const res = { minutes: dist[to], km: km[to], path };
    this.cache.set(key, res);
    return res;
  }
  minutes(a, b) { return this.shortest(a, b).minutes; }
  edgeList() {
    const out = [];
    this.adj.forEach((list, a) => list.forEach(e => { if (a < e.to) out.push({ from: a, to: e.to, minutes: +e.min.toFixed(2) }); }));
    return out;
  }
}

const roads = new RoadGraph({ lat0: 12.93, lng0: 77.56, rows: 6, cols: 7, step: 0.012 });
module.exports = { RoadGraph, roads, hav, SPEED_KMH };
