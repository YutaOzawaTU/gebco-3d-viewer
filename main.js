import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { BufferGeometryUtils } from "three/addons/utils/BufferGeometryUtils.js";
import NetCDFReader from "https://cdn.jsdelivr.net/npm/netcdfjs@1.4.0/+esm";

const LAT_CANDIDATES = ["lat", "latitude", "y", "nav_lat", "grid_latitude"];
const LON_CANDIDATES = ["lon", "longitude", "x", "nav_lon", "grid_longitude"];
const ELEVATION_CANDIDATES = [
  "elevation",
  "height",
  "depth",
  "z",
  "band1",
  "surface_height",
  "elev",
];

const container = document.getElementById("viewer");
if (!container) {
  throw new Error("viewer コンテナが見つかりません");
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf0f0f0);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
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

typeCheckCanvasSize();
window.addEventListener("resize", () => {
  typeCheckCanvasSize();
});

const modelGroup = new THREE.Group();
scene.add(modelGroup);
const terrainGroup = new THREE.Group();
modelGroup.add(terrainGroup);

let terrainMesh = null;
let baseMesh = null;
let currentDownloadBaseName = "terrain";
let currentSourceLabel = "";
let currentBaseThickness = 5;

const terrainMaterial = new THREE.MeshStandardMaterial({
  color: 0x6688aa,
  flatShading: false,
  side: THREE.DoubleSide,
});
const baseMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });

const statusEl = document.getElementById("loadStatus");
const summaryEl = document.getElementById("dataSummary");
const downloadButton = document.getElementById("downloadStlBtn");
const fileInput = document.getElementById("ncFileInput");
const loadSampleBtn = document.getElementById("loadSampleBtn");
const baseThicknessRange = document.getElementById("baseThicknessRange");
const baseThicknessNumber = document.getElementById("baseThicknessNumber");

const scaleXRange = document.getElementById("scaleXRange");
const scaleXNumber = document.getElementById("scaleXNumber");
const scaleYRange = document.getElementById("scaleYRange");
const scaleYNumber = document.getElementById("scaleYNumber");
const scaleZRange = document.getElementById("scaleZRange");
const scaleZNumber = document.getElementById("scaleZNumber");

if (downloadButton) {
  downloadButton.addEventListener("click", () => {
    downloadSTL();
  });
}

if (fileInput) {
  fileInput.addEventListener("change", async (event) => {
    const target = event.target;
    if (!target || !target.files || target.files.length === 0) {
      return;
    }
    const file = target.files[0];
    target.value = ""; // allow selecting the same file again later
    await loadNcFile(file);
  });
}

if (loadSampleBtn) {
  loadSampleBtn.addEventListener("click", async () => {
    await loadSampleTerrain(true);
  });
}

setupScaleControl(scaleXRange, scaleXNumber, "x");
setupScaleControl(scaleYRange, scaleYNumber, "y");
setupScaleControl(scaleZRange, scaleZNumber, "z");
setupBaseThicknessControl(baseThicknessRange, baseThicknessNumber);

loadSampleTerrain(false).catch((err) => {
  console.error(err);
  setStatus(`サンプルデータの読み込みに失敗しました: ${err.message}`, "error");
});

animate();

async function loadNcFile(file) {
  setStatus(`${file.name} を解析しています…`);
  try {
    const dataset = await parseNetCDF(file);
    buildTerrainFromGrid(dataset.lat, dataset.lon, dataset.elevation, {
      fileNameBase: dataset.fileBaseName,
      sourceLabel: file.name,
    });
    setStatus(`${file.name} の読み込みが完了しました。`, "success");
  } catch (error) {
    console.error(error);
    setStatus(`読み込みエラー: ${error.message}`, "error");
  }
}

async function loadSampleTerrain(showMessage) {
  if (showMessage) {
    setStatus("サンプルデータを読み込み中…");
  }
  try {
    const response = await fetch("./data/gebco_tile.json");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.lat) || !Array.isArray(data.lon) || !Array.isArray(data.elevation)) {
      throw new Error("サンプルデータの形式が正しくありません");
    }
    buildTerrainFromGrid(data.lat, data.lon, data.elevation, {
      fileNameBase: "sample_terrain",
      sourceLabel: "サンプルデータ",
    });
    setStatus("サンプルデータを読み込みました。", "success");
  } catch (error) {
    console.error(error);
    throw error;
  }
}

