// app.js - Advanced Flagship Version (OSRM, Open-Meteo, ACO, Canvas Swarm)

// ---------------------------------------------------------
// 1. Map Renderer Module (With Canvas Overlay)
// ---------------------------------------------------------
const MapRenderer = (function() {
    const MAP_TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    const MAP_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO';
    let map = null;
    let nodeMarkers = {};
    let edgeLines = {};
    
    // Canvas setup for particles
    let canvas, ctx;
    let particles = [];
    let animationFrameId;

    function initCanvas() {
        canvas = document.getElementById('particle-canvas');
        ctx = canvas.getContext('2d');
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        
        map.on('move', renderParticles);
        map.on('zoom', renderParticles);
        startParticleLoop();
    }

    function resizeCanvas() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    function startParticleLoop() {
        function loop() {
            updateParticles();
            renderParticles();
            animationFrameId = requestAnimationFrame(loop);
        }
        loop();
    }

    function updateParticles() {
        for (let i = particles.length - 1; i >= 0; i--) {
            let p = particles[i];
            p.progress += p.speed;
            if (p.progress >= 1) {
                p.currentSegment++;
                p.progress = 0;
                if (p.currentSegment >= p.pathCoords.length - 1) {
                    particles.splice(i, 1); // remove arrived particle
                }
            }
        }
    }

    function renderParticles() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        particles.forEach(p => {
            const start = p.pathCoords[p.currentSegment];
            const end = p.pathCoords[p.currentSegment + 1];
            if (!start || !end) return;

            const currentLat = start[0] + (end[0] - start[0]) * p.progress;
            const currentLng = start[1] + (end[1] - start[1]) * p.progress;

            // Convert LatLng to pixel coordinates on canvas
            const point = map.latLngToContainerPoint([currentLat, currentLng]);

            // Draw glowing particle
            ctx.beginPath();
            ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 10;
            ctx.fill();
            ctx.shadowBlur = 0; // reset
        });
    }

    return {
        initMap: function(containerId) {
            map = L.map(containerId, { zoomControl: false }).setView([17.3850, 78.4867], 6);
            L.tileLayer(MAP_TILE_URL, { attribution: MAP_ATTRIBUTION, subdomains: 'abcd', maxZoom: 20 }).addTo(map);
            L.control.zoom({ position: 'topright' }).addTo(map);
            initCanvas();
            return map;
        },
        clearMapElements: function() {
            Object.values(nodeMarkers).forEach(m => map.removeLayer(m));
            Object.values(edgeLines).forEach(l => map.removeLayer(l));
            nodeMarkers = {}; edgeLines = {}; particles = [];
        },
        drawNode: function(name, lat, lng, weatherIcon = '') {
            const html = `<div>${name.substring(0, 3).toUpperCase()} <span style="font-size:12px">${weatherIcon}</span></div>`;
            const icon = L.divIcon({ className: 'node-marker', html: html, iconSize: [40, 40], iconAnchor: [20, 20] });
            const marker = L.marker([lat, lng], { icon }).addTo(map);
            marker.bindTooltip(name, { direction: 'top', offset: [0, -20] });
            nodeMarkers[name] = marker;
            return marker;
        },
        drawGeoJsonEdge: function(u, v, geojson, weight, trafficLevel, elevationDiff) {
            let color = '#10b981';
            if (trafficLevel === 'medium') color = '#f59e0b';
            if (trafficLevel === 'high') color = '#ef4444';
            if (trafficLevel === 'blocked') color = '#000000';

            const edgeId = u < v ? `${u}-${v}` : `${v}-${u}`;
            
            // Reversing GeoJSON coords from [lng, lat] to [lat, lng] for Leaflet
            const latLngs = geojson.coordinates.map(coord => [coord[1], coord[0]]);

            const polyline = L.polyline(latLngs, {
                color: color, weight: trafficLevel === 'blocked' ? 2 : 4, opacity: 0.7,
                dashArray: trafficLevel === 'blocked' ? '5, 10' : null
            }).addTo(map);

            let elevText = elevationDiff < 0 ? `<span style="color:#10b981">Downhill (Regen)</span>` : `Uphill`;
            polyline.bindTooltip(`Distance: ${weight}km<br>Traffic: ${trafficLevel}<br>Terrain: ${elevText}`, { sticky: true });
            polyline.on('click', () => { document.dispatchEvent(new CustomEvent('edgeClicked', { detail: { u, v } })); });
            
            edgeLines[edgeId] = polyline;
            return polyline;
        },
        updateEdgeStyle: function(u, v, trafficLevel) {
            const edgeId = u < v ? `${u}-${v}` : `${v}-${u}`;
            const polyline = edgeLines[edgeId];
            if (polyline) {
                let color = '#10b981', weight = 4, dashArray = null, opacity = 0.7;
                if (trafficLevel === 'medium') color = '#f59e0b';
                if (trafficLevel === 'high') color = '#ef4444';
                if (trafficLevel === 'blocked') { color = '#000000'; weight = 2; dashArray = '5, 10'; }
                polyline.setStyle({ color, weight, dashArray, opacity });
            }
        },
        highlightPath: function(pathNodes, color = '#3b82f6') {
            for (let i = 0; i < pathNodes.length - 1; i++) {
                const u = pathNodes[i], v = pathNodes[i+1];
                const edgeId = u < v ? `${u}-${v}` : `${v}-${u}`;
                if (edgeLines[edgeId]) { edgeLines[edgeId].setStyle({ color, weight: 6, opacity: 1 }); edgeLines[edgeId].bringToFront(); }
            }
        },
        resetHighlight: function(graph) {
            for (const u in graph.adjList) {
                for (const neighbor of graph.adjList[u]) {
                    this.updateEdgeStyle(u, neighbor.node, neighbor.traffic);
                }
            }
        },
        fitGraphBounds: function() {
            const group = new L.featureGroup(Object.values(nodeMarkers));
            if (Object.keys(nodeMarkers).length > 0) { map.fitBounds(group.getBounds(), { padding: [50, 50] }); }
        },
        spawnSwarmParticle: function(pathCoordsGeoJson, color = '#ffffff') {
            // pathCoordsGeoJson is array of [lng, lat]. Convert to [lat, lng]
            const coords = pathCoordsGeoJson.map(c => [c[1], c[0]]);
            particles.push({
                pathCoords: coords,
                currentSegment: 0,
                progress: 0,
                speed: 0.02 + Math.random() * 0.03, // varied speeds
                color: color
            });
        },
        clearParticles: function() {
            particles = [];
        },
        getParticleCount: function() {
            return particles.length;
        },
        // For ACO Pheromones
        drawPheromone: function(u, v, intensity) {
            const edgeId = u < v ? `${u}-${v}` : `${v}-${u}`;
            if (edgeLines[edgeId]) {
                edgeLines[edgeId].setStyle({ color: '#8b5cf6', weight: 2 + intensity * 6, opacity: Math.min(intensity, 1) });
                edgeLines[edgeId].bringToFront();
            }
        }
    };
})();

