import * as THREE from 'three';
import type { Garment, Look } from './rigs';

/** Bones the appearance code attaches props to. */
export interface AttachBones {
  head?: THREE.Bone;
  neck?: THREE.Bone;
  spine2?: THREE.Bone;
  lArm?: THREE.Bone;
  rArm?: THREE.Bone;
}

/** Recolour one Ready Player Me style mesh by material name. Materials are
 *  cloned per character and pushed to `owned` for disposal. */
export function applyLook(mesh: THREE.Mesh, look: Look, owned: THREE.Material[]) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const next = mats.map((m): THREE.Material => {
    if (m.name === 'Hair_Short') {
      // Blender-built haircut: strand texture, sheen, soft hairline via vertex alpha.
      const map = strandTexture(!!look.hairGrey);
      const hair = new THREE.MeshPhysicalMaterial({
        map,
        bumpMap: map,
        bumpScale: 1.5,
        color: '#ffffff',
        roughness: 0.6,
        sheen: 0.8,
        sheenRoughness: 0.45,
        sheenColor: new THREE.Color(look.hairGrey ? '#ece8e0' : '#4a3a2e'),
        vertexColors: true,
        transparent: true,
        alphaTest: 0.02,
      });
      hair.userData.ownedMap = map;
      owned.push(hair);
      return hair;
    }
    const c = (m as THREE.MeshStandardMaterial).clone();
    owned.push(c);
    c.envMapIntensity = 0.9;
    const garment = (g: Garment) => {
      if (!g.map) c.map = null;
      c.color.set(g.color);
      if (g.roughness !== undefined) c.roughness = g.roughness;
      c.needsUpdate = true;
    };
    switch (m.name) {
      case 'Wolf3D_Skin':
      case 'Wolf3D_Body':
        c.color.set(look.skin);
        c.roughness = Math.max(0.58, c.roughness);
        break;
      case 'Wolf3D_Hair':
      case 'Wolf3D_Beard':
        if (look.hairGrey) {
          c.map = null;
          c.needsUpdate = true;
        }
        c.color.set(look.hair);
        break;
      case 'Wolf3D_Outfit_Top':
      case 'Doctor_Coat':
      case 'Kurta_Cloth':
        garment(look.top);
        break;
      case 'Wolf3D_Outfit_Bottom':
        garment(look.bottom);
        break;
      case 'Wolf3D_Outfit_Footwear':
        if (look.shoes) c.color.set(look.shoes);
        break;
    }
    return c;
  });
  mesh.material = Array.isArray(mesh.material) ? next : next[0];
  const names = mats.map((m) => m.name);
  if (names.includes('Wolf3D_Headwear')) mesh.visible = false;
  if (names.includes('Wolf3D_Glasses')) mesh.visible = !!look.glasses;
  if (names.includes('Wolf3D_Beard') && look.beard === 'hide') mesh.visible = false;
}


/** World-space vertex cloud of the body meshes (bind pose), for fitting
 *  attachments to the actual surface. */
function bodyPoints(model: THREE.Object3D, names: RegExp): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (!mats.some((mm) => names.test(mm.name))) return;
    const pos = m.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 2) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push(v.clone());
    }
  });
  return out;
}

function surfaceZ(pts: THREE.Vector3[], x: number, y: number, dir: 1 | -1, fallback: number): number {
  let best = dir > 0 ? -Infinity : Infinity;
  for (const p of pts) {
    if (Math.abs(p.y - y) > 0.03 || Math.abs(p.x - x) > 0.05) continue;
    best = dir > 0 ? Math.max(best, p.z) : Math.min(best, p.z);
  }
  return Number.isFinite(best) ? best : fallback;
}