function buildTerrainFromGrid(lat, lon, elevationGrid, options = {}) {
  if (!Array.isArray(lat) || lat.length < 2) {
    throw new Error("緯度配列の長さが不足しています");
  }
  if (!Array.isArray(lon) || lon.length < 2) {
    throw new Error("経度配列の長さが不足しています");
  }
  if (!Array.isArray(elevationGrid) || elevationGrid.length !== lat.length) {
    throw new Error("標高グリッドが緯度と一致していません");
  }
  const lonLength = lon.length;
  for (const row of elevationGrid) {
    if (!Array.isArray(row) || row.length !== lonLength) {
      throw new Error("標高グリッドの列数が経度と一致していません");
    }
  }

  clearModel();

  const latStats = arrayMinMax(lat);
  const lonStats = arrayMinMax(lon);
  const latSpan = Math.max(Math.abs(latStats.max - latStats.min), 1e-6);
  const lonSpan = Math.max(Math.abs(lonStats.max - lonStats.min), 1e-6);

  const widthSegments = lon.length - 1;
  const heightSegments = lat.length - 1;
  if (widthSegments <= 0 || heightSegments <= 0) {
    throw new Error("グリッドの分割数が不足しています");
  }

  const geometry = new THREE.PlaneGeometry(lonSpan, latSpan, widthSegments, heightSegments);
  const positions = geometry.attributes.position;
  const vertexCount = positions.count;

  let minElev = Infinity;
  let maxElev = -Infinity;
  for (let rowIndex = 0; rowIndex < elevationGrid.length; rowIndex++) {
    const row = elevationGrid[rowIndex];
    for (let colIndex = 0; colIndex < lonLength; colIndex++) {
      const value = row[colIndex];
      if (!Number.isFinite(value)) {
        continue;
      }
      if (value < minElev) minElev = value;
      if (value > maxElev) maxElev = value;
    }
  }
  if (minElev === Infinity) minElev = 0;
  if (maxElev === -Infinity) maxElev = 0;
  const elevRange = Math.max(maxElev - minElev, 1e-6);
  const zScaleBase = 0.3 / elevRange;

  for (let i = 0; i < vertexCount; i++) {
    const ix = i % (widthSegments + 1);
    const iy = Math.floor(i / (widthSegments + 1));
    const elevValue = elevationGrid[iy][ix];
    const z = (elevValue - minElev) * zScaleBase;
    positions.setZ(i, z);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();

  terrainMesh = new THREE.Mesh(geometry, terrainMaterial);
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const offsetX = (bbox.min.x + bbox.max.x) / 2;
  const offsetY = (bbox.min.y + bbox.max.y) / 2;
  const offsetZ = bbox.min.z;
  terrainMesh.position.set(-offsetX, -offsetY, -offsetZ);
  terrainGroup.add(terrainMesh);

  terrainGroup.scale.set(getScaleValue(scaleXRange, scaleXNumber), getScaleValue(scaleYRange, scaleYNumber), getScaleValue(scaleZRange, scaleZNumber));

  currentDownloadBaseName = options.fileNameBase ? makeSafeFilename(options.fileNameBase) : "terrain";
  currentSourceLabel = options.sourceLabel || "";

  const thicknessValue = getBaseThicknessValue();
  currentBaseThickness = thicknessValue;
  rebuildBase(thicknessValue);

  frameCamera();

  updateSummary({
    lat,
    lon,
    minElev,
    maxElev,
    sourceLabel: currentSourceLabel,
  });

  if (downloadButton) {
    downloadButton.disabled = false;
  }
}

function clearModel() {
  if (terrainMesh) {
    terrainGroup.remove(terrainMesh);
    terrainMesh.geometry.dispose();
    terrainMesh = null;
  }
  if (baseMesh) {
    modelGroup.remove(baseMesh);
    baseMesh.geometry.dispose();
    baseMesh = null;
  }
  terrainGroup.scale.set(1, 1, 1);
  if (downloadButton) {
    downloadButton.disabled = true;
  }
  updateSummary(null);
}

function rebuildBase(thickness) {
  if (!terrainMesh || !Number.isFinite(thickness) || thickness <= 0) {
    if (baseMesh) {
      modelGroup.remove(baseMesh);
      baseMesh.geometry.dispose();
      baseMesh = null;
    }
    return;
  }
  const bbox = new THREE.Box3().setFromObject(terrainGroup);
  if (!isFinite(bbox.min.x) || !isFinite(bbox.min.y) || !isFinite(bbox.min.z)) {
    return;
  }
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);

  const width = Math.max(size.x, 1e-6);
  const depth = Math.max(size.y, 1e-6);

  const geometry = new THREE.BoxGeometry(width, depth, thickness);
  if (!baseMesh) {
    baseMesh = new THREE.Mesh(geometry, baseMaterial);
    modelGroup.add(baseMesh);
  } else {
    baseMesh.geometry.dispose();
    baseMesh.geometry = geometry;
  }

  const topZ = bbox.min.z;
  baseMesh.position.set(center.x, center.y, topZ - thickness / 2);
}

