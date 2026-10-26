/*
 * ISS Tracker - Himmel-Ebene: Sterne, Sonne, Planeten
 *
 * Alles liegt als Richtung auf einer Kugel mit Radius 2 um die Kamera
 * (Himmelsprojektion nah 0,5 / fern 4, Reversed-Z, nur Drehung der Kamera).
 * Jedes Objekt ist ein Bildschirm-Quad aus 6 Ecken (vertex_index), das im
 * Vertex-Shader in Geraetepixeln aufgezogen wird.
 *
 * Zwei Pipelines, ein Uniform (Himmel):
 *   - Sterne: statischer Instanzpuffer (setzeSterne, einmal mit der Praezession
 *     gedreht), je Instanz 20 Byte: Richtung float32x3, Magnitude f32, Farbe
 *     unorm8x4. Weicher Punkt 1,5 bis 6 px nach Magnitude, additiv (one/one).
 *   - Koerper (Task 16): Sonne + 5 Planeten als stilisierte Scheiben, ein
 *     Instanzpuffer mit 6 Eintraegen je Bild per writeBuffer, je Instanz
 *     40 Byte: Richtung float32x3, radiusPx f32 (Scheibenradius, Geraetepixel),
 *     quadPx f32 (halbe Quadseite), art f32 (0 Sonne, 1 Merkur, 2 Venus,
 *     3 Mars, 4 Jupiter, 5 Saturn), hell f32 (0 = ausgeblendet; Sonne:
 *     Blende am Erdrand), lichtWelt float32x3 (Richtung Planet -> Sonne im
 *     Aequatorsystem). Der Vertex-Shader dreht lichtWelt mit viewRot in den
 *     Blickraum und baut dort den Sprite-Rahmen (rechts/oben = Bildschirm-
 *     achsen, z zum Betrachter); der Fragment-Shader schattiert eine Kugel
 *     (Lambert, weicher Terminator, Randverdunklung), legt prozedurale
 *     Oberflaechen darueber (Wertrauschen, Baender, Flecken, Saturnring) und
 *     gibt vormultipliziertes Alpha aus: Scheibe deckend, Ring 0,8, Glow und
 *     Sonnenkorona additiv (Alpha 0). Blend one / one-minus-src-alpha.
 *     Die Sonne: weisser Kern, Korona, sechs weiche Strahlen, Schleier.
 *
 * Kein Tiefen-Attachment, MSAA 4x. Tonemapping ACES und sRGB-Kodierung im
 * Fragment-Shader (Helfer ausgabe(), dazu srgb() und linear()). Task 12c: diese
 * Helfer gibt es nur hier - Himmelszeichner.WGSL_AUSGABE ist die einzige Quelle,
 * erde.js/spur.js/iss.js stellen sie in neu() ihren Shadern voran (himmel.js
 * laedt in index.html vor ihnen). Groessen kommen in CSS-Pixeln (tracker.js
 * rechnet groessePx, hier mal dpr).
 *
 * Nichts hier fasst auf oberster Ebene navigator, document oder GPU* an.
 */
