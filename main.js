// main.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const mount = document.getElementById("view");
if (!mount) throw new Error("Missing #view element");

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(mount.clientWidth, mount.clientHeight);
renderer.setClearColor(0x0c0c0c, 1);
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  mount.clientWidth / mount.clientHeight,
  0.01,
  5000
);
camera.position.set(0, 160, 380);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 120, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.55));

const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(250, 450, 250);
scene.add(dir);

const grid = new THREE.GridHelper(800, 40, 0x2a2a2a, 0x181818);
grid.position.y = 0;
scene.add(grid);

// ---------------- Materials ----------------
function makeBaselineMuscleMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x7a7a7a,
    roughness: 0.85,
    metalness: 0.0,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0.0,
  });
}

function makeSkinMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x6f6f6f,
    roughness: 0.95,
    metalness: 0.0,
    transparent: true,
    opacity: 0.92,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0.0,
  });
}

function makeHighlightMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x00ff66,
    roughness: 0.45,
    metalness: 0.0,
    emissive: new THREE.Color(0x00ff66),
    emissiveIntensity: 2.2,
    transparent: true,
    opacity: 1.0,
  });
}

const selectedWireMat = new THREE.MeshBasicMaterial({
  color: 0x00ff66,
  wireframe: true,
  transparent: true,
  opacity: 0.9,
  depthTest: false,
});

// ---------------- Model state ----------------
let currentModel = null;
const gymMuscles = [];
let selectedMesh = null;
let selectedWire = null;

// ---------------- Model selection ----------------
const MODEL_PATHS = {
  male: "./assets/models/male.glb",
  female: "./assets/models/female.glb",
};

let activeSex = localStorage.getItem("musclemap.sex") || "male";
if (!(activeSex in MODEL_PATHS)) activeSex = "male";

// ---------------- Name logic ----------------
function isMuscleName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes("_muscle") || n.includes("_muscler");
}

function looksLikeSkinShell(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes("superficial") || n.includes("skin") || n.includes("fascia") || n.includes("fasciar");
}

function isMicroOrNotGym(name) {
  if (!name) return true;
  const n = name.toLowerCase();

  const reject = [
    "orbicularis","nasalis","frontalis","buccinator","masseter","temporalis",
    "platysma","digastric","mylohyoid","geniohyoid","sternohyoid","omohyoid",
    "thyrohyoid","crico","aryten","laryn","pharyn","tongue","hyoid",
    "interosse","lumbrical","palmaris_brevis","thenar","hypothenar",
    "abductor_digiti","opponens","flexor_pollicis","extensor_pollicis",
    "tarsal","plantar","retinaculum",
  ];
  if (reject.some((r) => n.includes(r))) return true;

  return false;
}

function isGymMuscle(name) {
  if (!name) return false;
  const n = name.toLowerCase();

  if (!isMuscleName(n)) return false;
  if (isMicroOrNotGym(n)) return false;

  const allow = [
    "pectoralis",
    "latissimus","trapezius","rhomboid","erector_spinae",
    "deltoid","supraspinatus","infraspinatus","teres_","subscapularis",
    "biceps","triceps","brachialis","brachioradialis",
    "rectus_abdominis","oblique","transversus_abdominis",
    "glute","adductor","abductor","iliopsoas","iliacus","psoas","tensor_fasciae_latae",
    "quadriceps","rectus_femoris","vastus_",
    "hamstring","biceps_femoris","semitendinosus","semimembranosus",
    "gastrocnemius","soleus","tibialis","fibularis","perone",
    "splenius_capitis",
  ];

  return allow.some((tok) => n.includes(tok));
}

// ---------------- Framing ----------------
function normalizeModel(root, targetHeight = 180) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  if (!isFinite(size.y) || size.y <= 1e-6) return;

  const s = targetHeight / size.y;
  root.scale.setScalar(s);

  const box2 = new THREE.Box3().setFromObject(root);
  const center = box2.getCenter(new THREE.Vector3());
  root.position.sub(center);

  const size2 = box2.getSize(new THREE.Vector3());
  root.position.y += size2.y / 2;
}

function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  controls.target.copy(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.25;

  camera.position.set(center.x, center.y + maxDim * 0.15, center.z + dist);
  camera.near = Math.max(0.01, maxDim / 1000);
  camera.far = maxDim * 20;
  camera.updateProjectionMatrix();
}

// ---------------- Progress logging ----------------
function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}
let lastProgressLogAt = 0;
function logProgress(xhr, label = "GLB") {
  const now = performance.now();
  if (now - lastProgressLogAt < 250) return;
  lastProgressLogAt = now;

  const loaded = xhr.loaded ?? 0;
  const total = xhr.total ?? 0;

  if (total > 0) {
    const pct = Math.floor((loaded / total) * 100);
    console.log(`[${label}] ${pct}% (${fmtMB(loaded)} / ${fmtMB(total)})`);
  } else {
    console.log(`[${label}] ${fmtMB(loaded)} loaded (total unknown)`);
  }
}

// ---------------- Setup shell + muscles ----------------
function clearSelection() {
  if (selectedWire) {
    selectedWire.removeFromParent();
    selectedWire.geometry?.dispose?.();
    selectedWire = null;
  }

  if (selectedMesh) {
    selectedMesh.visible = false;
    selectedMesh.material = selectedMesh.userData._origMaterial || selectedMesh.material;
    selectedMesh.material.needsUpdate = true;
    selectedMesh = null;
  }
}