function setupScaleControl(rangeElem, numberElem, axis) {
  if (!rangeElem || !numberElem) {
    return;
  }

  const applyScale = (value) => {
    const v = Number(value);
    if (!Number.isFinite(v) || !terrainGroup) {
      return;
    }
    terrainGroup.scale[axis] = v;
    currentBaseThickness = getBaseThicknessValue();
    rebuildBase(currentBaseThickness);
  };

  rangeElem.addEventListener("input", (event) => {
    const value = Number(event.target.value);
    numberElem.value = String(value);
    applyScale(value);
  });

  numberElem.addEventListener("change", (event) => {
    let value = Number(event.target.value);
    if (!Number.isFinite(value)) {
      value = 1;
    }
    const min = Number(numberElem.min) || 0.1;
    const max = Number(numberElem.max) || 10;
    if (value < min) value = min;
    if (value > max) value = max;
    numberElem.value = String(value);
    rangeElem.value = String(value);
    applyScale(value);
  });
}

function setupBaseThicknessControl(rangeElem, numberElem) {
  if (!rangeElem || !numberElem) {
    return;
  }

  const applyThickness = (value) => {
    const thickness = Number(value);
    if (!Number.isFinite(thickness) || thickness <= 0) {
      return;
    }
    currentBaseThickness = thickness;
    rebuildBase(thickness);
  };

  rangeElem.addEventListener("input", (event) => {
    const value = Number(event.target.value);
    numberElem.value = String(value);
    applyThickness(value);
  });

  numberElem.addEventListener("change", (event) => {
    let value = Number(event.target.value);
    if (!Number.isFinite(value)) {
      value = 5;
    }
    const min = Number(numberElem.min) || 0.1;
    const max = Number(numberElem.max) || 50;
    if (value < min) value = min;
    if (value > max) value = max;
    numberElem.value = String(value);
    rangeElem.value = String(value);
    applyThickness(value);
  });

  currentBaseThickness = getBaseThicknessValue();
}

function getScaleValue(rangeElem, numberElem) {
  if (!rangeElem || !numberElem) {
    return 1;
  }
  const value = Number(numberElem.value || rangeElem.value);
  return Number.isFinite(value) ? value : 1;
}

function getBaseThicknessValue() {
  if (!baseThicknessNumber || !baseThicknessRange) {
    return currentBaseThickness;
  }
  const value = Number(baseThicknessNumber.value || baseThicknessRange.value);
  return Number.isFinite(value) ? value : currentBaseThickness;
}