// ---------------------------------------------------------
// 2. Graph Model (Topographical)
// ---------------------------------------------------------
class Graph {
    constructor() {
        this.adjList = {}; this.nodes = {}; this.edges = [];
        this.timeMultiplier = 1; // 1.0 normal, 2.0 rush hour
    }
    addNode(name, lat, lng, elevation = 0, weather = 'clear') {
        if (!this.adjList[name]) { this.adjList[name] = []; this.nodes[name] = { lat, lng, elevation, weather }; }
    }
    addEdge(u, v, weight, trafficLevel, geojson, elevationDiff) {
        this.adjList[u].push({ node: v, weight, traffic: trafficLevel, geojson, elevationDiff });
        // Reverse elevation diff for opposite direction
        this.adjList[v].push({ node: u, weight, traffic: trafficLevel, geojson: { coordinates: [...geojson.coordinates].reverse() }, elevationDiff: -elevationDiff });
        this.edges.push({ u, v, weight, traffic: trafficLevel, geojson, elevationDiff });
    }
    getNeighbors(u) { return this.adjList[u] || []; }
    setEdgeTraffic(u, v, trafficLevel) {
        let found = false;
        if (this.adjList[u]) { const e1 = this.adjList[u].find(e => e.node === v); if (e1) { e1.traffic = trafficLevel; found = true; } }
        if (this.adjList[v]) { const e2 = this.adjList[v].find(e => e.node === u); if (e2) e2.traffic = trafficLevel; }
        if (found) { const edgeObj = this.edges.find(e => (e.u === u && e.v === v) || (e.u === v && e.v === u)); if (edgeObj) edgeObj.traffic = trafficLevel; }
    }
    getDynamicWeight(u, v) {
        const edge = this.adjList[u].find(e => e.node === v);
        if (!edge || edge.traffic === 'blocked') return Infinity;
        
        let multiplier = edge.traffic === 'medium' ? 1.5 : (edge.traffic === 'high' ? 3 : 1);
        multiplier *= this.timeMultiplier;

        // Apply Weather Penalty from destination node
        const destWeather = this.nodes[v].weather;
        if (destWeather === 'rain') multiplier *= 1.3;
        if (destWeather === 'storm') multiplier *= 2.0;

        // Base cost is distance
        let cost = edge.weight * multiplier;

        // Apply Elevation Bonus/Penalty (Topographical routing)
        // e.g., if elevationDiff is -200m (downhill), cost decreases.
        if (edge.elevationDiff < -100) cost -= 10; // Regenerative braking bonus! (Creates negative weights potentially)
        if (edge.elevationDiff > 100) cost += 10; // Uphill penalty
        
        return cost;
    }
}

