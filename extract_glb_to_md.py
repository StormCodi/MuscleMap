from pygltflib import GLTF2
from collections import defaultdict
import re

GLB_PATH = "/var/www/html/musclemap/assets/models/body.glb"
OUT_MD = "Z_ANATOMY_GLBFULL.md"

# Heuristic: words that usually mean "muscle"
MUSCLE_HINTS = [
    "muscle", "musculus", "biceps", "triceps", "deltoid", "pector",
    "latissimus", "glute", "quadriceps", "hamstring", "rectus",
    "oblique", "flexor", "extensor", "adductor", "abductor",
    "gastrocnemius", "soleus", "tibialis", "brachii", "femoris"
]

def looks_like_muscle(name: str) -> bool:
    lname = name.lower()
    return any(k in lname for k in MUSCLE_HINTS)

gltf = GLTF2().load(GLB_PATH)

nodes = gltf.nodes or []
meshes = gltf.meshes or []
materials = gltf.materials or []

children_map = defaultdict(list)
for i, n in enumerate(nodes):
    if n.children:
        for c in n.children:
            children_map[i].append(c)

def node_path(idx, cache={}):
    if idx in cache:
        return cache[idx]
    for parent, kids in children_map.items():
        if idx in kids:
            cache[idx] = node_path(parent) + "/" + (nodes[idx].name or f"node_{idx}")
            return cache[idx]
    cache[idx] = nodes[idx].name or f"node_{idx}"
    return cache[idx]

muscle_nodes = []
other_nodes = []

for i, node in enumerate(nodes):
    name = node.name or f"node_{i}"
    entry = {
        "id": i,
        "name": name,
        "path": node_path(i),
        "mesh": node.mesh,
        "children": node.children or []
    }
    if looks_like_muscle(name):
        muscle_nodes.append(entry)
    else:
        other_nodes.append(entry)

with open(OUT_MD, "w", encoding="utf-8") as f:
    f.write("# Z-Anatomy GLB Extraction\n\n")
    f.write(f"Source file: `{GLB_PATH}`\n\n")

    f.write("## Scene Stats\n")
    f.write(f"- Nodes: {len(nodes)}\n")
    f.write(f"- Meshes: {len(meshes)}\n")
    f.write(f"- Materials: {len(materials)}\n\n")

    f.write("## Muscles (heuristic-detected)\n\n")
    for m in sorted(muscle_nodes, key=lambda x: x["name"]):
        f.write(f"### {m['name']}\n")
        f.write(f"- Node ID: {m['id']}\n")
        f.write(f"- Path: `{m['path']}`\n")
        f.write(f"- Mesh ID: {m['mesh']}\n")
        f.write(f"- Children: {m['children']}\n\n")

    f.write("## Other Nodes\n\n")
    for o in sorted(other_nodes, key=lambda x: x["name"]):
        f.write(f"- `{o['path']}` (node {o['id']})\n")

print(f"Written → {OUT_MD}")
