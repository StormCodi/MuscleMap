// lib/renderer3d.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function heatToVisual(heat, overdo) {
  const h = clamp01(heat);

  let color = new THREE.Color(0x7a7a7a);
  let emissive = new THREE.Color(0x000000);
  let eI = 0.0;

  if (overdo) {
    color = new THREE.Color(0xff3c3c);
    emissive = new THREE.Color(0xff3c3c);
    eI = 1.25;
    return { color, emissive, emissiveIntensity: eI };
  }

  if (h < 0.12) return { color, emissive, emissiveIntensity: eI };

  if (h < 0.35) emissive = new THREE.Color(0x3cff7a);
  else if (h < 0.6) emissive = new THREE.Color(0xffd84d);
  else emissive = new THREE.Color(0xff9b3c);

  return { color, emissive, emissiveIntensity: 0.8 };
}

export function createRenderer3D({
  mount,
  classifyMeshName,
  computeHeat,
  onSelect, // ({ mesh, name, groups }) => void
}) {
  if (!mount) throw new Error("createRenderer3D missing mount");

  /* ==============================
     Three.js setup
  ============================== */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  renderer.setClearColor(0x0b0b0c, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
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

  // lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(250, 450, 250);
  scene.add(dir);

  // grid
  const grid = new THREE.GridHelper(800, 40, 0x2a2a2a, 0x181818);
  grid.position.y = 0;
  scene.add(grid);

  // model bookkeeping
  let currentModel = null;
  const skinShellMeshes = [];
  const gymMeshes = []; // { mesh, groups }
  const pickables = [];
  let selectedMesh = null;

  function makeBaselineMuscleMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0x7a7a7a,
      roughness: 0.88,
      metalness: 0.0,
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 0.0,
    });
  }

  function makeSkinMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0x8e8e94,
      roughness: 0.95,
      metalness: 0.0,
      transparent: true,
      opacity: 0.32,
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 0.0,
      depthWrite: false,
    });
  }

  function applySelectionLook(mesh) {
    if (!mesh?.material) return;
    mesh.material.emissive = new THREE.Color(0x18a944);
    mesh.material.emissiveIntensity = 1.15;
    mesh.material.color = new THREE.Color(0x3cff7a);
    mesh.material.wireframe = true;
    mesh.material.needsUpdate = true;
  }

  function clearSelectionLook(mesh) {
    if (!mesh?.material) return;
    mesh.material.wireframe = false;
    mesh.material.needsUpdate = true;
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

  function clearModel() {
    if (currentModel) scene.remove(currentModel);
    currentModel = null;
    skinShellMeshes.length = 0;
    gymMeshes.length = 0;
    pickables.length = 0;
    selectedMesh = null;
  }

  function applyClassification(root) {
    const skinMat = makeSkinMaterial();

    root.traverse((obj) => {
      if (!obj.isMesh) return;

      const info = classifyMeshName(obj.name);

      if (info.kind === "shell") {
        obj.material = skinMat;
        obj.renderOrder = 2;
        obj.frustumCulled = true;
        obj.visible = true;
        skinShellMeshes.push(obj);
        return;
      }

      if (info.kind === "gym") {
        obj.visible = true;
        obj.renderOrder = 1;
        obj.frustumCulled = true;

        const base = makeBaselineMuscleMaterial();
        obj.material = base;
        obj.userData._muscle = { groups: info.groups || [], baseMaterial: base };

        gymMeshes.push({ mesh: obj, groups: obj.userData._muscle.groups });
        pickables.push(obj);
        return;
      }

      obj.visible = false;
    });
  }

  function loadGLB(url) {
    clearModel();
    const loader = new GLTFLoader();

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          const model = gltf.scene;
          currentModel = model;

          model.scale.setScalar(1);
          model.position.set(0, 0, 0);

          applyClassification(model);
          scene.add(model);
          frameObject(model);

          resolve();
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  async function loadGLBWithFallback() {
    const candidates = ["./assets/models/body.glb", "./assets/models/body.draco.glb"];
    for (const url of candidates) {
      try {
        await loadGLB(url);
        return;
      } catch (e) {
        console.warn("[GLB] failed:", url, e?.message || e);
      }
    }
    throw new Error("Could not load any model. Put body.glb in assets/models/.");
  }

  /* ==============================
     Picking
  ============================== */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;

  function getPointerNDC(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
    );
  }

  renderer.domElement.addEventListener("pointerdown", (ev) => {
    downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  });

  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (!downAt) return;
    const dx = Math.abs(ev.clientX - downAt.x);
    const dy = Math.abs(ev.clientY - downAt.y);
    const dt = performance.now() - downAt.t;
    downAt = null;
    if (dx > 6 || dy > 6 || dt > 500) return;

    getPointerNDC(ev);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables, true);
    if (!hits.length) return clearSelected();
    setSelected(hits[0].object);
  });

  function setSelected(mesh) {
    if (selectedMesh === mesh) return clearSelected();
    clearSelected();
    selectedMesh = mesh;

    const groups = mesh.userData?._muscle?.groups || [];
    onSelect?.({ mesh, name: mesh.name || "(unnamed)", groups });

    // selection look is applied after heat paint
    applySelectionLook(mesh);
  }

  function clearSelected() {
    if (!selectedMesh) {
      onSelect?.({ mesh: null, name: "None", groups: [] });
      return;
    }
    clearSelectionLook(selectedMesh);
    selectedMesh = null;
    onSelect?.({ mesh: null, name: "None", groups: [] });
  }

  /* ==============================
     Heat paint
  ============================== */
  function applyHeatToMesh(mesh, state, now = Date.now()) {
    const groups = mesh.userData?._muscle?.groups || [];
    let maxHeat = 0;
    let overdo = false;

    for (const g of groups) {
      const h = computeHeat(state, g, now);
      maxHeat = Math.max(maxHeat, h.heat);
      if (h.overdo) overdo = true;
    }

    const v = heatToVisual(maxHeat, overdo);
    mesh.material.color = v.color;
    mesh.material.emissive = v.emissive;
    mesh.material.emissiveIntensity = v.emissiveIntensity;
    mesh.material.wireframe = false;
  }

  function applyHeatToAllMeshes(state, now = Date.now()) {
    for (const { mesh } of gymMeshes) applyHeatToMesh(mesh, state, now);
    if (selectedMesh) applySelectionLook(selectedMesh);
  }

  function getAllGroupIds() {
    const set = new Set();
    for (const { groups } of gymMeshes) for (const g of groups) set.add(g);
    return [...set];
  }

  function renderFrame() {
    controls.update();
    renderer.render(scene, camera);
  }

  function resize() {
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    camera.aspect = mount.clientWidth / mount.clientHeight;
    camera.updateProjectionMatrix();
  }

  return {
    loadGLBWithFallback,
    applyHeatToAllMeshes,
    getAllGroupIds,
    clearSelected,
    renderFrame,
    resize,
  };
}
