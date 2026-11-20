import * as THREE from 'three';
import type { Garment, Look } from './rigs';

/** Bones the appearance code attaches props to. */
export interface AttachBones {
  head?: THREE.Bone;
  neck?: THREE.Bone;
  spine2?: THREE.Bone;
  lArm?: THREE.Bone;
  rArm?: THREE.Bone;
  lForeArm?: THREE.Bone;
  rForeArm?: THREE.Bone;
  lHand?: THREE.Bone;
  rHand?: THREE.Bone;
}

/** Per-layer alpha cutoff and shade for the Hair_Shell_N meshes (inner
 *  layer darker, outer strand tips a touch lighter). */
const HAIR_SHELL_CUTOFF = [0.13, 0.45, 0.68];
const HAIR_SHELL_TINT = [0.75, 0.95, 1.06];

/** Recolour one Ready Player Me style mesh by material name. Materials are
 *  cloned per character and pushed to `owned` for disposal. */
export function applyLook(mesh: THREE.Mesh, look: Look, owned: THREE.Material[]) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const next = mats.map((m): THREE.Material => {
    const shell = /^Hair_Shell_(\d)$/.exec(m.name);
    if (shell) {
      // Blender-built layered haircut (scratch build_male.py / hair_v3.py):
      // strand texture RGB = luminance, A = strand height; COLOR_0 alpha =
      // density (fades at the hairline). Each shell alpha-tests at its own
      // cutoff so the outer layers only keep the longer strands.
      const k = Number(shell[1]);
      const src = m as THREE.MeshStandardMaterial;
      const hair = new THREE.MeshStandardMaterial({
        name: m.name,
        map: src.map,
        normalMap: src.normalMap,
        normalScale: new THREE.Vector2(0.8, 0.8),
        color: new THREE.Color(look.hair).multiplyScalar(HAIR_SHELL_TINT[k] ?? 1),
        roughness: look.hairGrey ? 0.7 : 0.78,
        metalness: 0,
        envMapIntensity: 0.35,
        vertexColors: true,
        transparent: false,
        depthWrite: true,
        alphaTest: HAIR_SHELL_CUTOFF[k] ?? 0.5,
        alphaToCoverage: true,
      });
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
      case 'Skin_Extra':
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
      case 'Saree_Cloth':
        garment(look.top);
        break;
      case 'Wolf3D_Outfit_Bottom':
      case 'Dhoti_Cloth':
        garment(look.bottom);
        break;
      case 'Saree_Border':
        c.color.set(look.border ?? '#d4a640');
        break;
      case 'Saree_Blouse':
        c.color.set(look.blouse ?? look.border ?? '#d4a640');
        break;
      case 'Wolf3D_Outfit_Footwear':
        if (look.shoes) c.color.set(look.shoes);
        break;
      case 'Doctor_Shirt':
        // Theatre gown: the shirt collar takes the gown colour too.
        if (look.surgical) garment(look.top);
        break;
    }
    return c;
  });
  mesh.material = Array.isArray(mesh.material) ? next : next[0];
  const names = mats.map((m) => m.name);
  // The bouffant cap covers all hair (and a mask hides any beard).
  if (look.surgical && names.some((n) => /^Hair_Shell_|^Wolf3D_Hair$|^Wolf3D_Beard$/.test(n))) {
    mesh.visible = false;
    return;
  }
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

/** Procedural extras parented to bones: dupatta, stethoscope,
 *  ID badge. Built in bind-pose model space, fitted to the mesh surface.
 *  Call with the model detached and in bind pose. */