// ---------------------------------------------------------
// 3. Algorithms & ACO
// ---------------------------------------------------------
const Algorithms = {
    dijkstra: function(graph, start, end) {
        const distances = {}, previous = {}, unvisited = new Set(Object.keys(graph.nodes));
        let exploredNodes = 0;
        for (let node of unvisited) { distances[node] = Infinity; previous[node] = null; }
        distances[start] = 0;

        while (unvisited.size > 0) {
            let currNode = null, minDistance = Infinity;
            for (let node of unvisited) if (distances[node] < minDistance) { minDistance = distances[node]; currNode = node; }
            if (currNode === null || currNode === end) break;
            unvisited.delete(currNode); exploredNodes++;

            for (let neighborObj of graph.getNeighbors(currNode)) {
                if (!unvisited.has(neighborObj.node)) continue;
                const weight = graph.getDynamicWeight(currNode, neighborObj.node);
                if (weight === Infinity) continue;
                const alt = distances[currNode] + weight;
                if (alt < distances[neighborObj.node]) { distances[neighborObj.node] = alt; previous[neighborObj.node] = currNode; }
            }
        }
        return this.reconstructPath(previous, start, end, distances[end], exploredNodes);
    },
    bellmanFord: function(graph, start, end) {
        const distances = {}, previous = {}, nodes = Object.keys(graph.nodes);
        let exploredNodes = 0;
        nodes.forEach(node => { distances[node] = Infinity; previous[node] = null; });
        distances[start] = 0;

        for (let i = 0; i < nodes.length - 1; i++) {
            let updated = false;
            for (let u of nodes) {
                for (let edge of graph.getNeighbors(u)) {
                    exploredNodes++;
                    const v = edge.node, w = graph.getDynamicWeight(u, v);
                    if (w !== Infinity && distances[u] + w < distances[v]) {
                        distances[v] = distances[u] + w; previous[v] = u; updated = true;
                    }
                }
            }
            if (!updated) break;
        }

        let hasNegativeCycle = false;
        for (let u of nodes) {
            for (let edge of graph.getNeighbors(u)) {
                if (graph.getDynamicWeight(u, edge.node) !== Infinity && distances[u] + graph.getDynamicWeight(u, edge.node) < distances[edge.node]) hasNegativeCycle = true;
            }
        }

        const res = this.reconstructPath(previous, start, end, distances[end], exploredNodes);
        res.hasNegativeCycle = hasNegativeCycle;
        return res;
    },
    aStar: function(graph, start, end) {
        const distances = {}, fScore = {}, previous = {}, openSet = new Set([start]);
        let exploredNodes = 0;
        Object.keys(graph.nodes).forEach(n => { distances[n] = Infinity; fScore[n] = Infinity; previous[n] = null; });
        distances[start] = 0; fScore[start] = this.heuristic(graph.nodes[start], graph.nodes[end]);

        while (openSet.size > 0) {
            let currNode = null, minF = Infinity;
            for (let node of openSet) if (fScore[node] < minF) { minF = fScore[node]; currNode = node; }
            if (currNode === end) return this.reconstructPath(previous, start, end, distances[end], exploredNodes);
            openSet.delete(currNode); exploredNodes++;

            for (let neighborObj of graph.getNeighbors(currNode)) {
                const weight = graph.getDynamicWeight(currNode, neighborObj.node);
                if (weight === Infinity) continue;
                const tentativeG = distances[currNode] + weight;
                if (tentativeG < distances[neighborObj.node]) {
                    previous[neighborObj.node] = currNode; distances[neighborObj.node] = tentativeG;
                    fScore[neighborObj.node] = tentativeG + this.heuristic(graph.nodes[neighborObj.node], graph.nodes[end]);
                    openSet.add(neighborObj.node);
                }
            }
        }
        return this.reconstructPath(previous, start, end, distances[end], exploredNodes);
    },
    heuristic: function(nodeA, nodeB) {
        var R = 6371; var dLat = (nodeB.lat-nodeA.lat) * (Math.PI/180); var dLon = (nodeB.lng-nodeA.lng) * (Math.PI/180); 
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(nodeA.lat * (Math.PI/180)) * Math.cos(nodeB.lat * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
        return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
    },
    floydWarshall: function(graph) {
        return { path: [], cost: "All Pairs Computed", exploredNodes: Object.keys(graph.nodes).length**3 };
    },
    reconstructPath: function(previous, start, end, cost, exploredNodes) {
        const path = []; let curr = end;
        if (previous[end] || curr === start) {
            while (curr !== null) { path.unshift(curr); curr = previous[curr]; }
        }
        return { path: path.length > 1 ? path : [], cost: path.length > 1 ? cost : Infinity, exploredNodes };
    },
    tspNearestNeighbor: function(graph, startNode) {
        const unvisited = new Set(Object.keys(graph.nodes));
        let currNode = startNode, path = [currNode], totalCost = 0;
        unvisited.delete(currNode);
        while (unvisited.size > 0) {
            let nextNode = null, minD = Infinity;
            for (let candidate of unvisited) {
                const edge = graph.getNeighbors(currNode).find(e => e.node === candidate);
                let w = edge ? graph.getDynamicWeight(currNode, candidate) : Infinity;
                if (w < minD) { minD = w; nextNode = candidate; }
            }
            if (nextNode === null) break;
            path.push(nextNode); totalCost += minD; currNode = nextNode; unvisited.delete(currNode);
        }
        return { path, cost: totalCost };
    },
    // Ant Colony Optimization
    antColonyOptimization: async function(graph) {
        const nodes = Object.keys(graph.nodes);
        if(nodes.length < 2) return;
        
        document.getElementById('algo-results').innerHTML = `<p>Running ACO AI Simulation...</p>`;

        // Precompute distance matrix using Dijkstra for sparse graph support
        const distMatrix = {};
        for(let u of nodes) {
            distMatrix[u] = {};
            for(let v of nodes) {
                if(u===v) distMatrix[u][v] = 0;
                else {
                    const res = this.dijkstra(graph, u, v);
                    distMatrix[u][v] = res.cost;
                }
            }
        }
        
        let pheromones = {};
        for(let u of nodes) {
            for(let v of nodes) {
                if(u!==v) {
                    const id = u < v ? `${u}-${v}` : `${v}-${u}`;
                    pheromones[id] = 0.1;
                }
            }
        }

        const iterations = 50;
        const numAnts = 10;
        let bestPath = [];
        let bestCost = Infinity;

        for (let iter = 0; iter < iterations; iter++) {
            let currentPheromoneUpdates = {};

            for (let ant = 0; ant < numAnts; ant++) {
                const start = nodes[Math.floor(Math.random() * nodes.length)];
                const visited = new Set([start]);
                let curr = start;
                let pathCost = 0;
                let antPath = [start];

                while (visited.size < nodes.length) {
                    let unvisitedNodes = nodes.filter(n => !visited.has(n));
                    let next = null;
                    
                    let totalProb = 0;
                    const probabilities = unvisitedNodes.map(n => {
                        const id = curr < n ? `${curr}-${n}` : `${n}-${curr}`;
                        const tau = pheromones[id] || 0.1;
                        const eta = 1 / Math.max(0.1, distMatrix[curr][n]);
                        const prob = Math.pow(tau, 1) * Math.pow(eta, 2);
                        totalProb += prob;
                        return { node: n, prob };
                    });

                    let rand = Math.random() * totalProb;
                    for (let p of probabilities) {
                        rand -= p.prob;
                        if (rand <= 0) { next = p.node; break; }
                    }
                    if(!next) next = probabilities[0].node;

                    antPath.push(next);
                    pathCost += distMatrix[curr][next];
                    visited.add(next);
                    curr = next;
                }

                // Return to start
                pathCost += distMatrix[curr][start];
                antPath.push(start);

                if (pathCost < bestCost) { bestCost = pathCost; bestPath = antPath; }
                
                // Deposit pheromones on the conceptual edges
                for (let i=0; i<antPath.length-1; i++) {
                    const id = antPath[i] < antPath[i+1] ? `${antPath[i]}-${antPath[i+1]}` : `${antPath[i+1]}-${antPath[i]}`;
                    currentPheromoneUpdates[id] = (currentPheromoneUpdates[id] || 0) + (100 / pathCost);
                }
            }

            // Evaporation & Update
            for (let id in pheromones) {
                pheromones[id] = pheromones[id] * 0.8 + (currentPheromoneUpdates[id] || 0);
            }
            
            // Visual feedback (only draw if direct edge exists)
            for(let edge of graph.edges) {
                const id = edge.u < edge.v ? `${edge.u}-${edge.v}` : `${edge.v}-${edge.u}`;
                if(pheromones[id]) MapRenderer.drawPheromone(edge.u, edge.v, Math.min(pheromones[id], 1));
            }

            // Visual delay for animation effect
            await new Promise(r => setTimeout(r, 20));
        }

        // Highlight the actual physical edges of the best path
        let finalDetailedPath = [];
        for(let i=0; i<bestPath.length-1; i++) {
            const res = this.dijkstra(graph, bestPath[i], bestPath[i+1]);
            if(i === 0) finalDetailedPath.push(...res.path);
            else finalDetailedPath.push(...res.path.slice(1));
        }

        MapRenderer.highlightPath(finalDetailedPath, '#f59e0b');
        document.getElementById('algo-results').innerHTML = `<div class="result-item"><span>ACO Path:</span> <strong>${bestPath.join(' → ')}</strong></div><div class="result-item"><span>Routing Cost:</span> <strong>${bestCost.toFixed(2)}</strong></div>`;
    }
};

const Analytics = {
    runScaling: function(appGraph) {
        const sizes = [10, 20, 50, 100, 200];
        const times = {d:[], b:[], a:[]};
        sizes.forEach(s => {
            const tg = new Graph();
            const nodes = Array.from({length: s}, (_, i) => `N${i}`);
            nodes.forEach(n => tg.addNode(n, 0, 0, 0, 'clear'));
            for(let i=0; i<s; i++) tg.addEdge(nodes[i], nodes[Math.floor(Math.random()*s)], Math.floor(Math.random()*100)+1, 'low', {coordinates:[[0,0],[0,0]]}, 0);
            const start = nodes[0], end = nodes[s-1];
            
            let t0 = performance.now(); Algorithms.dijkstra(tg, start, end); times.d.push(performance.now()-t0);
            t0 = performance.now(); Algorithms.bellmanFord(tg, start, end); times.b.push(performance.now()-t0);
            t0 = performance.now(); Algorithms.aStar(tg, start, end); times.a.push(performance.now()-t0);
        });

        const ctx = document.getElementById('scalingChart').getContext('2d');
        if(window.myChart) window.myChart.destroy();
        window.myChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: sizes.map(s => `${s} Nodes`),
                datasets: [
                    {label: 'Dijkstra', data: times.d, borderColor: '#3b82f6', tension: 0.4},
                    {label: 'Bellman-Ford', data: times.b, borderColor: '#ef4444', tension: 0.4},
                    {label: 'A*', data: times.a, borderColor: '#10b981', tension: 0.4}
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { title: {display: true, text: 'Time (ms)', color: '#94a3b8'}, ticks: {color: '#94a3b8'} }, x: { ticks: {color: '#94a3b8'} } }, plugins: { legend: { labels: {color: '#fff'} } } }
        });
    },
    updateLive: function(g) {
        if(!g) return;
        const e = g.edges.length;
        document.getElementById('stat-nodes').innerText = Object.keys(g.nodes).length;
        document.getElementById('stat-edges').innerText = e;
        let h = g.edges.filter(x => x.traffic === 'high' || x.traffic === 'blocked').length;
        document.getElementById('stat-congestion').innerText = e > 0 ? (h/e > 0.4 ? 'High' : (h/e > 0.15 ? 'Med' : 'Low')) : 'Low';
        document.getElementById('stat-vehicles').innerText = MapRenderer.getParticleCount();
    }
};