(function (window) {
	"use strict";

	// Uniform "Himmel": viewRot 0 (64), proj 64 (64), viewport 128 (8), dpr 136, grenzMag 140 -> 144 Byte
	var U_VIEWROT = 0, U_PROJ = 16, U_VIEWPORT = 32, U_DPR = 34, U_GRENZMAG = 35;   // Float-Indizes
	var U_BYTES = 144;
	var STRIDE = 20;                               // Byte je Stern-Instanz

	// ---- Task 16: Koerper - Stellschrauben (CSS-Pixel, Farben sRGB-Hex; im Shader linear)
	var KOERPER_MAX = 6;                           // Sonne + 5 Planeten
	var KOERPER_STRIDE = 40;                       // Byte je Koerper-Instanz (10 Floats)
	var SONNE_KERN_PX = 14;                        // Kern-Durchmesser
	var SONNE_KORONA_PX = 55;                      // Reichweite der Korona exp(-(px/55)^2 * 2.2) (sichtbar ~120 px Durchmesser)
	var SONNE_STRAHLEN_PX = 160;                   // Reichweite der Strahlen
	var SONNE_SCHLEIER_PX = 160;                   // Ueberstrahlungsschleier (= halbe Quadseite)
	var SONNE_BLENDE_PX = 20;                      // Winkelradius (px) fuer die Ausblendung am Erdrand (tracker.js)
	var SONNE_KERN_HELL = 6.0;                     // linear, ACES saettigt zu Weiss
	var SONNE_KORONA_STAERKE = 0.35;               // linear am Kernrand
	var SONNE_KORONA_DECKUNG = 0.7;                // Alpha der Korona (Sterne dahinter gedaempft): min(1, kern + 0.7 * exp(..))
	var SONNE_STRAHLEN_STAERKE = 0.14;             // duenne Strahlen: pow(|cos 3w|, 70), zweiter 2-zaehliger Satz um 30 Grad mit halbem Gewicht
	var SONNE_STRAHLEN_EXPONENT = 70;
	var SONNE_STRAHLEN_DREHUNG = 0.26;             // rad; Strahlen nicht achsparallel
	var SONNE_SCHLEIER_ALPHA = 0.03;               // linear im Zentrum, quadratisch auf 0 am Rand
	var SONNE_FARBE_INNEN = "#ffffff", SONNE_FARBE_AUSSEN = "#ffd9a8";   // weiss -> hellgelb -> blassorange
	var SONNE_FARBE_RAMPE = 0.7;                   // Mischung innen -> aussen saettigt erst bei t * 0.7 = 1 (t = px / KORONA_PX)
	var PLANET_MIN_PX = 12;                        // Rueckfall, wenn tracker.js keine groessePx liefert (Desktop 12..16, Kompakt 8..12)
	var PLANET_AUSDEHNUNG = 2.6;                   // halbe Quadseite in Scheibenradien (Glow, Saturnring bis 2,3)
	var PLANET_GLOW = 0.35, PLANET_GLOW_FALL = 1.5; // Glow exp(-r^2 * 1.5) * 0.35 in der Grundfarbe, ausserhalb der Scheibe
	var PLANET_NACHT = 0.04;                       // Nachtseite: Anteil der Grundfarbe
	var PLANET_TERMINATOR = 0.08;                  // smoothstep(-0.08, 0.08, n . licht)
	var PLANET_RAND = 0.35;                        // Randverdunklung pow(n.z, 0.35)
	var RING_AUSSEN = 2.3, RING_INNEN = 1.25;      // Saturnring in Scheibenradien (Breite 2,3 Scheibendurchmesser)
	var RING_NEIGUNG = 26 / 180 * Math.PI;         // feste Kippung der Ringebene (Achsenverhaeltnis sin 26 = 0,44; Brief 0,42)
	var RING_ACHSE = Math.sin(RING_NEIGUNG);       // Achsenverhaeltnis der Ringellipse im Bild (0,438; passt zur Tiefe vorne/hinten)
	var RING_LUECKE = 0.72, RING_LUECKE_BREITE = 0.06, RING_LUECKE_TIEFE = 0.65;   // Cassini-Luecke bei 0,72 des Ringradius, im Alpha (0,8 -> 0,28)
	var RING_ALPHA = 0.8;
	var RING_SCHATTEN_Y = 0.35, RING_SCHATTEN_BREITE = 0.12, RING_SCHATTEN_TIEFE = 0.5;   // Ringschatten-Band auf der Nordhaelfte (gegenueber dem vorderen Ring)
	var FARBEN = {
		merkur: "#8f8b86", venus: "#f2e3b8",
		mars: "#c8582a", marsDunkel: "#7a3a1c",
		jupiterHell: "#e8d3ab", jupiterDunkel: "#b07a4a", jupiterFleck: "#c05a3a",
		saturn: "#e2c78e", ring: "#d8c9a3"
	};

	// sRGB-Hex -> lineares vec3 als WGSL-Text (Konstanten werden in den Shader eingesetzt)
	function linearHex(hex) {
		var aus = [];
		for (var i = 0; i < 3; i++) {
			var c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
			aus.push(c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
		}
		return "vec3<f32>(" + aus.map(function (v) { return v.toFixed(5); }).join(", ") + ")";
	}
	function f(x) { return Number(x).toFixed(6); }

	// ACES (Naeherung nach Narkowicz 2015) und sRGB-Kodierung - letzter Schritt
	// jedes Fragment-Shaders, weil die Canvas bgra8unorm ohne -srgb ist.
	var WGSL_AUSGABE = `
fn aces(x: vec3<f32>) -> vec3<f32> {
	let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
	return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3(0.0), vec3(1.0));
}
fn srgb(c: vec3<f32>) -> vec3<f32> {
	let klein = c * 12.92;
	let gross = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
	return select(gross, klein, c <= vec3(0.0031308));
}
fn linear(c: vec3<f32>) -> vec3<f32> {
	let klein = c / 12.92;
	let gross = pow((c + 0.055) / 1.055, vec3(2.4));
	return select(gross, klein, c <= vec3(0.04045));
}
fn ausgabe(farbe: vec3<f32>) -> vec3<f32> { return srgb(aces(max(farbe, vec3(0.0)))); }
`;

	var WGSL_HIMMEL = `
struct Himmel { viewRot: mat4x4<f32>, proj: mat4x4<f32>, viewport: vec2<f32>, dpr: f32, grenzMag: f32 };
@group(0) @binding(0) var<uniform> H: Himmel;
`;

	// ---- Sterne: weicher Punkt, Groesse und Helligkeit nach Magnitude, additiv
	var WGSL_STERNE = WGSL_AUSGABE + WGSL_HIMMEL + `
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) farbe: vec3<f32>, @location(2) hell: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) richtung: vec3<f32>, @location(1) mag: f32, @location(2) farbe: vec4<f32>) -> VOut {
	var ecken = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(1.,1.), vec2(-1.,-1.), vec2(1.,1.), vec2(-1.,1.));
	let e = ecken[vi];
	let clip = H.proj * (H.viewRot * vec4(richtung * 2.0, 1.0));   // Richtung auf Radius 2 (nah 0.5, fern 4)
	let px = clamp(1.5 + (6.5 - mag) * 0.7, 1.5, 6.0) * H.dpr;    // Durchmesser in Pixeln
	var o: VOut;
	o.pos = vec4(clip.xy + e * px / H.viewport * clip.w, clip.z, clip.w);
	// Farbe bewusst unlinearisiert (Task 12c gemessen: linear() saettigte die
	// Sternfarben sichtbar, Orange 192/183/171 -> 192/165/131, bis 40 Stufen) -
	// eine Look-Entscheidung, keine Aufraeumarbeit.
	o.uv = e; o.farbe = farbe.rgb;
	o.hell = select(clamp(pow(10.0, -0.4 * (mag - 2.0)), 0.03, 1.0), 0.0, mag > H.grenzMag);
	return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
	let r2 = dot(i.uv, i.uv); if (r2 > 1.0) { discard; }
	let kern = exp(-r2 * 3.0);                                          // weicher Kern
	let farbe = i.farbe * i.hell * kern;
	return vec4(ausgabe(farbe), 1.0);                                   // ACES + sRGB, Helfer im selben Modul
}
`;

	// ---- Koerper: Sonne und Planeten als Scheiben (Task 16)
	// uv ist in Scheibenradien (r = 1 Scheibenrand); beim Sonnen-Sprite ist der
	// Kernradius die Einheit und der Shader rechnet in CSS-Pixeln weiter.
	// Ableitungen (fwidth) nur im uniformen Kontrollfluss am Anfang von fs.
	var WGSL_KOERPER = WGSL_AUSGABE + WGSL_HIMMEL + `
const MERKUR = ${linearHex(FARBEN.merkur)};
const VENUS = ${linearHex(FARBEN.venus)};
const MARS = ${linearHex(FARBEN.mars)};
const MARS_DUNKEL = ${linearHex(FARBEN.marsDunkel)};
const JUPITER_HELL = ${linearHex(FARBEN.jupiterHell)};
const JUPITER_DUNKEL = ${linearHex(FARBEN.jupiterDunkel)};
const JUPITER_FLECK = ${linearHex(FARBEN.jupiterFleck)};
const SATURN = ${linearHex(FARBEN.saturn)};
const RING = ${linearHex(FARBEN.ring)};
const SONNE_INNEN = ${linearHex(SONNE_FARBE_INNEN)};
const SONNE_AUSSEN = ${linearHex(SONNE_FARBE_AUSSEN)};
const SONNE_KORONA_PX: f32 = ${f(SONNE_KORONA_PX)};
const SONNE_STRAHLEN_PX: f32 = ${f(SONNE_STRAHLEN_PX)};
const SONNE_SCHLEIER_PX: f32 = ${f(SONNE_SCHLEIER_PX)};
const SONNE_KERN_HELL: f32 = ${f(SONNE_KERN_HELL)};
const SONNE_KORONA_STAERKE: f32 = ${f(SONNE_KORONA_STAERKE)};
const SONNE_KORONA_DECKUNG: f32 = ${f(SONNE_KORONA_DECKUNG)};
const SONNE_STRAHLEN_STAERKE: f32 = ${f(SONNE_STRAHLEN_STAERKE)};
const SONNE_STRAHLEN_EXPONENT: f32 = ${f(SONNE_STRAHLEN_EXPONENT)};
const SONNE_STRAHLEN_DREHUNG: f32 = ${f(SONNE_STRAHLEN_DREHUNG)};
const SONNE_SCHLEIER_ALPHA: f32 = ${f(SONNE_SCHLEIER_ALPHA)};
const SONNE_FARBE_RAMPE: f32 = ${f(SONNE_FARBE_RAMPE)};
const RING_SCHATTEN_Y: f32 = ${f(RING_SCHATTEN_Y)};
const RING_SCHATTEN_BREITE: f32 = ${f(RING_SCHATTEN_BREITE)};
const RING_SCHATTEN_TIEFE: f32 = ${f(RING_SCHATTEN_TIEFE)};
const GLOW: f32 = ${f(PLANET_GLOW)};
const GLOW_FALL: f32 = ${f(PLANET_GLOW_FALL)};
const NACHT: f32 = ${f(PLANET_NACHT)};
const TERMINATOR: f32 = ${f(PLANET_TERMINATOR)};
const RAND: f32 = ${f(PLANET_RAND)};
const RING_AUSSEN: f32 = ${f(RING_AUSSEN)};
const RING_INNEN: f32 = ${f(RING_INNEN)};
const RING_ACHSE: f32 = ${f(RING_ACHSE)};
const RING_COS: f32 = ${f(Math.cos(RING_NEIGUNG))};
const RING_SIN: f32 = ${f(Math.sin(RING_NEIGUNG))};
const RING_LUECKE: f32 = ${f(RING_LUECKE)};
const RING_LUECKE_BREITE: f32 = ${f(RING_LUECKE_BREITE)};
const RING_LUECKE_TIEFE: f32 = ${f(RING_LUECKE_TIEFE)};
const RING_ALPHA: f32 = ${f(RING_ALPHA)};

struct KOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,                          // Scheibenradius = 1
	@location(1) @interpolate(flat) art: f32,
	@location(2) @interpolate(flat) hell: f32,
	@location(3) @interpolate(flat) licht: vec3<f32>,    // Sprite-Rahmen: x rechts, y oben, z zum Betrachter
	@location(4) @interpolate(flat) radiusPx: f32        // Scheibenradius in Geraetepixeln
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) richtung: vec3<f32>, @location(1) radiusPx: f32,
              @location(2) quadPx: f32, @location(3) art: f32, @location(4) hell: f32, @location(5) lichtWelt: vec3<f32>) -> KOut {
	var ecken = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(1.,1.), vec2(-1.,-1.), vec2(1.,1.), vec2(-1.,1.));
	let e = ecken[vi];
	let clip = H.proj * (H.viewRot * vec4(richtung * 2.0, 1.0));
	let halb = select(quadPx, 0.0, hell <= 0.0);                     // ausgeblendet: Quad auf einen Punkt, keine Fragmente
	var o: KOut;
	o.pos = vec4(clip.xy + e * 2.0 * halb / H.viewport * clip.w, clip.z, clip.w);
	o.uv = e * quadPx / max(radiusPx, 1e-3);
	o.art = art; o.hell = hell; o.radiusPx = radiusPx;
	// Sprite-Rahmen im Blickraum: dv = Blickrichtung zum Koerper, rechts = dv x oben,
	// oben = rechts x dv (rechtshaendig; auf der Achse genau die Bildschirmachsen,
	// Kamera-Roll und Perspektive ausserhalb der Achse inklusive).
	let dv = normalize((H.viewRot * vec4(richtung, 0.0)).xyz);
	let lv = (H.viewRot * vec4(lichtWelt, 0.0)).xyz;
	let hilf = select(vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), abs(dv.y) > 0.99);
	let rechts = normalize(cross(dv, hilf));
	let oben = cross(rechts, dv);
	o.licht = vec3(dot(lv, rechts), dot(lv, oben), -dot(lv, dv));
	return o;
}

fn hash(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// Wertrauschen (bilinear zwischen Gitter-Hashes, glatt) - weisses Rauschen je
// Pixel wuerde bei Subpixelbewegung des Sprites flimmern.
fn rauschen(p: vec2<f32>) -> f32 {
	let i = floor(p); let fr = fract(p); let u = fr * fr * (3.0 - 2.0 * fr);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Grundfarbe je Art (fuer den Glow)
fn grundfarbe(art: f32) -> vec3<f32> {
	if (art < 1.5) { return MERKUR; }
	if (art < 2.5) { return VENUS; }
	if (art < 3.5) { return MARS; }
	if (art < 4.5) { return mix(JUPITER_HELL, JUPITER_DUNKEL, 0.5); }
	return SATURN;
}
// Oberflaechenfarbe (linear) an der Kugelnormalen n (Sprite-Rahmen) und Sprite-Position uv
fn oberflaeche(art: f32, n: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
	let q = n.xy;
	if (art < 1.5) {                                                   // Merkur: grau mit dunklen Flecken
		let flecken = smoothstep(0.5, 0.78, rauschen(q * 4.0 + vec2(3.1, 7.7)));
		return MERKUR * (1.0 - 0.45 * flecken);
	}
	if (art < 2.5) {                                                   // Venus: gleichmaessig, leichte Marmorierung
		let marmor = rauschen(q * 3.0 + vec2(11.0, 2.0));
		return VENUS * (0.96 + 0.06 * sin(n.y * 5.0 + marmor * 2.5));
	}
	if (art < 3.5) {                                                   // Mars: dunkle Flecken, Polkappe oben
		let flecken = smoothstep(0.45, 0.72, rauschen(q * 3.5 + vec2(7.0, 1.5)));
		let f = mix(MARS, MARS_DUNKEL, flecken * 0.85);
		let kappe = smoothstep(0.78, 0.95, n.y);
		return mix(f, vec3(0.9), kappe * 0.8);
	}
	if (art < 4.5) {                                                   // Jupiter: Baender, Grosser Roter Fleck
		let wobbel = rauschen(q * 5.0 + vec2(1.0, 9.0));
		let t = 0.5 + 0.5 * sin(n.y * 11.0 + wobbel * 0.6);
		let f = mix(JUPITER_HELL, JUPITER_DUNKEL, t);
		let d = (uv - vec2(0.35, -0.25)) / vec2(0.2, 0.11);
		let fleck = 1.0 - smoothstep(0.75, 1.15, length(d));
		return mix(f, JUPITER_FLECK, fleck);
	}
	// Saturn: zarte Baender in der um RING_NEIGUNG gekippten Aequatorebene; dazu das
	// Ringschatten-Band auf der Nordhaelfte (oben, gegenueber dem vorderen Ring unten).
	let lat = n.y * RING_COS + n.z * RING_SIN;
	let wobbel = rauschen(q * 4.0 + vec2(5.0, 5.0));
	let ds = (uv.y - RING_SCHATTEN_Y) / RING_SCHATTEN_BREITE;
	let schatten = 1.0 - RING_SCHATTEN_TIEFE * exp(-ds * ds);
	return SATURN * (0.93 + 0.07 * sin(lat * 9.0 + wobbel * 0.8)) * schatten;
}

// Planet: Glow (additiv) -> Scheibe (deckend) -> Ring (Alpha 0,8), von hinten nach
// vorn vormultipliziert zusammengesetzt; jede Ebene einzeln durch ausgabe().
fn planet(i: KOut, r: f32, wR: f32, rr: f32, wRR: f32) -> vec4<f32> {
	let uv = i.uv;
	let r2 = r * r;
	let kugel = 1.0 - smoothstep(1.0 - wR, 1.0 + wR, r);              // Deckung der Scheibe (1 px Saum)
	let nz = sqrt(max(1.0 - r2, 0.0));
	let n = vec3(uv, nz);
	let lam = dot(n, i.licht);
	let tag = smoothstep(-TERMINATOR, TERMINATOR, lam);
	let beleuchtung = mix(NACHT, max(lam, 0.0), tag) * pow(max(nz, 0.03), RAND);
	let scheibe = oberflaeche(i.art, n, uv) * beleuchtung;
	let k = (1.0 + i.licht.z) * 0.5;                                  // beleuchteter Anteil
	// Glow folgt der Phase (Sichel: schwach) und der Lichtseite (zur Sonne hin staerker)
	let seite = 0.4 + 0.6 * max(0.0, dot(uv / max(r, 1e-4), i.licht.xy));
	let glow = grundfarbe(i.art) * exp(-r2 * GLOW_FALL) * GLOW * mix(0.15, 1.0, k) * seite;
	var ringDeck = 0.0;
	var ringFarbe = vec3(0.0);
	if (i.art > 4.5) {
		// Ringebene: Punkt (x, y) im Bild liegt bei Radius rr = |(x, y / RING_ACHSE)|
		// in der Ebene; Tiefe z = -y * cos / sin (unten im Bild = vorne).
		let ring = smoothstep(RING_INNEN - wRR, RING_INNEN + wRR, rr) * (1.0 - smoothstep(RING_AUSSEN - wRR, RING_AUSSEN + wRR, rr));
		// Cassini-Luecke im Alpha (Ring wird dort durchsichtig, 0,8 -> 0,28), Tiefe
		// unskaliert; Breite mindestens 1,2 px (wRR = 0,75 fwidth), sonst punktet sie
		// bei 12-px-Scheiben. In der Farbe waere die Kerbe in der ACES-Schulter unsichtbar.
		let breite = max(RING_LUECKE_BREITE, wRR * 1.6);
		let dl = (rr - RING_LUECKE * RING_AUSSEN) / breite;
		let luecke = 1.0 - RING_LUECKE_TIEFE * exp(-dl * dl);
		let profil = 0.7 + 0.3 * smoothstep(RING_INNEN, RING_INNEN + 0.35, rr);
		let ringZ = -uv.y * RING_COS / RING_SIN;
		let vorne = select(0.0, 1.0, ringZ > nz);
		ringDeck = ring * RING_ALPHA * luecke * mix(1.0, vorne, kugel);   // hinter der Scheibe: verdeckt
		ringFarbe = RING * profil * mix(0.3, 1.0, k);
	}
	var rgb = ausgabe(glow * i.hell);
	var a = 0.0;
	rgb = ausgabe(scheibe * i.hell) * kugel + rgb * (1.0 - kugel); a = kugel + a * (1.0 - kugel);
	rgb = ausgabe(ringFarbe * i.hell) * ringDeck + rgb * (1.0 - ringDeck); a = ringDeck + a * (1.0 - ringDeck);
	return vec4(rgb, a);
}

// Sonne: Kern (deckend, weiss), Korona (weiss -> hellgelb -> blassorange, Alpha
// daempft Sterne dahinter), duenne ungleiche Strahlen (6 + 4, halbes Gewicht,
// um 30 Grad gedreht), Schleier in Weiss; alles x hell
fn sonne(i: KOut, r: f32, wR: f32) -> vec4<f32> {
	let px = r * i.radiusPx / H.dpr;                                  // CSS-Pixel vom Mittelpunkt
	let w = atan2(i.uv.y, i.uv.x);
	let kern = 1.0 - smoothstep(1.0 - wR, 1.0 + wR, r);
	let t = px / SONNE_KORONA_PX;
	let warm = mix(SONNE_INNEN, SONNE_AUSSEN, clamp(t * SONNE_FARBE_RAMPE, 0.0, 1.0));
	let koronaForm = exp(-t * t * 2.2);                                // faellt weiter bis zum Quadrand (kein Plateau)
	let korona = koronaForm * SONNE_KORONA_STAERKE;
	let s = px / SONNE_STRAHLEN_PX;
	let variation = 0.6 + 0.4 * (0.5 + 0.5 * sin(2.0 * w + 1.7));       // Strahlen ungleich lang/hell
	let satz1 = pow(abs(cos(3.0 * w + SONNE_STRAHLEN_DREHUNG)), SONNE_STRAHLEN_EXPONENT);
	let satz2 = 0.5 * pow(abs(cos(2.0 * w + 2.0 * SONNE_STRAHLEN_DREHUNG + 1.0472)), SONNE_STRAHLEN_EXPONENT);   // 2-zaehlig, 30 Grad gedreht
	let strahlen = SONNE_STRAHLEN_STAERKE * (satz1 + satz2) * variation * exp(-s * s * 2.2);
	let v = 1.0 - clamp(px / SONNE_SCHLEIER_PX, 0.0, 1.0);
	let schleier = SONNE_SCHLEIER_ALPHA * v * v;
	let farbe = (warm * korona + mix(warm, vec3(1.0), 0.5) * strahlen + SONNE_INNEN * schleier + vec3(SONNE_KERN_HELL) * kern) * i.hell;
	let a = min(1.0, kern + SONNE_KORONA_DECKUNG * koronaForm) * i.hell;
	return vec4(ausgabe(farbe), a);
}

@fragment fn fs(i: KOut) -> @location(0) vec4<f32> {
	let r = length(i.uv);
	let rr = length(vec2(i.uv.x, i.uv.y / RING_ACHSE));
	let wR = max(fwidth(r), 1e-4) * 0.75;
	let wRR = max(fwidth(rr), 1e-4) * 0.75;
	if (i.art < 0.5) { return sonne(i, r, wR); }
	return planet(i, r, wR, rr, wRR);
}
`;

	// Zeilenweise 3x3 (Array aus 9) auf einen Vektor: r' = M r
	function dreh(M, x, y, z) {
		return [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z];
	}

	function neu(gpu, format) {
		var device = gpu.device;
		format = format || gpu.format;

		var sternModul = window.GPU.shader(device, WGSL_STERNE, "himmel sterne");
		var sternPipeline = device.createRenderPipeline({
			label: "himmel sterne",
			layout: "auto",
			vertex: {
				module: sternModul, entryPoint: "vs",
				buffers: [{
					arrayStride: STRIDE, stepMode: "instance",
					attributes: [
						{ shaderLocation: 0, offset: 0,  format: "float32x3" },   // Richtung
						{ shaderLocation: 1, offset: 12, format: "float32" },     // Magnitude
						{ shaderLocation: 2, offset: 16, format: "unorm8x4" }     // Farbe
					]
				}]
			},
			fragment: {
				module: sternModul, entryPoint: "fs",
				targets: [{
					format: format,
					blend: {
						color: { srcFactor: "one", dstFactor: "one", operation: "add" },
						alpha: { srcFactor: "one", dstFactor: "one", operation: "add" }
					}
				}]
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			multisample: { count: 4 }
		});

		// Koerper: vormultipliziertes Alpha - Scheibe/Ring decken, Glow addiert (Alpha 0)
		var koerperModul = window.GPU.shader(device, WGSL_KOERPER, "himmel koerper");
		var koerperPipeline = device.createRenderPipeline({
			label: "himmel koerper",
			layout: "auto",
			vertex: {
				module: koerperModul, entryPoint: "vs",
				buffers: [{
					arrayStride: KOERPER_STRIDE, stepMode: "instance",
					attributes: [
						{ shaderLocation: 0, offset: 0,  format: "float32x3" },   // Richtung
						{ shaderLocation: 1, offset: 12, format: "float32" },     // radiusPx
						{ shaderLocation: 2, offset: 16, format: "float32" },     // quadPx
						{ shaderLocation: 3, offset: 20, format: "float32" },     // art
						{ shaderLocation: 4, offset: 24, format: "float32" },     // hell
						{ shaderLocation: 5, offset: 28, format: "float32x3" }    // lichtWelt
					]
				}]
			},
			fragment: {
				module: koerperModul, entryPoint: "fs",
				targets: [{
					format: format,
					blend: {
						color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
						alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
					}
				}]
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			multisample: { count: 4 }
		});

		// Ein Uniform-Puffer, je Pipeline eine Bindgruppe (auto-Layouts sind nicht uebertragbar)
		var uniformPuffer = window.GPU.uniform(device, U_BYTES);
		var uniformDaten = new Float32Array(U_BYTES / 4);
		var sternBind = device.createBindGroup({
			label: "himmel sterne",
			layout: sternPipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: uniformPuffer } }]
		});
		var koerperBind = device.createBindGroup({
			label: "himmel koerper",
			layout: koerperPipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: uniformPuffer } }]
		});

		// Sonne + 5 Planeten, je Bild neu geschrieben
		var koerperDaten = new Float32Array(KOERPER_MAX * KOERPER_STRIDE / 4);
		var koerperPuffer = device.createBuffer({
			label: "himmel koerper",
			size: koerperDaten.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
		});

		var sternPuffer = null, sternAnzahl = 0;

		var z = {
			sterne: 0,
			sonneSichtbar: false,
			planetenSichtbar: [],

			// katalog aus Sterne.lade (oder null = ohne Sterne); praezessionsMatrix
			// zeilenweise 3x3 J2000 -> Datum (Himmel.praezession), null = keine.
			setzeSterne: function (katalog, praezessionsMatrix) {
				if (sternPuffer) { sternPuffer.destroy(); sternPuffer = null; }
				sternAnzahl = 0; z.sterne = 0;
				if (!katalog || !(katalog.anzahl > 0)) return;
				var n = katalog.anzahl, M = praezessionsMatrix;
				var daten = new ArrayBuffer(n * STRIDE), f = new Float32Array(daten), b = new Uint8Array(daten);
				var R = katalog.richtungen, mag = katalog.magnituden, rgb = katalog.farben;
				for (var i = 0; i < n; i++) {
					var x = R[3 * i], y = R[3 * i + 1], w = R[3 * i + 2];
					var r = M ? dreh(M, x, y, w) : [x, y, w];
					var l = Math.hypot(r[0], r[1], r[2]) || 1;             // M ist Float32: nachnormieren
					f[5 * i] = r[0] / l; f[5 * i + 1] = r[1] / l; f[5 * i + 2] = r[2] / l;
					f[5 * i + 3] = mag[i];
					b[20 * i + 16] = rgb[3 * i]; b[20 * i + 17] = rgb[3 * i + 1]; b[20 * i + 18] = rgb[3 * i + 2];
					b[20 * i + 19] = 255;
				}
				sternPuffer = window.GPU.puffer(device, b, GPUBufferUsage.VERTEX);
				sternAnzahl = n; z.sterne = n;
			},

			// matrizenHimmel = kamera.matrizen(..).himmel ({viewRot, proj});
			// o = { koerper: [{ art (0 Sonne, 1..5 Merkur, Venus, Mars, Jupiter, Saturn),
			//       name, richtung [x,y,z], groessePx (Scheibendurchmesser, CSS-px; Sonne:
			//       Kern), hell (0..1, 0 = ausgeblendet; Sonne: Blende am Erdrand),
			//       licht [x,y,z] (Richtung Planet -> Sonne im Aequatorsystem, Himmel.phasenLicht(..).lichtWelt;
			//       fehlt: Vollphase) }] (bis 6 Eintraege),
			//       grenzMag, dpr, viewportPx: [b, h] (Geraetepixel) }
			zeichne: function (pass, matrizenHimmel, o) {
				uniformDaten.set(matrizenHimmel.viewRot, U_VIEWROT);
				uniformDaten.set(matrizenHimmel.proj, U_PROJ);
				uniformDaten[U_VIEWPORT] = Math.max(1, o.viewportPx[0]);
				uniformDaten[U_VIEWPORT + 1] = Math.max(1, o.viewportPx[1]);
				var dpr = o.dpr || 1;
				uniformDaten[U_DPR] = dpr;
				uniformDaten[U_GRENZMAG] = isFinite(o.grenzMag) ? o.grenzMag : 6.5;
				device.queue.writeBuffer(uniformPuffer, 0, uniformDaten);

				var liste = o.koerper || [], n = 0;
				z.sonneSichtbar = false;
				z.planetenSichtbar = [];
				for (var i = 0; i < liste.length && n < KOERPER_MAX; i++) {
					var k = liste[i];
					if (!k || !k.richtung) continue;
					var art = +k.art || 0;
					var hell = isFinite(k.hell) ? Math.max(0, Math.min(1, k.hell)) : 1;
					var groesse = isFinite(k.groessePx) && k.groessePx > 0 ? k.groessePx : (art === 0 ? SONNE_KERN_PX : PLANET_MIN_PX);
					var radiusPx = groesse / 2 * dpr;
					var quadPx = art === 0 ? SONNE_SCHLEIER_PX * dpr : radiusPx * PLANET_AUSDEHNUNG;
					var r = k.richtung, l = k.licht || [-r[0], -r[1], -r[2]];   // ohne licht: Sonne hinter dem Betrachter = Vollphase
					var j = n * 10;
					koerperDaten[j] = r[0]; koerperDaten[j + 1] = r[1]; koerperDaten[j + 2] = r[2];
					koerperDaten[j + 3] = radiusPx; koerperDaten[j + 4] = quadPx; koerperDaten[j + 5] = art; koerperDaten[j + 6] = hell;
					koerperDaten[j + 7] = l[0]; koerperDaten[j + 8] = l[1]; koerperDaten[j + 9] = l[2];
					if (hell > 0) {
						if (art === 0) z.sonneSichtbar = true;
						else if (k.name) z.planetenSichtbar.push(k.name);
					}
					n++;
				}
				if (n > 0) device.queue.writeBuffer(koerperPuffer, 0, koerperDaten, 0, n * 10);

				if (sternPuffer && sternAnzahl > 0) {
					pass.setPipeline(sternPipeline);
					pass.setBindGroup(0, sternBind);
					pass.setVertexBuffer(0, sternPuffer);
					pass.draw(6, sternAnzahl);
				}
				if (n > 0) {
					pass.setPipeline(koerperPipeline);
					pass.setBindGroup(0, koerperBind);
					pass.setVertexBuffer(0, koerperPuffer);
					pass.draw(6, n);
				}
			}
		};
		return z;
	}

	window.Himmelszeichner = {
		neu: neu, WGSL_AUSGABE: WGSL_AUSGABE,
		SONNE_KERN_PX: SONNE_KERN_PX, SONNE_BLENDE_PX: SONNE_BLENDE_PX, SONNE_SCHLEIER_PX: SONNE_SCHLEIER_PX,
		PLANET_MIN_PX: PLANET_MIN_PX, RING_AUSSEN: RING_AUSSEN
	};
})(window);