function downloadSTL() {
  if (!terrainMesh || !baseMesh) {
    alert("地形データが読み込まれていません。");
    return;
  }

  const geometries = [];
  terrainGroup.updateMatrixWorld(true);
  modelGroup.updateMatrixWorld(true);

  terrainGroup.traverse((obj) => {
    if (obj.isMesh) {
      const geom = obj.geometry.clone();
      geom.applyMatrix4(obj.matrixWorld);
      geometries.push(geom);
    }
  });
  if (baseMesh) {
    const geom = baseMesh.geometry.clone();
    geom.applyMatrix4(baseMesh.matrixWorld);
    geometries.push(geom);
  }
  if (geometries.length === 0) {
    alert("エクスポートするジオメトリがありません。");
    return;
  }

  const merged = BufferGeometryUtils.mergeBufferGeometries(geometries, true);
  geometries.forEach((geom) => geom.dispose());
  merged.computeVertexNormals();

  const exporter = new STLExporter();
  const stlMesh = new THREE.Mesh(merged);
  const stlString = exporter.parse(stlMesh);
  stlMesh.geometry.dispose();
  const blob = new Blob([stlString], { type: "application/vnd.ms-pki.stl" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${currentDownloadBaseName || "terrain"}.stl`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function parseDimensionName(dim) {
  if (!dim) {
    return "";
  }
  if (typeof dim === "string") {
    return dim;
  }
  if (typeof dim.name === "string") {
    return dim.name;
  }
  return String(dim);
}

function makeSafeFilename(name) {
  if (!name) return "terrain";
  const safe = name.toLowerCase().replace(/[^a-z0-9_\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "terrain";
}

async function parseNetCDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const reader = new NetCDFReader(new Uint8Array(arrayBuffer));

  const latVar = findVariable(reader, LAT_CANDIDATES);
  const lonVar = findVariable(reader, LON_CANDIDATES);
  if (!latVar || !lonVar) {
    throw new Error("緯度または経度の変数が見つかりませんでした");
  }

  const latData = Array.from(reader.getDataVariable(latVar.name));
  const lonData = Array.from(reader.getDataVariable(lonVar.name));
  if (latData.length < 2 || lonData.length < 2) {
    throw new Error("緯度・経度の配列が短すぎます");
  }

  const dimensionMap = new Map(reader.dimensions.map((dim) => [dim.name, dim.size]));
  const latDimName = parseDimensionName((latVar.dimensions && latVar.dimensions[0]) || latVar.name);
  const lonDimName = parseDimensionName((lonVar.dimensions && lonVar.dimensions[0]) || lonVar.name);
  const latCount = dimensionMap.get(latDimName) || latData.length;
  const lonCount = dimensionMap.get(lonDimName) || lonData.length;

  const elevVar = findElevationVariable(reader, latDimName, lonDimName);
  if (!elevVar) {
    throw new Error("標高データの変数が見つかりませんでした");
  }

  const elevationGrid = reshapeElevationGrid(reader, elevVar, latDimName, lonDimName, latCount, lonCount);
  const trimmedLat = latData.slice(0, elevationGrid.length);
  const trimmedLon = lonData.slice(0, elevationGrid[0].length);

  return {
    lat: trimmedLat,
    lon: trimmedLon,
    elevation: elevationGrid,
    fileBaseName: file.name.replace(/\.nc$/i, "") || "terrain",
  };
}

function findVariable(reader, candidates) {
  const lowerCandidates = candidates.map((name) => name.toLowerCase());
  return reader.variables.find((variable) => lowerCandidates.includes(variable.name.toLowerCase()));
}

function findElevationVariable(reader, latDimName, lonDimName) {
  const lowerCandidates = ELEVATION_CANDIDATES.map((name) => name.toLowerCase());
  let variable = reader.variables.find((variable) => lowerCandidates.includes(variable.name.toLowerCase()));
  if (variable) {
    return variable;
  }
  // fallback: variable that has both lat and lon dimensions
  return reader.variables.find((variable) => {
    const dimNames = (variable.dimensions || []).map((dim) => parseDimensionName(dim).toLowerCase());
    return dimNames.includes(latDimName.toLowerCase()) && dimNames.includes(lonDimName.toLowerCase());
  });
}

function reshapeElevationGrid(reader, elevationVar, latDimName, lonDimName, latCount, lonCount) {
  let data = reader.getDataVariable(elevationVar.name);
  if (!Array.isArray(data)) {
    data = Array.from(data);
  }

  const dimNames = (elevationVar.dimensions || []).map((dim) => parseDimensionName(dim));
  let dimSizes = dimNames.map((name) => reader.dimensions.find((d) => d.name === name)?.size || 0);

  if (dimNames.length === 0) {
    throw new Error("標高データの次元情報を取得できません");
  }

  // remove leading size-1 dimensions that are not lat/lon (e.g., time)
  while (dimNames.length > 2 && dimSizes[0] === 1 && dimNames[0] !== latDimName && dimNames[0] !== lonDimName) {
    const sliceSize = dimSizes.slice(1).reduce((acc, v) => acc * (v || 1), 1);
    data = data.slice(0, sliceSize);
    dimNames.shift();
    dimSizes.shift();
  }
  // remove trailing size-1 dimensions
  while (dimNames.length > 2 && dimSizes[dimSizes.length - 1] === 1) {
    dimNames.pop();
    dimSizes.pop();
  }

  if (dimNames.length !== 2) {
    throw new Error("標高データの次元が緯度・経度に対応していません");
  }

  const firstName = dimNames[0];
  const secondName = dimNames[1];
  const firstSize = dimSizes[0] || (firstName === latDimName ? latCount : lonCount);
  const secondSize = dimSizes[1] || (secondName === lonDimName ? lonCount : latCount);

  const totalSize = firstSize * secondSize;
  if (data.length < totalSize) {
    throw new Error("標高データの長さが不足しています");
  }

  const grid = Array.from({ length: latCount }, () => new Array(lonCount).fill(0));
  const latNameLower = latDimName.toLowerCase();
  const lonNameLower = lonDimName.toLowerCase();
  const firstIsLat = firstName.toLowerCase() === latNameLower || (firstSize === latCount && secondSize === lonCount);
  const firstIsLon = firstName.toLowerCase() === lonNameLower || (firstSize === lonCount && secondSize === latCount);

  if (firstIsLat && secondSize === lonCount) {
    for (let j = 0; j < latCount; j++) {
      const offset = j * lonCount;
      for (let i = 0; i < lonCount; i++) {
        grid[j][i] = data[offset + i];
      }
    }
    return grid;
  }

  if (firstIsLon && secondSize === latCount) {
    for (let j = 0; j < latCount; j++) {
      for (let i = 0; i < lonCount; i++) {
        grid[j][i] = data[i * latCount + j];
      }
    }
    return grid;
  }

  throw new Error("標高データの次元順序を解釈できません");
}

function setStatus(message, type = "info") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove("error", "success");
  if (type === "error") {
    statusEl.classList.add("error");
  } else if (type === "success") {
    statusEl.classList.add("success");
  }
}

function updateSummary(info) {
  if (!summaryEl) return;
  if (!info) {
    summaryEl.textContent = "";
    return;
  }
  const { lat, lon, minElev, maxElev, sourceLabel } = info;
  const latStats = arrayMinMax(lat);
  const lonStats = arrayMinMax(lon);
  summaryEl.innerHTML = `
    <div><strong>データ源:</strong> ${escapeHtml(sourceLabel || "-")}</div>
    <div><strong>グリッド:</strong> ${lat.length} × ${lon.length} (緯度 × 経度)</div>
    <div><strong>緯度範囲:</strong> ${formatNumber(latStats.min, 4)} 〜 ${formatNumber(latStats.max, 4)}</div>
    <div><strong>経度範囲:</strong> ${formatNumber(lonStats.min, 4)} 〜 ${formatNumber(lonStats.max, 4)}</div>
    <div><strong>標高:</strong> ${formatNumber(minElev, 2)} 〜 ${formatNumber(maxElev, 2)} m</div>
  `;
}

function formatNumber(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}


function arrayMinMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const raw of values) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === Infinity) min = NaN;
  if (max === -Infinity) max = NaN;
  return { min, max };
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function frameCamera() {
  if (!terrainMesh) {
    return;
  }
  const bbox = new THREE.Box3().setFromObject(modelGroup);
  const size = bbox.getSize(new THREE.Vector3());
  const center = bbox.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z);
  const distance = Math.max(maxSize * 1.8, 1.5);
  if (!Number.isFinite(distance)) {
    return;
  }
  camera.position.copy(center).add(new THREE.Vector3(distance, distance, distance));
  controls.target.copy(center);
  controls.update();
}

function typeCheckCanvasSize() {
  const width = container.clientWidth;
  const height = container.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