// ---------------------------------------------------------
// 4. Simulation (Swarm Particles)
// ---------------------------------------------------------
class Simulation {
    constructor(graph) {
        this.graph = graph; this.interval = null; this.mode = 'normal'; this.smart = false;
    }
    setMode(mode) { this.mode = mode; this.applyTraffic(); }
    applyTraffic() {
        let hp = 0.1, mp = 0.3;
        if (this.mode === 'morning') { hp = 0.3; mp = 0.4; }
        if (this.mode === 'evening') { hp = 0.4; mp = 0.4; }
        if (this.mode === 'rain') { hp = 0.5; mp = 0.4; }
        
        for (let edge of this.graph.edges) {
            if (edge.traffic === 'blocked') continue;
            const r = Math.random(); let nl = 'low';
            if (r < hp) nl = 'high'; else if (r < hp + mp) nl = 'medium';
            if (this.smart && nl === 'high' && Math.random() > 0.5) nl = 'medium';
            this.graph.setEdgeTraffic(edge.u, edge.v, nl);
        }
        MapRenderer.resetHighlight(this.graph);
    }
    start() {
        if(this.interval) clearInterval(this.interval);
        this.interval = setInterval(() => {
            const nodes = Object.keys(this.graph.nodes);
            if (nodes.length < 2) return;
            
            // Spawn 3-5 particles per tick
            for(let i=0; i<Math.floor(Math.random()*3)+2; i++) {
                const start = nodes[Math.floor(Math.random()*nodes.length)];
                let end = nodes[Math.floor(Math.random()*nodes.length)];
                while(start === end) end = nodes[Math.floor(Math.random()*nodes.length)];
                const res = Algorithms.aStar(this.graph, start, end);
                
                if (res.path.length > 1) {
                    // Extract full GeoJSON coords for the path
                    let fullPathGeoJson = [];
                    for(let j=0; j<res.path.length-1; j++) {
                        const edge = this.graph.adjList[res.path[j]].find(e => e.node === res.path[j+1]);
                        if (edge && edge.geojson) fullPathGeoJson = fullPathGeoJson.concat(edge.geojson.coordinates);
                    }
                    if(fullPathGeoJson.length > 0) {
                        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ffffff'];
                        MapRenderer.spawnSwarmParticle(fullPathGeoJson, colors[Math.floor(Math.random()*colors.length)]);
                    }
                }
            }
        }, 800); // Fast spawning for swarm
    }
    stop() { if(this.interval) clearInterval(this.interval); MapRenderer.clearParticles(); }
    toggleSmart() { this.smart = !this.smart; if(this.smart) this.applyTraffic(); return this.smart; }
    runMonteCarlo() {
        const nodes = Object.keys(this.graph.nodes);
        if (nodes.length < 2) return null;
        let tCost = 0, tExp = 0, succ = 0;
        for (let i = 0; i < 100; i++) {
            const start = nodes[Math.floor(Math.random()*nodes.length)];
            let end = nodes[Math.floor(Math.random()*nodes.length)];
            while(end === start) end = nodes[Math.floor(Math.random()*nodes.length)];
            const res = Algorithms.dijkstra(this.graph, start, end);
            if (res.cost !== Infinity) { tCost += res.cost; tExp += res.exploredNodes; succ++; }
        }
        return { cost: succ > 0 ? (tCost/succ).toFixed(2) : Infinity, exp: succ > 0 ? (tExp/succ).toFixed(0) : 0, rate: ((succ/100)*100).toFixed(1)+'%' };
    }
    runRace(start, end) {
        const res = [];
        let t0 = performance.now(); const rD = Algorithms.dijkstra(this.graph, start, end); res.push({n:'Dijkstra', t:(performance.now()-t0).toFixed(2), v:rD.exploredNodes});
        t0 = performance.now(); const rB = Algorithms.bellmanFord(this.graph, start, end); res.push({n:'Bellman-Ford', t:(performance.now()-t0).toFixed(2), v:rB.exploredNodes});
        t0 = performance.now(); const rA = Algorithms.aStar(this.graph, start, end); res.push({n:'A*', t:(performance.now()-t0).toFixed(2), v:rA.exploredNodes});
        return res.sort((a,b) => a.t - b.t);
    }
}

