
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { BufferGeometryUtils } from "three/addons/utils/BufferGeometryUtils.js";

/*
  Updated main.js for GEBCO 3D viewer.

  - Base (土台) thickness is applied along Z (depth) so the base sits under the terrain.
  - STL export merges terrain and base into a single geometry (world-transformed) before export.
  - Defensive checks added for loading order.
*/

const container = document.getElementById("viewer");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0f0f0);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(2.5, 2.5, 2.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.update();

const ambient = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight.position.set(5, 10, 5);
scene.add(dirLight);

window.addEventListener("resize", () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// Group that contains terrain + base
const modelGroup = new THREE.Group();
scene.add(modelGroup);

let terrainMesh = null;
let baseMesh = null;

// Load terrain JSON and create mesh
async function loadTerrain() {
  try {
    const resp = await fetch("./data/gebco_tile.json");
    if (!resp.ok) throw new Error("Failed to fetch data/gebco_tile.json: " + resp.status);
    const data = await resp.json();
    const lat = data.lat;
    const lon = data.lon;
    const elevation = data.elevation;

    const nLat = lat.length;
    const nLon = lon.length;

    const widthSegments = nLon - 1;
    const heightSegments = nLat - 1;
    const width = 1.0;
    const height = 1.0;
    const geometry = new THREE.PlaneGeometry(width, height, widthSegments, heightSegments);

    const positions = geometry.attributes.position;
    const vertexCount = positions.count;

    // Flatten to compute min/max
    const elevFlat = elevation.flat();
    const minElev = Math.min(...elevFlat);
    const maxElev = Math.max(...elevFlat);
    const elevRange = maxElev - minElev || 1;
    // Adjust this to control absolute height range before applying Z-scale UI
    const zScaleBase = 0.3 / elevRange;

    for (let i = 0; i < vertexCount; i++) {
      const ix = i % (widthSegments + 1);
      const iy = Math.floor(i / (widthSegments + 1));
      const elev = elevation[iy][ix];
      const z = (elev - minElev) * zScaleBase;
      positions.setZ(i, z);
    }

    positions.needsUpdate = true;
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0x6688aa,
      flatShading: false,
      side: THREE.DoubleSide,
    });

    terrainMesh = new THREE.Mesh(geometry, material);

    // center the plane so its XY center is at (0,0) and its lowest z is at 0 before adding base
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox;
    const offsetX = (bbox.min.x + bbox.max.x) / 2;
    const offsetY = (bbox.min.y + bbox.max.y) / 2;
    const offsetZ = bbox.min.z; // lowest z in geometry
    terrainMesh.position.set(-offsetX, -offsetY, -offsetZ);

    modelGroup.add(terrainMesh);

    // create initial base (default thickness from UI or 5)
    const baseThicknessInput = document.getElementById("baseThicknessNumber");
    const initThickness = baseThicknessInput ? parseFloat(baseThicknessInput.value) || 5 : 5;
    baseMesh = createBaseMesh(modelGroup, initThickness);
    modelGroup.add(baseMesh);

    // adjust camera to fit model
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(modelGroup).getSize(size);
    const maxSize = Math.max(size.x, size.y, size.z);
    const dist = Math.max(maxSize * 2.0, 2.0);
    camera.position.set(dist, dist, dist);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
  } catch (err) {
    console.error("loadTerrain error:", err);
  }
}

// create base so that its top surface is aligned with terrain's lowest world Z
function createBaseMesh(targetGroup, baseThickness) {
  // compute bbox in world coordinates (includes scaling)
  const bbox = new THREE.Box3().setFromObject(targetGroup);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);

  // BoxGeometry(width (X), height (Y), depth (Z))
  // We want base to span X and Y extents, and thickness along Z
  const geom = new THREE.BoxGeometry(size.x, size.y, baseThickness);
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
  const mesh = new THREE.Mesh(geom, mat);

  // Position the box so its top face equals bbox.min.z (terrain lowest world Z)
  const topZ = bbox.min.z;
  mesh.position.set(center.x, center.y, topZ - baseThickness / 2);

  return mesh;
}