/** Flat cloth strip following a curve, lying on the torso surface. */
function ribbonGeometry(curve: THREE.Curve<THREE.Vector3>, width: number, axis: THREE.Vector3, segments = 80) {
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const r = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    r.set(p.x - axis.x, Math.max(0, p.y - axis.y), p.z - axis.z).normalize();
    side.crossVectors(t, r).normalize().multiplyScalar(width / 2);
    pos.push(p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z);
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Parent a mesh built in model (bind world) space to a bone, keeping it in place. */
function attach(bone: THREE.Bone, mesh: THREE.Object3D) {
  const inv = bone.matrixWorld.clone().invert();
  mesh.applyMatrix4(inv);
  bone.add(mesh);
}

const wp = (o: THREE.Object3D | undefined, fb: THREE.Vector3) => (o ? o.getWorldPosition(new THREE.Vector3()) : fb.clone());

/** Procedural extras parented to bones: short hair, dupatta, stethoscope,
 *  ID badge. Built in bind-pose model space, fitted to the mesh surface.
 *  Call with the model detached and in bind pose. */
export function addAttachments(model: THREE.Object3D, bones: AttachBones, look: Look, owned: THREE.Material[]) {
  model.updateMatrixWorld(true);
  const head = bones.head;
  const chest = bones.spine2;

  if (look.hairCap && head) {
    let headMesh: THREE.Mesh | null = null;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !Array.isArray(m.material) && m.material.name === 'Wolf3D_Skin') headMesh = m;
    });
    if (headMesh) {
      const hair = buildHairShell(headMesh, look, owned);
      if (hair) attach(head, hair);
    }
  }
  if (!chest) return;
  const torso = bodyPoints(model, /Wolf3D_Outfit_Top|Wolf3D_Body|Doctor_Coat|Doctor_Shirt|Kurta_Cloth/);
  const L = wp(bones.lArm, new THREE.Vector3(0.17, 1.4, 0));
  const R = wp(bones.rArm, new THREE.Vector3(-0.17, 1.4, 0));
  const N = wp(bones.neck, new THREE.Vector3(0, 1.5, 0));
  const C = wp(chest, new THREE.Vector3(0, 1.3, 0));
  const front = (x: number, y: number, off = 0.012) => surfaceZ(torso, x, y, 1, C.z + 0.1) + off;
  const back = (x: number, y: number, off = 0.012) => surfaceZ(torso, x, y, -1, C.z - 0.1) - off;

  if (look.dupatta) {
    const sy = (L.y + R.y) / 2 + 0.035;
    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const lx = L.x * 0.62, rx = R.x * 0.62;
    const pts = [
      P(L.x * 0.8, sy - 0.62, back(L.x * 0.8, sy - 0.62, 0.02)),
      P(L.x * 0.75, sy - 0.25, back(L.x * 0.75, sy - 0.25)),
      P(lx, sy, (front(lx, sy - 0.05) + back(lx, sy - 0.05)) / 2),
      P(L.x * 0.45, sy - 0.12, front(L.x * 0.45, sy - 0.12)),
      P(0, sy - 0.27, front(0, sy - 0.27, 0.02)),
      P(R.x * 0.45, sy - 0.12, front(R.x * 0.45, sy - 0.12)),
      P(rx, sy, (front(rx, sy - 0.05) + back(rx, sy - 0.05)) / 2),
      P(R.x * 0.75, sy - 0.25, back(R.x * 0.75, sy - 0.25)),
      P(R.x * 0.8, sy - 0.62, back(R.x * 0.8, sy - 0.62, 0.02)),
    ];
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const mat = new THREE.MeshStandardMaterial({ color: look.dupatta, roughness: 0.75, side: THREE.DoubleSide });
    owned.push(mat);
    const mesh = new THREE.Mesh(ribbonGeometry(curve, 0.19, new THREE.Vector3(C.x, sy - 0.2, C.z)), mat);
    mesh.castShadow = true;
    attach(chest, mesh);
  }

  if (look.stethoscope) {
    const ny = N.y;
    const pts = [
      new THREE.Vector3(N.x + 0.045, ny - 0.3, front(0.045, ny - 0.3)),
      new THREE.Vector3(N.x + 0.06, ny - 0.17, front(0.06, ny - 0.17)),
      new THREE.Vector3(N.x + 0.075, ny - 0.04, front(0.07, ny - 0.06)),
      new THREE.Vector3(N.x + 0.075, ny + 0.0, N.z),
      new THREE.Vector3(N.x, ny + 0.0, N.z - 0.07),
      new THREE.Vector3(N.x - 0.075, ny + 0.0, N.z),
      new THREE.Vector3(N.x - 0.075, ny - 0.04, front(-0.07, ny - 0.06)),
      new THREE.Vector3(N.x - 0.06, ny - 0.17, front(-0.06, ny - 0.17)),
      new THREE.Vector3(N.x - 0.04, ny - 0.27, front(-0.04, ny - 0.27)),
    ];
    const tubeMat = new THREE.MeshStandardMaterial({ color: '#1e2328', roughness: 0.45 });
    const metal = new THREE.MeshStandardMaterial({ color: '#d7dbe0', metalness: 1, roughness: 0.2 });
    const card = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 });
    const band = new THREE.MeshStandardMaterial({ color: '#2a5fa8', roughness: 0.4 });
    owned.push(tubeMat, metal, card, band);
    attach(chest, new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 56, 0.0055, 6, false), tubeMat));
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.012, 20), metal);
    bell.position.set(N.x - 0.04, ny - 0.295, front(-0.04, ny - 0.29, 0.02));
    bell.rotation.x = Math.PI / 2;
    bell.updateMatrix();
    attach(chest, bell);
    const badge = new THREE.Group();
    const cm = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.08, 0.004), card);
    const bm = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.02, 0.005), band);
    bm.position.y = 0.03;
    badge.add(cm, bm);
    const bx = L.x * 0.55;
    badge.position.set(bx, ny - 0.25, front(bx, ny - 0.25, 0.006));
    badge.updateMatrix();
    attach(chest, badge);
  }
}