export function addAttachments(model: THREE.Object3D, bones: AttachBones, look: Look, owned: THREE.Material[]) {
  model.updateMatrixWorld(true);
  if (look.surgical) addTheatreAttire(model, bones, look.surgical, owned);
  const chest = bones.spine2;

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

/** Bouffant cap, surgical mask and gloves for theatre staff, fitted to the
 *  head mesh (Wolf3D_Skin) and parented to the head / hand bones. */
function addTheatreAttire(model: THREE.Object3D, bones: AttachBones, kit: NonNullable<Look['surgical']>, owned: THREE.Material[]) {
  const head = bones.head;
  const pts = head ? bodyPoints(model, /^Wolf3D_Skin$/) : [];
  if (head && pts.length > 20) {
    const box = new THREE.Box3().setFromPoints(pts);
    const halfW = (box.max.x - box.min.x) / 2;
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const crown = box.max.y;
    const hh = Math.min(box.max.y - box.min.y, halfW * 2 * 1.45);
    const frontR = box.max.z - cz;
    const backR = cz - box.min.z;

    const capMat = new THREE.MeshStandardMaterial({ color: kit.cap, roughness: 0.92, side: THREE.DoubleSide });
    const maskMat = new THREE.MeshStandardMaterial({ color: kit.mask, roughness: 0.85, side: THREE.DoubleSide });
    owned.push(capMat, maskMat);

    // Cap: a slightly puffed dome from the hairline up, a touch lower at the back.
    const capH = 0.42 * hh;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
    cap.scale.set(halfW * 1.16, capH + 0.02 * hh, Math.max(frontR, backR) * 1.12);
    cap.position.set(cx, crown - capH, cz - 0.04 * hh);
    cap.rotation.x = -0.12;
    cap.castShadow = true;
    cap.updateMatrix();
    attach(head, cap);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 28, 1, true), capMat);
    band.scale.set(halfW * 1.15, 0.08 * hh, Math.max(frontR, backR) * 1.11);
    band.position.set(cx, crown - capH - 0.02 * hh, cz - 0.04 * hh);
    band.rotation.x = -0.12;
    band.updateMatrix();
    attach(head, band);

    // Mask: a pleated curve over nose, mouth and chin.
    const maskH = 0.36 * hh;
    const mask = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.92, 1, 22, 3, true, -1.3, 2.6), maskMat);
    mask.scale.set(halfW * 1.04, maskH, frontR * 1.03);
    mask.position.set(cx, crown - 0.76 * hh, cz);
    mask.castShadow = true;
    mask.updateMatrix();
    attach(head, mask);
    for (const sx of [-1, 1]) {
      const loop = new THREE.Mesh(new THREE.TorusGeometry(0.035 * hh * 4, 0.004, 4, 16, Math.PI), maskMat);
      loop.position.set(cx + sx * halfW * 0.98, crown - 0.62 * hh, cz - 0.01);
      loop.rotation.set(0, Math.PI / 2, Math.PI / 2);
      loop.updateMatrix();
      attach(head, loop);
    }
  }

  if (kit.gloves) {
    const gloveMat = new THREE.MeshStandardMaterial({ color: kit.gloves, roughness: 0.45 });
    owned.push(gloveMat);
    const pairs: Array<[THREE.Bone | undefined, THREE.Bone | undefined]> = [
      [bones.lHand, bones.lForeArm],
      [bones.rHand, bones.rForeArm],
    ];
    for (const [hand, fore] of pairs) {
      if (!hand || !fore) continue;
      const H = hand.getWorldPosition(new THREE.Vector3());
      const F = fore.getWorldPosition(new THREE.Vector3());
      const dir = H.clone().sub(F);
      const len = dir.length();
      if (len < 1e-4) continue;
      dir.normalize();
      const r = len * 0.17;
      const glove = new THREE.Mesh(new THREE.CapsuleGeometry(r, len * 0.32, 4, 10), gloveMat);
      glove.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      glove.position.copy(H).addScaledVector(dir, len * 0.3);
      glove.scale.set(1, 1, 0.62);
      glove.castShadow = true;
      glove.updateMatrix();
      attach(hand, glove);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 1.05, len * 0.22, 12), gloveMat);
      cuff.quaternion.copy(glove.quaternion);
      cuff.position.copy(H).addScaledVector(dir, -len * 0.08);
      cuff.updateMatrix();
      attach(hand, cuff);
    }
  }
}