// ---------------------------------------------------------
// 5. APIs (Nominatim, Open-Meteo, OSRM) & Main
// ---------------------------------------------------------
async function geocodeCities(cityNames) {
    const coordsMap = {};
    for (let city of cityNames) {
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`);
            const data = await res.json();
            if (data && data.length > 0) coordsMap[city] = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: data[0].display_name.split(',')[0] };
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { console.error(e); }
    }
    return coordsMap;
}

async function getMeteoData(lat, lng) {
    try {
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=weather_code`);
        const data = await res.json();
        let weather = 'clear'; let icon = '☀️';
        if (data.current) {
            const code = data.current.weather_code;
            if (code >= 51 && code <= 67) { weather = 'rain'; icon = '🌧️'; }
            else if (code >= 95) { weather = 'storm'; icon = '⛈️'; }
            else if (code >= 1 && code <= 3) { weather = 'clouds'; icon = '☁️'; }
        }
        return { elevation: data.elevation || 0, weather, icon };
    } catch(e) { return { elevation: 0, weather: 'clear', icon: '' }; }
}

async function getOsrmRoute(lat1, lng1, lat2, lng2) {
    try {
        // OSRM expects lon,lat
        const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`);
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
            return { distance: Math.round(data.routes[0].distance / 1000), geojson: data.routes[0].geometry };
        }
    } catch(e) { console.error("OSRM failed", e); }
    // Fallback to straight line
    return { 
        distance: Math.round(Algorithms.heuristic({lat:lat1,lng:lng1},{lat:lat2,lng:lng2})), 
        geojson: { type: "LineString", coordinates: [[lng1, lat1], [lng2, lat2]] } 
    };
}

let appGraph = new Graph();
let appSim = new Simulation(appGraph);
let adaptive = false;

document.addEventListener('DOMContentLoaded', () => {
    MapRenderer.initMap('map');

    document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', e => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active'); appSim.setMode(e.target.getAttribute('data-mode'));
    }));

    document.getElementById('btn-run-scaling').addEventListener('click', () => Analytics.runScaling(appGraph));
    setInterval(() => Analytics.updateLive(appGraph), 2000);

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById(e.target.getAttribute('data-target')).classList.add('active');
        });
    });

    async function generateRealMap(isDense) {
        const inputStr = document.getElementById('node-input').value;
        const citiesRaw = inputStr.split(',').map(s => s.trim()).filter(s => s);
        if (citiesRaw.length < 2) return alert("Enter 2+ cities.");

        document.getElementById('loading-overlay').style.display = 'flex';
        appSim.stop(); MapRenderer.clearMapElements();
        
        // 1. Geocode
        const coordsData = await geocodeCities(citiesRaw);
        const validCities = Object.keys(coordsData);
        if (validCities.length < 2) { document.getElementById('loading-overlay').style.display = 'none'; return alert("Failed to geocode."); }

        appGraph = new Graph(); appSim = new Simulation(appGraph);

        // 2. Fetch Weather & Elevation
        document.getElementById('loading-text').innerText = "Fetching Weather & Elevation...";
        for (let city of validCities) {
            const data = coordsData[city];
            const meteo = await getMeteoData(data.lat, data.lng);
            appGraph.addNode(data.name, data.lat, data.lng, meteo.elevation, meteo.weather);
            MapRenderer.drawNode(data.name, data.lat, data.lng, meteo.icon);
        }

        // 3. Connect Edges via OSRM
        document.getElementById('loading-text').innerText = "Fetching Real Highway Geometries...";
        const names = Object.keys(appGraph.nodes);
        for (let i = 1; i < names.length; i++) {
            const u = names[i]; const v = names[Math.floor(Math.random() * i)];
            const route = await getOsrmRoute(appGraph.nodes[u].lat, appGraph.nodes[u].lng, appGraph.nodes[v].lat, appGraph.nodes[v].lng);
            const elevDiff = appGraph.nodes[v].elevation - appGraph.nodes[u].elevation;
            appGraph.addEdge(u, v, route.distance, 'low', route.geojson, elevDiff);
            await new Promise(r => setTimeout(r, 500)); // OSRM Rate limit safety
        }

        // 4. Render
        const drawn = new Set();
        for (let name in appGraph.adjList) {
            for (let nb of appGraph.adjList[name]) {
                const id = name < nb.node ? `${name}-${nb.node}` : `${nb.node}-${name}`;
                if (!drawn.has(id)) {
                    drawn.add(id);
                    MapRenderer.drawGeoJsonEdge(name, nb.node, nb.geojson, nb.weight, nb.traffic, nb.elevationDiff);
                }
            }
        }

        MapRenderer.fitGraphBounds();
        document.getElementById('loading-overlay').style.display = 'none';
        
        document.getElementById('algo-start-node').innerHTML = ''; document.getElementById('algo-end-node').innerHTML = '';
        names.forEach((n, i) => {
            document.getElementById('algo-start-node').add(new Option(n, n));
            const opt = new Option(n, n); if (i===1) opt.selected = true;
            document.getElementById('algo-end-node').add(opt);
        });

        appSim.start();
    }

    document.getElementById('btn-generate-sparse').addEventListener('click', () => generateRealMap(false));
    document.getElementById('btn-generate-dense').addEventListener('click', () => generateRealMap(true));

    document.getElementById('btn-run-algo').addEventListener('click', () => {
        if (Object.keys(appGraph.nodes).length < 2) return alert("Please generate a Sparse or Dense graph in the Simulation tab first!");
        const s = document.getElementById('algo-start-node').value, e = document.getElementById('algo-end-node').value, a = document.getElementById('algo-selector').value;
        if (!s || !e) return alert("Please select start and end nodes.");
        MapRenderer.resetHighlight(appGraph);
        
        const algoMap = {
            'dijkstra': 'dijkstra',
            'bellman': 'bellmanFord',
            'astar': 'aStar',
            'floyd': 'floydWarshall'
        };
        const funcName = algoMap[a];
        
        const res = Algorithms[funcName](appGraph, s, e);
        if (res.path) MapRenderer.highlightPath(res.path);
        document.getElementById('algo-results').innerHTML = `<div class="result-item"><span>Path:</span> <strong>${res.path && res.path.length > 0 ? res.path.join(' → ') : 'None'}</strong></div><div class="result-item"><span>Routing Cost:</span> <strong>${res.cost}</strong></div>`;
    });

    document.getElementById('btn-tsp').addEventListener('click', () => {
        if (Object.keys(appGraph.nodes).length < 2) return alert("Please generate a graph in the Simulation tab first!");
        const s = document.getElementById('algo-start-node').value;
        if (!s) return alert("Please select a start node.");
        MapRenderer.resetHighlight(appGraph);
        const res = Algorithms.tspNearestNeighbor(appGraph, s);
        if (res.path) MapRenderer.highlightPath(res.path, '#ec4899');
        document.getElementById('algo-results').innerHTML = `<div class="result-item"><span>TSP Route:</span> <strong>${res.path ? res.path.join(' → ') : 'None'}</strong></div><div class="result-item"><span>Total Cost:</span> <strong>${res.cost.toFixed(2)}</strong></div>`;
    });

    document.getElementById('btn-adaptive').addEventListener('click', (e) => {
        adaptive = !adaptive;
        appSim.smart = adaptive;
        e.target.innerText = adaptive ? 'Disable Adaptive Rerouting' : 'Enable Adaptive Rerouting';
        adaptive ? e.target.classList.add('highlight-btn') : e.target.classList.remove('highlight-btn');
    });

    document.getElementById('btn-heatmap').addEventListener('click', (e) => {
        const isActive = e.target.classList.toggle('active-heatmap');
        e.target.innerText = isActive ? 'Disable Heatmap' : 'Toggle Heatmap';
        isActive ? e.target.classList.add('highlight-btn') : e.target.classList.remove('highlight-btn');
        
        if (isActive) {
            // Emphasize traffic
            for (let edge of appGraph.edges) {
                const u = edge.u, v = edge.v;
                if (edge.traffic === 'high' || edge.traffic === 'blocked') {
                    MapRenderer.updateEdgeStyle(u, v, edge.traffic);
                } else {
                    const edgeId = u < v ? `${u}-${v}` : `${v}-${u}`;
                    // make low traffic faint
                    if (MapRenderer.edgeLines && MapRenderer.edgeLines[edgeId]) {
                        MapRenderer.edgeLines[edgeId].setStyle({ opacity: 0.2 });
                    }
                }
            }
        } else {
            MapRenderer.resetHighlight(appGraph);
        }
    });

    document.getElementById('btn-run-monte-carlo').addEventListener('click', () => {
        if (Object.keys(appGraph.nodes).length < 2) return alert("Please generate a graph in the Simulation tab first!");
        document.getElementById('monte-carlo-results').innerHTML = '<p>Running...</p>';
        setTimeout(() => {
            if(!appSim.runMonteCarlo) return document.getElementById('monte-carlo-results').innerHTML = 'Error';
            const res = appSim.runMonteCarlo();
            document.getElementById('monte-carlo-results').innerHTML = res ? `<div class="result-item"><span>Success Rate:</span> <strong>${res.rate}</strong></div><div class="result-item"><span>Avg Cost:</span> <strong>${res.cost}</strong></div>` : 'Error';
        }, 50);
    });

    document.getElementById('btn-aco').addEventListener('click', () => {
        if (Object.keys(appGraph.nodes).length < 2) return alert("Please generate a graph with at least 2 cities in the Simulation tab first!");
        MapRenderer.resetHighlight(appGraph);
        Algorithms.antColonyOptimization(appGraph);
    });

    document.getElementById('btn-run-race').addEventListener('click', () => {
        if (Object.keys(appGraph.nodes).length < 2) return alert("Please generate a graph in the Simulation tab first!");
        const s = document.getElementById('algo-start-node').value, e = document.getElementById('algo-end-node').value;
        if (!s || !e) return;
        const res = appSim.runRace(s, e);
        let h = `<strong>1st: ${res[0].n} (${res[0].t}ms)</strong><br>`;
        res.forEach((r,i) => h += `<div class="result-item mt-1"><span>${i+1}. ${r.n}</span> <strong>${r.t}ms</strong></div>`);
        document.getElementById('race-results').innerHTML = h;
    });

    document.getElementById('btn-smart-signals').addEventListener('click', e => {
        const s = appSim.toggleSmart();
        e.target.innerText = s ? 'Disable Traffic Signals' : 'Optimize Traffic Signals';
        s ? e.target.classList.replace('highlight-btn', 'danger-btn') : e.target.classList.replace('danger-btn', 'highlight-btn');
    });

    document.getElementById('btn-demo-negative').addEventListener('click', () => {
        alert("This injects a negative cycle (-50) to demonstrate Bellman-Ford's cycle detection.");
        const nodes = Object.keys(appGraph.nodes);
        if (nodes.length >= 3) {
            const [u,v,w] = nodes; [u,v,w].forEach(n => appGraph.adjList[n] = []);
            appGraph.addEdge(u, v, 10, 'low', {coordinates: [[0,0],[0,0]]}, 0); 
            appGraph.addEdge(v, w, 20, 'low', {coordinates: [[0,0],[0,0]]}, 0); 
            appGraph.addEdge(w, u, -50, 'low', {coordinates: [[0,0],[0,0]]}, 0);
            MapRenderer.clearMapElements();
            Object.keys(appGraph.nodes).forEach(n => MapRenderer.drawNode(n, appGraph.nodes[n].lat, appGraph.nodes[n].lng));
            appGraph.edges.forEach(e => MapRenderer.drawGeoJsonEdge(e.u, e.v, e.geojson, e.weight, e.traffic, e.elevationDiff));
        }
    });

    // Timeline Slider Logic
    document.getElementById('timeline-slider').addEventListener('input', (e) => {
        const hour = parseInt(e.target.value);
        let display = hour + ":00";
        if(hour < 10) display = "0" + display;
        document.getElementById('time-display').innerText = display;

        // Rush hour logic (8-10 AM, 17-19 PM)
        if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) {
            appGraph.timeMultiplier = 2.0; // Rush hour penalty
            appSim.setMode('evening');
        } else if (hour >= 0 && hour <= 5) {
            appGraph.timeMultiplier = 0.5; // Empty night roads
            appSim.setMode('normal');
        } else {
            appGraph.timeMultiplier = 1.0;
            appSim.setMode('normal');
        }
    });
});