/** Strand texture for the hair shell (runs front to back). */
function strandTexture(grey: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = grey ? '#a7a29b' : '#17110d';
  g.fillRect(0, 0, 256, 512);
  const tones = grey ? ['#d8d4cd', '#8f8a83', '#bdb8b0', '#6f6a64'] : ['#2c2119', '#0b0806', '#3b2c21', '#1f1712'];
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 512;
    const len = 30 + Math.random() * 90;
    g.strokeStyle = tones[i % tones.length];
    g.globalAlpha = 0.35 + Math.random() * 0.45;
    g.lineWidth = 0.6 + Math.random() * 1.1;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + (Math.random() - 0.5) * 6, y + len / 2, x + (Math.random() - 0.5) * 8, y + len);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Short neat haircut fitted to the actual scalp: the head mesh's scalp
 *  triangles above a hairline (high at the forehead, low at the nape) are
 *  copied and pushed out along their normals, thin at the hairline and
 *  fuller on top, with a strand texture running front to back. */
function buildHairShell(headMesh: THREE.Mesh, look: Look, owned: THREE.Material[]): THREE.Mesh | null {
  const geo = headMesh.geometry;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const index = geo.getIndex();
  if (!pos || !nor || !index) return null;
  const mw = headMesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(mw);
  const P: THREE.Vector3[] = [];
  const N: THREE.Vector3[] = [];
  let top = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mw);
    P.push(p);
    N.push(new THREE.Vector3().fromBufferAttribute(nor, i).applyMatrix3(nm).normalize());
    if (p.y > top) top = p.y;
  }
  // scalp centre from the upper skull
  const cap = P.filter((p) => p.y > top - 0.06);
  const cx = cap.reduce((a, p) => a + p.x, 0) / cap.length;
  const cz = cap.reduce((a, p) => a + p.z, 0) / cap.length;
  const hairline = (p: THREE.Vector3) => {
    const phi = Math.atan2(p.x - cx, p.z - cz); // 0 = forehead
    const f = (1 - Math.cos(phi)) / 2; // 0 front .. 1 nape
    const temple = Math.exp(-(((Math.abs(phi) - 0.75) / 0.25) ** 2)) * 0.012; // slight recession
    return top - (0.062 + 0.095 * f ** 1.4) + temple;
  };
  const keep = P.map((p) => p.y > hairline(p));
  const remap = new Map<number, number>();
  const outPos: number[] = [];
  const outUv: number[] = [];
  const outIdx: number[] = [];
  const vert = (i: number) => {
    let k = remap.get(i);
    if (k !== undefined) return k;
    const p = P[i];
    const d = p.y - hairline(p);
    const t = 0.0022 + 0.0105 * Math.min(1, Math.max(0, d / 0.035)) + 0.004 * Math.min(1, Math.max(0, (p.y - (top - 0.035)) / 0.035));
    const q = p.clone().addScaledVector(N[i], t);
    k = outPos.length / 3;
    outPos.push(q.x, q.y, q.z);
    const phi = Math.atan2(p.x - cx, p.z - cz);
    outUv.push((phi / (Math.PI * 2)) * 3, (top - p.y) * 9);
    remap.set(i, k);
    return k;
  };
  for (let f = 0; f < index.count; f += 3) {
    const a = index.getX(f), b = index.getX(f + 1), c = index.getX(f + 2);
    const n = (keep[a] ? 1 : 0) + (keep[b] ? 1 : 0) + (keep[c] ? 1 : 0);
    if (n < 2) continue;
    outIdx.push(vert(a), vert(b), vert(c));
  }
  if (!outIdx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  g.setIndex(outIdx);
  g.computeVertexNormals();
  const map = strandTexture(!!look.hairGrey);
  const mat = new THREE.MeshPhysicalMaterial({
    map,
    color: look.hairGrey ? '#ffffff' : '#ffffff',
    roughness: 0.55,
    sheen: 0.7,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color(look.hairGrey ? '#e8e4dc' : '#5a4436'),
    bumpMap: map,
    bumpScale: 1.2,
  });
  owned.push(mat);
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true;
  return mesh;
}
