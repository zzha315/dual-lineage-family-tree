(function () {
  let disposeCurrent = null;

  function hashUnit(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 10000) / 10000;
  }

  function relationKey(relation) {
    if (relation.type === "sibling" || relation.type === "spouse") {
      return [relation.type, relation.fromPersonId, relation.toPersonId].sort().join(":");
    }
    return `${relation.type}:${relation.fromPersonId}:${relation.toPersonId}:${relation.role}`;
  }

  function buildGraph(persons, relations) {
    const adjacency = new Map(persons.map((person) => [person.id, []]));
    const unique = [];
    const seen = new Set();

    relations.forEach((relation) => {
      if (!adjacency.has(relation.fromPersonId) || !adjacency.has(relation.toPersonId)) return;
      const key = relationKey(relation);
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(relation);

      if (relation.type === "parent") {
        adjacency.get(relation.fromPersonId).push({
          id: relation.toPersonId,
          delta: -1,
          hint: "child",
        });
        adjacency.get(relation.toPersonId).push({
          id: relation.fromPersonId,
          delta: 1,
          hint: relation.role,
        });
      } else {
        adjacency.get(relation.fromPersonId).push({
          id: relation.toPersonId,
          delta: 0,
          hint: relation.type,
        });
        adjacency.get(relation.toPersonId).push({
          id: relation.fromPersonId,
          delta: 0,
          hint: relation.type,
        });
      }
    });

    return { adjacency, relations: unique };
  }

  function firstSector(neighbor, index, count) {
    if (neighbor.hint === "father") return -1.1;
    if (neighbor.hint === "mother") return 1.1;
    if (neighbor.hint === "spouse") return Math.PI;
    if (neighbor.hint === "sibling") return Math.PI / 2 + index * 0.42;
    return (index / Math.max(count, 1)) * Math.PI * 2;
  }

  function numericGeneration(person) {
    if (person?.generationLevel === null || person?.generationLevel === undefined) return null;
    const value = Number(person.generationLevel);
    return Number.isFinite(value) ? value : null;
  }

  function numericBirthYear(person) {
    if (person?.birthTimeType !== "exact") return null;
    const value = Number(person.birthYear);
    return Number.isFinite(value) ? value : null;
  }

  function computeLayout(persons, adjacency, focusId) {
    const personMap = new Map(persons.map((person) => [person.id, person]));
    const focus = personMap.get(focusId) || persons[0];
    const focusLevel = numericGeneration(focus);
    const exactYears = persons.map(numericBirthYear).filter((year) => year !== null);
    const minYear = exactYears.length ? Math.min(...exactYears) : null;
    const maxYear = exactYears.length ? Math.max(...exactYears) : null;
    const yearRange = minYear !== null && maxYear !== null ? Math.max(1, maxYear - minYear) : 1;
    const traversal = new Map();
    const queue = [];

    if (focus) {
      traversal.set(focus.id, { distance: 0, generation: 0, sector: 0 });
      queue.push(focus.id);
    }

    while (queue.length) {
      const currentId = queue.shift();
      const current = traversal.get(currentId);
      const neighbors = [...(adjacency.get(currentId) || [])].sort((a, b) => a.id.localeCompare(b.id));
      neighbors.forEach((neighbor, index) => {
        if (traversal.has(neighbor.id)) return;
        traversal.set(neighbor.id, {
          distance: current.distance + 1,
          generation: current.generation + neighbor.delta,
          sector:
            current.distance === 0
              ? firstSector(neighbor, index, neighbors.length)
              : current.sector,
        });
        queue.push(neighbor.id);
      });
    }

    const positions = new Map();
    persons.forEach((person, index) => {
      if (person.id === focus?.id) {
        positions.set(person.id, { x: 0, y: 0, z: 0 });
        return;
      }

      const info = traversal.get(person.id);
      const distance = info?.distance ?? 5 + (index % 3);
      const personLevel = numericGeneration(person);
      const generation =
        personLevel !== null && focusLevel !== null
          ? personLevel - focusLevel
          : (info?.generation ?? 0);
      const birthYear = numericBirthYear(person);
      const birthOldness =
        birthYear !== null && maxYear !== null ? (maxYear - birthYear) / yearRange : 0;
      const ancestorDepth = Math.max(0, generation);
      const descendantDepth = Math.max(0, -generation);
      const relationDepth = Math.min(distance, 6);
      const radius =
        2.35 +
        relationDepth * 0.95 +
        ancestorDepth * 1.35 +
        descendantDepth * 0.42 +
        birthOldness * 1.35;
      const yLimit = radius * 0.74;
      const y = Math.max(-yLimit, Math.min(yLimit, generation * 1.65));
      const horizontal = Math.sqrt(Math.max(0.8, radius * radius - y * y));
      const sector = info?.sector ?? hashUnit(person.id) * Math.PI * 2;
      const spread =
        (hashUnit(`${person.id}:spread`) - 0.5) *
        (distance === 1 ? 0.5 : 1.1) +
        ancestorDepth * 0.08;
      const angle = sector + spread;
      positions.set(person.id, {
        x: Math.cos(angle) * horizontal,
        y: y + (hashUnit(`${person.id}:height`) - 0.5) * 0.7,
        z: Math.sin(angle) * horizontal,
      });
    });
    return positions;
  }

  function mount(container, graph, options) {
    disposeCurrent?.();
    let disposed = false;
    const persons = graph.persons || [];
    const personMap = new Map(persons.map((person) => [person.id, person]));
    const built = buildGraph(persons, graph.relations || []);
    let focusId = personMap.has(graph.focusId) ? graph.focusId : persons[0]?.id;
    let targetPositions = computeLayout(persons, built.adjacency, focusId);
    const currentPositions = new Map();
    targetPositions.forEach((position, id) => {
      currentPositions.set(id, { ...position });
    });

    const canvas = document.createElement("canvas");
    canvas.className = "star-canvas";
    container.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    const tooltip = document.createElement("div");
    tooltip.className = "star-tooltip";
    container.appendChild(tooltip);

    let width = 1;
    let height = 1;
    let yaw = -0.35;
    let pitch = -0.12;
    let zoom = 1;
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    let hoveredId = "";
    let projectedNodes = [];

    const backgroundStars = Array.from({ length: 260 }, (_, index) => ({
      x: hashUnit(`star-x-${index}`),
      y: hashUnit(`star-y-${index}`),
      alpha: 0.18 + hashUnit(`star-a-${index}`) * 0.5,
      size: 0.35 + hashUnit(`star-s-${index}`) * 1.25,
    }));

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(container.clientWidth, 1);
      height = Math.max(container.clientHeight, 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function rotate(point) {
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const x1 = point.x * cosY - point.z * sinY;
      const z1 = point.x * sinY + point.z * cosY;
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      return {
        x: x1,
        y: point.y * cosP - z1 * sinP,
        z: point.y * sinP + z1 * cosP,
      };
    }

    function project(point) {
      const rotated = rotate(point);
      const cameraDistance = 18 / zoom;
      const perspective = cameraDistance / Math.max(5, cameraDistance + rotated.z);
      const scale = Math.min(width, height) * 0.042 * perspective;
      return {
        x: width / 2 + rotated.x * scale,
        y: height / 2 - rotated.y * scale,
        z: rotated.z,
        perspective,
      };
    }

    function drawGlow(x, y, radius, color, alpha) {
      const gradient = context.createRadialGradient(x, y, 0, x, y, radius * 3.2);
      gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
      gradient.addColorStop(0.2, color);
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, radius * 3.2, 0, Math.PI * 2);
      context.fill();
    }

    function drawBackground() {
      context.fillStyle = "#071018";
      context.fillRect(0, 0, width, height);
      backgroundStars.forEach((star) => {
        context.fillStyle = `rgba(188,220,232,${star.alpha})`;
        context.beginPath();
        context.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2);
        context.fill();
      });

      const sphereRadius = Math.min(width, height) * 0.35 * zoom;
      context.strokeStyle = "rgba(116,164,177,0.08)";
      context.lineWidth = 1;
      [1, 0.72, 0.42].forEach((factor) => {
        context.beginPath();
        context.ellipse(width / 2, height / 2, sphereRadius, sphereRadius * factor, 0, 0, Math.PI * 2);
        context.stroke();
      });
    }

    function draw() {
      drawBackground();
      const projected = new Map();
      currentPositions.forEach((position, id) => {
        projected.set(id, project(position));
      });

      built.relations.forEach((relation) => {
        const from = projected.get(relation.fromPersonId);
        const to = projected.get(relation.toPersonId);
        if (!from || !to) return;
        const isMarriage = relation.type === "spouse";
        const isSibling = relation.type === "sibling";
        context.strokeStyle = isMarriage
          ? "rgba(255,90,103,0.72)"
          : isSibling
            ? "rgba(91,148,194,0.24)"
            : "rgba(86,210,194,0.38)";
        context.lineWidth = isMarriage ? 1.25 : isSibling ? 0.7 : 0.85;
        context.setLineDash(isSibling ? [4, 5] : []);
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
        context.setLineDash([]);
      });

      projectedNodes = persons
        .map((person) => ({ person, ...projected.get(person.id) }))
        .filter((node) => Number.isFinite(node.x))
        .sort((a, b) => a.z - b.z);

      projectedNodes.forEach((node) => {
        const isFocus = node.person.id === focusId;
        const radius = Math.max(2.4, (isFocus ? 7 : 4.2) * node.perspective);
        const color =
          node.person.gender === "female"
            ? "rgba(255,134,176,0.78)"
            : "rgba(103,185,255,0.78)";
        drawGlow(node.x, node.y, radius, color, isFocus ? 1 : 0.9);
        if (isFocus) {
          context.save();
          context.strokeStyle = "rgba(255,255,255,0.92)";
          context.lineWidth = 1.4;
          context.beginPath();
          context.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
          context.stroke();
          context.font = "12px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
          context.textBaseline = "middle";
          context.shadowColor = "rgba(0,0,0,0.9)";
          context.shadowBlur = 6;
          context.fillStyle = "#f7fdff";
          context.fillText(node.person.name, node.x + radius + 10, node.y - 2);
          context.restore();
        }
      });
    }

    function applyFocus(id) {
      if (!personMap.has(id)) return;
      focusId = id;
      targetPositions = computeLayout(persons, built.adjacency, focusId);
      options?.onFocus?.(focusId);
    }

    function hitTest(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      let best = null;
      projectedNodes.forEach((node) => {
        const distance = Math.hypot(node.x - x, node.y - y);
        if (distance <= 12 && (!best || distance < best.distance)) best = { node, distance };
      });
      return best?.node || null;
    }

    function onPointerDown(event) {
      dragging = true;
      moved = false;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    }

    function onPointerMove(event) {
      if (dragging) {
        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        yaw += dx * 0.006;
        pitch = Math.max(-1.25, Math.min(1.25, pitch + dy * 0.005));
        lastX = event.clientX;
        lastY = event.clientY;
        tooltip.classList.remove("visible");
        return;
      }

      const node = hitTest(event.clientX, event.clientY);
      hoveredId = node?.person.id || "";
      canvas.style.cursor = hoveredId ? "pointer" : "grab";
      if (!node) {
        tooltip.classList.remove("visible");
        return;
      }
      const rect = canvas.getBoundingClientRect();
      tooltip.textContent = node.person.name;
      tooltip.style.left = `${event.clientX - rect.left + 12}px`;
      tooltip.style.top = `${event.clientY - rect.top + 10}px`;
      tooltip.classList.add("visible");
    }

    function onPointerUp(event) {
      dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
      if (!moved) {
        const node = hitTest(event.clientX, event.clientY);
        if (node) applyFocus(node.person.id);
      }
    }

    function onWheel(event) {
      event.preventDefault();
      zoom = Math.max(0.55, Math.min(2.4, zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", () => {
      dragging = false;
      hoveredId = "";
      tooltip.classList.remove("visible");
    });
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const searchInput = document.getElementById("star-search-input");
    const searchResults = document.getElementById("star-search-results");
    searchInput?.addEventListener("input", () => {
      if (!searchResults) return;
      const query = searchInput.value.trim().toLowerCase();
      if (!query) {
        searchResults.innerHTML = "";
        return;
      }
      const matches = persons.filter((person) => person.name.toLowerCase().includes(query)).slice(0, 8);
      searchResults.replaceChildren(
        ...matches.map((person) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = person.name;
          button.addEventListener("click", () => {
            searchInput.value = person.name;
            searchResults.innerHTML = "";
            applyFocus(person.id);
          });
          return button;
        }),
      );
    });

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();
    options?.onFocus?.(focusId);

    function animate() {
      if (disposed || !container.isConnected) {
        dispose();
        return;
      }
      currentPositions.forEach((position, id) => {
        const target = targetPositions.get(id);
        if (!target) return;
        position.x += (target.x - position.x) * 0.075;
        position.y += (target.y - position.y) * 0.075;
        position.z += (target.z - position.z) * 0.075;
      });
      draw();
      requestAnimationFrame(animate);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    }

    disposeCurrent = dispose;
    animate();
  }

  window.FamilyStarMap = { mount };
  window.dispatchEvent(new Event("family-star-map-ready"));
})();
