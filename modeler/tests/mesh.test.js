/* Topology tests for the editable-poly core.
   The core is extracted straight out of index.html so there is exactly one
   copy of it: run with `node tests/mesh.test.js` from this directory. */
const fs = require('fs'), path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.split('/* <mesh-core>')[1].split('/* </mesh-core> */')[0]
                .replace(/^[^\n]*\n/, '');          // drop the rest of the marker line
const M = new Function(src + `
  return { boxMesh, cloneMesh, topology, compact, faceNormal, faceCentroid,
           extrudeFaces, chamferEdges, add, sub, scale, cross, dot, norm };`)();

let pass = 0, fail = 0;
const ck = (n, ok, d='') => { ok?pass++:fail++; console.log(`  [${ok?'ok ':'FAIL'}] ${n}${d?'  '+d:''}`); };

function stats(m) {
  const T = M.topology(m);
  let nonManifold = 0, open = 0;
  T.edges.forEach(e => { if (e.he.length !== 2) (e.he.length < 2 ? open++ : nonManifold++); });
  return { V:m.P.length, F:m.F.length, E:T.edges.size,
           euler:m.P.length - T.edges.size + m.F.length, nonManifold, open };
}
function normalsOutward(m) {                 // valid for the convex cases below
  let c = [0,0,0];
  m.P.forEach(p => { c = M.add(c, p); });
  c = M.scale(c, 1/m.P.length);
  return m.F.every(f => M.dot(M.faceNormal(m,f), M.sub(M.faceCentroid(m,f), c)) > 0);
}
function volume(m) {                          // signed, divergence theorem
  let v = 0;
  m.F.forEach(f => { for (let i = 1; i + 1 < f.length; i++)
    v += M.dot(m.P[f[0]], M.cross(m.P[f[i]], m.P[f[i+1]])) / 6; });
  return v;
}
function allEdges(m) { const o = []; M.topology(m).edges.forEach(e => o.push([e.a, e.b])); return o; }
const sane = s => s.euler === 2 && s.nonManifold === 0 && s.open === 0;

const cube = M.boxMesh(2,2,2);
console.log('box');
ck('V8 E12 F6', JSON.stringify(stats(cube)).includes('"V":8,"F":6,"E":12'), JSON.stringify(stats(cube)));
ck('closed manifold, euler 2', sane(stats(cube)));
ck('normals outward', normalsOutward(cube));
ck('volume 8', Math.abs(volume(cube) - 8) < 1e-9);

console.log('extrude');
const ex = M.extrudeFaces(cube, [1], 1.0);
ck('one face -> V12 E20 F10', JSON.stringify(stats(ex.mesh)).includes('"V":12,"F":10,"E":20'), JSON.stringify(stats(ex.mesh)));
ck('closed manifold', sane(stats(ex.mesh)));
ck('volume 8 -> 12', Math.abs(volume(ex.mesh) - 12) < 1e-9);
ck('cap reported for a repeat pass', ex.selection.length === 1);
const ex2 = M.extrudeFaces(cube, [1,5], 0.5);
ck('two adjacent faces stay manifold', sane(stats(ex2.mesh)) && volume(ex2.mesh) > 8);
ck('negative extrude stays manifold', sane(stats(M.extrudeFaces(cube, [1], -0.5).mesh)));

console.log('chamfer');
const bev = M.chamferEdges(cube, allEdges(cube), 0.3).mesh;
ck('all 12 edges -> V24 E48 F26', JSON.stringify(stats(bev)).includes('"V":24,"F":26,"E":48'), JSON.stringify(stats(bev)));
ck('closed manifold', sane(stats(bev)));
ck('normals outward', normalsOutward(bev));
ck('18 quads + 8 triangles',
   bev.F.filter(f=>f.length===4).length===18 && bev.F.filter(f=>f.length===3).length===8);
ck('cuts back exactly by the amount', (() => {
  const tri = bev.F.find(f => f.length === 3);
  return tri.map(i => bev.P[i]).every(p => p.every(v => Math.abs(Math.abs(v) - 0.7) < 1e-9 ||
                                                        Math.abs(Math.abs(v) - 1.0) < 1e-9));
})());

const one = M.chamferEdges(cube, [[6,7]], 0.3).mesh;
ck('a single edge produces a chamfer face', one.F.length === 7, `F=${one.F.length}`);
ck('closed manifold', sane(stats(one)));
ck('normals outward', normalsOutward(one));
ck('two pentagons appear', one.F.filter(f=>f.length===5).length === 2);

const loop = M.chamferEdges(cube, [[4,5],[5,6],[6,7],[7,4]], 0.25).mesh;
ck('a 4-edge loop stays manifold', sane(stats(loop)));
ck('loop normals outward', normalsOutward(loop));
ck('loop bevel has real area', loop.F.every(f => {
  const n = M.faceNormal(loop, f); return Math.hypot(n[0],n[1],n[2]) > 1e-9;
}));

console.log('robustness');
ck('oversized amount is clamped', (() => {
  const big = M.chamferEdges(M.boxMesh(2,2,2), allEdges(cube), 99);
  return big && sane(stats(big.mesh)) && volume(big.mesh) > 0;
})());
ck('empty selections are no-ops',
   M.chamferEdges(cube, [], 0.3) === null && M.extrudeFaces(cube, [], 1) === null);
ck('extrude then chamfer stays manifold', (() => {
  const a = M.extrudeFaces(M.boxMesh(2,2,2), [1], 1.2).mesh;
  const b = M.chamferEdges(a, allEdges(a), 0.2);
  return b && sane(stats(b.mesh));
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