function updateBaseThickness(thickness) {
  if (!baseMesh) {
    // if base doesn't exist yet, create it
    baseMesh = createBaseMesh(modelGroup, thickness);
    modelGroup.add(baseMesh);
    return;
  }

  // Remove old geometry, create a new one preserving the material
  baseMesh.geometry.dispose();

  // Recompute bbox from modelGroup (this takes scaling into account)
  const bbox = new THREE.Box3().setFromObject(modelGroup);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);

  baseMesh.geometry = new THREE.BoxGeometry(size.x, size.y, thickness);

  const topZ = bbox.min.z;
  baseMesh.position.set(center.x, center.y, topZ - thickness / 2);
}

// Merge terrain + base into a single geometry (apply world matrices) and export STL
function downloadSTL() {
  if (!terrainMesh) {
    alert("Terrain not loaded yet.");
    return;
  }
  if (!baseMesh) {
    alert("Base not created yet.");
    return;
  }

  // Ensure world matrices are updated
  terrainMesh.updateMatrixWorld(true);
  baseMesh.updateMatrixWorld(true);

  try {
    const geomA = terrainMesh.geometry.clone();
    geomA.applyMatrix4(terrainMesh.matrixWorld);

    const geomB = baseMesh.geometry.clone();
    geomB.applyMatrix4(baseMesh.matrixWorld);

    // Merge. If attributes mismatch, set useGroups=false or normalize attributes first.
    const merged = BufferGeometryUtils.mergeBufferGeometries([geomA, geomB], true);
    merged.computeVertexNormals();

    const mergedMesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial());

    const exporter = new STLExporter();
    const stlString = exporter.parse(mergedMesh); // ASCII

    const blob = new Blob([stlString], { type: "application/vnd.ms-pki.stl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gebco_terrain_merged.stl";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("STL export error:", err);
    alert("STL export failed. See console for details.");
  }
}

function setupScaleControl(rangeElem, numberElem, axis) {
  const onRangeChange = () => {
    const v = parseFloat(rangeElem.value);
    numberElem.value = v;
    // apply scale on modelGroup
    modelGroup.scale[axis] = v;
    // after scaling, recompute base position so it stays under terrain
    // Use current base thickness value to update geometry properly
    const thickness = parseFloat(document.getElementById("baseThicknessNumber").value) || 5;
    updateBaseThickness(thickness);
  };

  const onNumberChange = () => {
    let v = parseFloat(numberElem.value);
    if (Number.isNaN(v)) v = 1;
    rangeElem.value = v;
    modelGroup.scale[axis] = v;
    const thickness = parseFloat(document.getElementById("baseThicknessNumber").value) || 5;
    updateBaseThickness(thickness);
  };

  rangeElem.addEventListener("input", onRangeChange);
  numberElem.addEventListener("change", onNumberChange);
}

document.addEventListener("DOMContentLoaded", () => {
  // Wire controls (if present)
  const scaleXRange = document.getElementById("scaleXRange");
  const scaleXNumber = document.getElementById("scaleXNumber");
  const scaleYRange = document.getElementById("scaleYRange");
  const scaleYNumber = document.getElementById("scaleYNumber");
  const scaleZRange = document.getElementById("scaleZRange");
  const scaleZNumber = document.getElementById("scaleZNumber");
  const baseThicknessRange = document.getElementById("baseThicknessRange");
  const baseThicknessNumber = document.getElementById("baseThicknessNumber");
  const downloadStlBtn = document.getElementById("downloadStlBtn");

  if (scaleXRange && scaleXNumber) setupScaleControl(scaleXRange, scaleXNumber, "x");
  if (scaleYRange && scaleYNumber) setupScaleControl(scaleYRange, scaleYNumber, "y");
  if (scaleZRange && scaleZNumber) setupScaleControl(scaleZRange, scaleZNumber, "z");

  if (baseThicknessRange && baseThicknessNumber) {
    baseThicknessRange.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      baseThicknessNumber.value = v;
      updateBaseThickness(v);
    });
    baseThicknessNumber.addEventListener("change", (e) => {
      let v = parseFloat(e.target.value);
      if (Number.isNaN(v)) v = 5;
      baseThicknessRange.value = v;
      updateBaseThickness(v);
    });
  }

  if (downloadStlBtn) {
    downloadStlBtn.addEventListener("click", () => {
      downloadSTL();
    });
  }

  // Load terrain
  loadTerrain().catch(console.error);
});

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
