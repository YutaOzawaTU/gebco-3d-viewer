import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

const container = document.getElementById("viewer");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0f0f0);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(2.5,2.5,2.5);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0,0,0);
controls.update();

const ambient = new THREE.AmbientLight(0xffffff, 0.5); scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9); dirLight.position.set(5,10,5); scene.add(dirLight);

window.addEventListener("resize", ()=> {
  const w = container.clientWidth; const h = container.clientHeight;
  camera.aspect = w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h);
});

const modelGroup = new THREE.Group();
scene.add(modelGroup);
let baseMesh = null;
let terrainMesh = null;

async function loadTerrain() {
  const resp = await fetch("./data/gebco_tile.json");
  const data = await resp.json();
  const lat = data.lat; const lon = data.lon; const elevation = data.elevation;
  const nLat = lat.length; const nLon = lon.length;
  const widthSegments = nLon - 1; const heightSegments = nLat - 1;
  const width = 1.0; const height = 1.0;
  const geometry = new THREE.PlaneGeometry(width, height, widthSegments, heightSegments);
  const positions = geometry.attributes.position;
  const vertexCount = positions.count;
  // flatten elevation to find min/max
  const elevFlat = elevation.flat();
  const minElev = Math.min(...elevFlat); const maxElev = Math.max(...elevFlat);
  const elevRange = maxElev - minElev || 1;
  const zScale = 0.3 / elevRange;
  for (let i=0;i<vertexCount;i++){
    const ix = i % (widthSegments + 1);
    const iy = Math.floor(i / (widthSegments + 1));
    const elev = elevation[iy][ix];
    const z = (elev - minElev) * zScale;
    positions.setZ(i, z);
  }
  positions.needsUpdate = true; geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0x6688aa, flatShading: false, side: THREE.DoubleSide });
  terrainMesh = new THREE.Mesh(geometry, material);
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const offsetX = (bbox.min.x + bbox.max.x)/2;
  const offsetY = (bbox.min.y + bbox.max.y)/2;
  const offsetZ = bbox.min.z;
  terrainMesh.position.set(-offsetX, -offsetY, -offsetZ);
  modelGroup.add(terrainMesh);
  baseMesh = createBaseMesh(modelGroup, parseFloat(document.getElementById('baseThicknessNumber').value || 5));
  modelGroup.add(baseMesh);
  const size = new THREE.Vector3(); new THREE.Box3().setFromObject(modelGroup).getSize(size);
  const maxSize = Math.max(size.x, size.y, size.z); const dist = maxSize * 2.0;
  camera.position.set(dist, dist, dist); camera.lookAt(0,0,0); controls.target.set(0,0,0); controls.update();
}

function createBaseMesh(targetGroup, baseThickness) {
  const bbox = new THREE.Box3().setFromObject(targetGroup);
  const size = new THREE.Vector3(); const center = new THREE.Vector3();
  bbox.getSize(size); bbox.getCenter(center);
  const geom = new THREE.BoxGeometry(size.x, baseThickness, size.y);
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
  const mesh = new THREE.Mesh(geom, mat);
  const topZ = bbox.min.z;
  mesh.position.set(center.x, center.y, topZ - baseThickness/2);
  return mesh;
}

function updateBaseThickness(thickness) {
  if (!baseMesh) return;
  baseMesh.geometry.dispose();
  const bbox = new THREE.Box3().setFromObject(modelGroup);
  const size = new THREE.Vector3(); const center = new THREE.Vector3();
  bbox.getSize(size); bbox.getCenter(center);
  baseMesh.geometry = new THREE.BoxGeometry(size.x, thickness, size.y);
  const topZ = bbox.min.z;
  baseMesh.position.set(center.x, center.y, topZ - thickness/2);
}

function setupScaleControl(rangeElem, numberElem, axis) {
  const onRangeChange = () => {
    const v = parseFloat(rangeElem.value);
    numberElem.value = v;
    modelGroup.scale[axis] = v;
  };
  const onNumberChange = () => {
    let v = parseFloat(numberElem.value);
    if (Number.isNaN(v)) v = 1;
    rangeElem.value = v;
    modelGroup.scale[axis] = v;
  };
  rangeElem.addEventListener("input", onRangeChange);
  numberElem.addEventListener("change", onNumberChange);
}

document.addEventListener("DOMContentLoaded", ()=>{
  setupScaleControl(document.getElementById('scaleXRange'), document.getElementById('scaleXNumber'), 'x');
  setupScaleControl(document.getElementById('scaleYRange'), document.getElementById('scaleYNumber'), 'y');
  setupScaleControl(document.getElementById('scaleZRange'), document.getElementById('scaleZNumber'), 'z');
  document.getElementById('baseThicknessRange').addEventListener('input', (e)=> {
    const v = parseFloat(e.target.value); document.getElementById('baseThicknessNumber').value = v; updateBaseThickness(v);
  });
  document.getElementById('baseThicknessNumber').addEventListener('change', (e)=> {
    let v = parseFloat(e.target.value); if (Number.isNaN(v)) v = 5; document.getElementById('baseThicknessRange').value = v; updateBaseThickness(v);
  });
  document.getElementById('downloadStlBtn').addEventListener('click', ()=> {
    const exporter = new STLExporter();
    const stl = exporter.parse(modelGroup);
    const blob = new Blob([stl], { type: 'application/vnd.ms-pki.stl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'gebco_terrain.stl'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
  loadTerrain().catch(console.error);
});

function animate(){ requestAnimationFrame(animate); renderer.render(scene,camera); }
animate();
