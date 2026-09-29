/* publish/static/js/graph.js -- minimal interactivity for the wiki graph.
 *
 * The SVG is server-rendered with positions baked in; this layer adds:
 *   - hover: highlight the focused node + its neighbors and incident edges
 *   - click: navigate to the underlying ticker/entity page
 *   - hover tooltip: shows the entity name + role on edges, full
 *                    entity name on entity nodes
 *
 * The SVG carries a sibling <script type="application/json" id="wiki-graph-data">
 * with the full graph (nodes + edges + href templates). We read it once,
 * build an adjacency index, and wire delegated event handlers on the svg.
 */
(function () {
  "use strict";

  var svg = document.getElementById("wiki-graph-svg");
  var dataEl = document.getElementById("wiki-graph-data");
  if (!svg || !dataEl) return;

  var data;
  try {
    data = JSON.parse(dataEl.textContent || dataEl.innerText || "{}");
  } catch (e) {
    return;
  }
  if (!data.nodes || !data.edges) return;

  // adjacency: slug -> Set of neighbor slugs; edge map: "u|v" -> edge data
  var adj = Object.create(null);
  var edgeIndex = Object.create(null);
  data.nodes.forEach(function (n) {
    adj[n.slug] = new Set();
  });
  data.edges.forEach(function (e) {
    if (adj[e.from]) adj[e.from].add(e.to);
    if (adj[e.to]) adj[e.to].add(e.from);
    edgeIndex[e.from + "|" + e.to] = e;
    edgeIndex[e.to + "|" + e.from] = e;
  });

  var nodeNames = Object.create(null); // slug -> display label
  data.nodes.forEach(function (n) {
    nodeNames[n.slug] = n.label;
  });

  // Tooltip element (single, repositioned on hover)
  var tip = document.createElement("div");
  tip.className = "wiki-graph-tooltip";
  tip.style.position = "absolute";
  tip.style.pointerEvents = "none";
  tip.style.display = "none";
  tip.setAttribute("role", "tooltip");
  // attach to graph wrapper so coordinates stay local
  var wrapper = svg.parentNode;
  if (wrapper) {
    if (getComputedStyle(wrapper).position === "static") {
      wrapper.style.position = "relative";
    }
    wrapper.appendChild(tip);
  }

  function hrefFor(slug, kind) {
    if (kind === "ticker") {
      return data.ticker_href_template.replace("{}", slug);
    }
    return data.entity_href_template.replace("{}", slug);
  }

  function clearHighlight() {
    var nodes = svg.querySelectorAll(".wiki-graph-node");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove("is-focused", "is-neighbor", "is-dim");
    }
    var edges = svg.querySelectorAll(".wiki-graph-edge");
    for (var j = 0; j < edges.length; j++) {
      edges[j].classList.remove("is-focused", "is-dim");
    }
  }

  function highlight(slug) {
    var neighbors = adj[slug] || new Set();
    var nodes = svg.querySelectorAll(".wiki-graph-node");
    for (var i = 0; i < nodes.length; i++) {
      var s = nodes[i].getAttribute("data-slug");
      if (s === slug) {
        nodes[i].classList.add("is-focused");
        nodes[i].classList.remove("is-neighbor", "is-dim");
      } else if (neighbors.has(s)) {
        nodes[i].classList.add("is-neighbor");
        nodes[i].classList.remove("is-focused", "is-dim");
      } else {
        nodes[i].classList.add("is-dim");
        nodes[i].classList.remove("is-focused", "is-neighbor");
      }
    }
    var edges = svg.querySelectorAll(".wiki-graph-edge");
    for (var k = 0; k < edges.length; k++) {
      var from = edges[k].getAttribute("data-from");
      var to = edges[k].getAttribute("data-to");
      if (from === slug || to === slug) {
        edges[k].classList.add("is-focused");
        edges[k].classList.remove("is-dim");
      } else {
        edges[k].classList.add("is-dim");
        edges[k].classList.remove("is-focused");
      }
    }
  }

  function showTip(html, evt) {
    tip.innerHTML = html;
    tip.style.display = "block";
    // Position tip relative to wrapper. Cap at viewport edges.
    var wrapperRect = wrapper.getBoundingClientRect();
    var x = evt.clientX - wrapperRect.left + 12;
    var y = evt.clientY - wrapperRect.top + 12;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  function hideTip() {
    tip.style.display = "none";
  }

  function nodeMouseEnter(g, evt) {
    var slug = g.getAttribute("data-slug");
    var kind = g.getAttribute("data-kind");
    highlight(slug);
    var name = g.getAttribute("data-name") || nodeNames[slug] || slug;
    var label = kind === "ticker"
      ? "<strong>" + slug + "</strong>"
      : "<strong>" + escapeHtml(name) + "</strong>";
    showTip(label, evt);
  }

  function edgeMouseEnter(line, evt) {
    var from = line.getAttribute("data-from");
    var to = line.getAttribute("data-to");
    var e = edgeIndex[from + "|" + to];
    if (!e) return;
    line.classList.add("is-focused");
    var fromLabel = nodeNames[from] || from;
    var toLabel = nodeNames[to] || to;
    var role = e.role || "";
    var tier = e.tier || "";
    var html = "<strong>" + escapeHtml(fromLabel) + "</strong>"
      + ' &middot; <em>' + escapeHtml(role) + "</em>"
      + ' &middot; <span class="tier-' + tier + '">' + tier + "</span>";
    showTip(html, evt);
  }

  // Delegated handlers on the svg
  svg.addEventListener("mouseover", function (evt) {
    var nodeG = evt.target.closest(".wiki-graph-node");
    if (nodeG) { nodeMouseEnter(nodeG, evt); return; }
    var edgeL = evt.target.closest(".wiki-graph-edge");
    if (edgeL) { edgeMouseEnter(edgeL, evt); return; }
  });

  svg.addEventListener("mousemove", function (evt) {
    if (tip.style.display === "block") {
      var wrapperRect = wrapper.getBoundingClientRect();
      tip.style.left = (evt.clientX - wrapperRect.left + 12) + "px";
      tip.style.top = (evt.clientY - wrapperRect.top + 12) + "px";
    }
  });

  svg.addEventListener("mouseout", function (evt) {
    // Only clear when leaving an interactive element
    var nodeG = evt.target.closest(".wiki-graph-node");
    var edgeL = evt.target.closest(".wiki-graph-edge");
    if (nodeG || edgeL) {
      // Check if we've moved to another interactive element
      var related = evt.relatedTarget;
      if (related && related.closest && (related.closest(".wiki-graph-node") || related.closest(".wiki-graph-edge"))) {
        return;
      }
      clearHighlight();
      hideTip();
    }
  });

  svg.addEventListener("click", function (evt) {
    var nodeG = evt.target.closest(".wiki-graph-node");
    if (!nodeG) return;
    var slug = nodeG.getAttribute("data-slug");
    var kind = nodeG.getAttribute("data-kind");
    var href = hrefFor(slug, kind);
    if (href) window.location.href = href;
  });

  // Cursor pointer on hover for nodes
  var nodes = svg.querySelectorAll(".wiki-graph-node");
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].style.cursor = "pointer";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