function addSelectedWire(mesh) {
  const wire = new THREE.Mesh(mesh.geometry, selectedWireMat);
  wire.renderOrder = 9999;
  mesh.add(wire);
  return wire;
}

function highlightMesh(mesh) {
  clearSelection();
  selectedMesh = mesh;
  selectedMesh.visible = true;
  selectedMesh.material = makeHighlightMaterial();
  selectedMesh.material.needsUpdate = true;
  selectedWire = addSelectedWire(selectedMesh);
  console.log("Selected gym muscle:", selectedMesh.name || "(no name)");
}

function setupHumanShellAndGymMuscles(root) {
  gymMuscles.length = 0;
  clearSelection();

  const skinMat = makeSkinMaterial();
  let shellCount = 0;
  let gymCount = 0;

  root.traverse((obj) => {
    if (!obj.isMesh) return;

    const nm = obj.name || "";
    obj.visible = false;

    if (!obj.userData._origMaterial) obj.userData._origMaterial = makeBaselineMuscleMaterial();
    obj.material = obj.userData._origMaterial;

    // show shell
    if (looksLikeSkinShell(nm) && !isMuscleName(nm)) {
      obj.visible = true;
      obj.material = skinMat;
      obj.material.needsUpdate = true;
      shellCount++;
      return;
    }

    // gym muscle: hidden but clickable
    if (isGymMuscle(nm)) {
      obj.visible = false;
      gymMuscles.push(obj);
      gymCount++;
      return;
    }
  });

  console.log("Skin shell meshes:", shellCount);
  console.log("Gym muscles (clickable, hidden until selected):", gymCount);

  if (shellCount === 0) {
    let fallback = 0;
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      const nm = (obj.name || "").toLowerCase();
      if (fallback < 6 && (nm.includes("fascia") || nm.includes("superficial"))) {
        obj.visible = true;
        obj.material = skinMat;
        obj.material.needsUpdate = true;
        fallback++;
      }
    });
    console.warn("No shell detected by name; fallback shell meshes:", fallback);
  }
}

// ---------------- Raycast ----------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function getPointerNDC(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
  pointer.set(x, y);
}

let downAt = null;
renderer.domElement.addEventListener("pointerdown", (ev) => {
  downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
});

renderer.domElement.addEventListener("pointerup", (ev) => {
  if (!downAt) return;

  const dx = Math.abs(ev.clientX - downAt.x);
  const dy = Math.abs(ev.clientY - downAt.y);
  const dt = performance.now() - downAt.t;
  downAt = null;

  const isClick = dx < 6 && dy < 6 && dt < 500;
  if (!isClick) return;
  if (!currentModel) return;

  getPointerNDC(ev);
  raycaster.setFromCamera(pointer, camera);

  // Temporarily show muscles for intersection (three.js won't hit invisible meshes)
  for (const m of gymMuscles) m.visible = true;
  const hits = raycaster.intersectObjects(gymMuscles, true);
  for (const m of gymMuscles) {
    if (selectedMesh && m === selectedMesh) continue;
    m.visible = false;
  }

  if (!hits.length) {
    clearSelection();
    return;
  }

  highlightMesh(hits[0].object);
});

// ---------------- Load ----------------
function loadGLB(sex) {
  const url = MODEL_PATHS[sex];

  if (currentModel) {
    scene.remove(currentModel);
    currentModel = null;
    clearSelection();
  }

  console.log(`[GLB] start (${sex}):`, url);

  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        currentModel = gltf.scene;

        normalizeModel(currentModel, 180);
        setupHumanShellAndGymMuscles(currentModel);

        scene.add(currentModel);
        frameObject(currentModel);

        console.log(`[GLB] done (${sex}):`, url);
        resolve();
      },
      (xhr) => logProgress(xhr, `GLB-${sex}`),
      (err) => {
        console.error(`[GLB] failed (${sex}):`, err);
        reject(err);
      }
    );
  });
}

// ---------------- UI ----------------
function syncRadioUI() {
  const radios = document.querySelectorAll('input[name="sexModel"]');
  radios.forEach((r) => (r.checked = r.value === activeSex));
}

document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (t.name !== "sexModel") return;

  const val = t.value === "female" ? "female" : "male";
  if (val === activeSex) return;

  activeSex = val;
  localStorage.setItem("musclemap.sex", activeSex);

  loadGLB(activeSex).catch(() => alert(`Failed to load ${MODEL_PATHS[activeSex]}`));
});

const reloadBtn = document.getElementById("reloadBtn");
if (reloadBtn) {
  reloadBtn.addEventListener("click", () => {
    loadGLB(activeSex).catch(() => alert(`Failed to load ${MODEL_PATHS[activeSex]}`));
  });
}

window.addEventListener("resize", () => {
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  camera.aspect = mount.clientWidth / mount.clientHeight;
  camera.updateProjectionMatrix();
});

// init
syncRadioUI();
loadGLB(activeSex).catch(() => {
  console.warn("Model not loaded. Put models at:");
  console.warn(" -", MODEL_PATHS.male);
  console.warn(" -", MODEL_PATHS.female);
});

// loop
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
