/*
 * ISS Tracker - Welt-Ebene: Erde (Tag/Nacht, Wolkenschatten, Wasserglanz),
 * Wolken, Atmosphaere nach O'Neil (Rayleigh + Mie), Mond und Ersatzerde.
 *
 * Einheiten: Erdradien, Welt = ECI (+Z Nordpol). Die Erde ist die Einheitskugel,
 * um GMST gedreht (modell = rotZ(gmst)); Wolken liegen auf 1,004, die
 * Atmosphaerenhuelle auf 1,03. Der Mond steht bei W.mond.xyz mit Radius 0,2727;
 * seine Vorderseite (lon 0 der Karte) zeigt zur Erde, sein Nordpol nach +Z.
 *
 * Pipelines (alle depth32float, Vergleich greater, MSAA 4x, ein gemeinsames
 * Bindgruppen-Layout, Kugel GPU.kugel(256, 512), Mond GPU.kugel(64, 128)):
 *   erde        opak, Tiefe schreiben; Luftperspektive (4 Schritte) im Shader
 *   ersatz      opak, ohne Karten - vor der Vorschau und wenn die Tag-Karte fehlt
 *   mond        opak, Tiefe schreiben, Lambert + Erdschein
 *   atmoVorn    Vorderseite der Huelle (cull back), multiplikativ dst * T:
 *               Durchlass der Atmosphaere fuer alles dahinter (Sterne, Sonne),
 *               je Kanal - die Sonne hinter dem Rand wird rot. Ueber der
 *               Erdscheibe verworfen (dort rechnet der Erd-Shader).
 *   atmoHinten  Rueckseite der Huelle (cull front), additiv: Einstreuung entlang
 *               des Strahls Eintritt -> Austritt (8 Schritte). Hinter der Erde
 *               weist die Tiefe sie ab, es bleibt der Rand.
 *   wolken      Alpha-Blend, Tiefe nur lesen, Drift 0,4 Grad je Stunde; zuletzt
 *               (Task 12b), damit die additive Huelle im Wolkenring nicht auf die
 *               Wolkenfarbe kommt.
 *
 * Uniform "Welt" (256 Byte): viewProj 0, modell 64, kamera 128, sonne 144,
 * parameter 160 (wolkenVersatzU, wolkenAn, nachtlichterAn, atmosphaereAn),
 * mond 176 (xyz Position in R, w Radius), mondRot 192 (Drehung des Mondes).
 *
 * Kamerarelativ (Task 12b): viewProj ist die Projektion mit der Kamera im
 * Ursprung (kamera.matrizen().welt.viewProjRel); die Vertex-Shader ziehen
 * W.kamera.xyz von der Weltposition ab, bevor sie projizieren. Beleuchtung und
 * Atmosphaere rechnen weiter mit absoluten Positionen (pWelt, W.kamera). Der
 * float32-Fehler der Subtraktion (~1 m) ist bei >= 400 km Abstand zur
 * Oberflaeche unsichtbar; die Welt-Nahebene liegt jetzt bei 1e-5 R.
 *
 * Bindgruppe: 0 Uniform, 1 Sampler, 2 Tag, 3 Nacht, 4 Wolken, 5 Maske, 6 Mond,
 * 7 Kacheln (texture_2d_array), 8 Uniform "Kacheln", 9 Sampler der Kacheln.
 * Fehlende Karten (null) ersetzt eine 1x1-Textur, damit die Bindgruppe immer
 * vollstaendig ist; setzeTexturen baut sie neu und leitet modus ab:
 * ohne Tag -> 'ersatz', Tag >= 2048 px -> 'voll', sonst 'vorschau'.
 *
 * Detailkacheln (Task 15b, kacheln.js): Uniform "Kacheln" (80 Byte) = 4 Slots
 * x vec4(u0, v0, skala, aktiv) ab Byte 0 (Slot i bei 16 i) + vec4(blendNahKm,
 * blendFernKm, slots, 0) bei Byte 64; zeichne() schreibt sie aus o.kacheln
 * (Float32Array(20) von Kacheln.tabelle()). Der Erd-Shader sucht je Fragment
 * den Slot der Kachel unter uv, liest sie mit textureSampleGrad (Ableitungen
 * aus der globalen uv) und mischt sie in die Tagkarte nach dem Abstand Kamera
 * -> Boden (voll < blendNah, aus > blendFern). Nacht, Wolken, Maske, Schatten
 * und Glanz bleiben Basis. Die Kacheln haben einen eigenen Sampler, der in u
 * und v klemmt: der Kachelrand (2 px) deckt den bilinearen Filter, nicht aber
 * den anisotropen Fussabdruck - mit 'repeat' laese der am Rand die Gegenseite.
 *
 * Kalibrierung (Task 12a): Einstreuung im Boden-/Wolkenpfad mit Faktor
 * BODEN_EINSTREUUNG, Huelle mit ESUN_HUELLE; Glanz Kern/Hof, Maske im Glanz
 * aus groeberer Mip-Stufe; Wolkendrift ostwaerts; Vorderseite der Huelle ueber
 * der Wolkenkugel verworfen, wenn Wolken an sind.
 *
 * Nichts hier fasst auf oberster Ebene navigator, document oder GPU* an.
 */
(function (window) {
	"use strict";

	// Float-Indizes in der Uniform (Byte / 4)
	var U_VIEWPROJ = 0, U_MODELL = 16, U_KAMERA = 32, U_SONNE = 36, U_PARAMETER = 40, U_MOND = 44, U_MONDROT = 48;
	var U_BYTES = 256;
	var MOND_RADIUS = 0.2727;
	var WOLKEN_SKALA = 1.004, AUSSEN_RADIUS = 1.03;
	var WOLKEN_DRIFT_GRAD_JE_H = 0.4;
	// Task 19 (Look a, Stellschraube): Wolkendeckung nach dem Abstand Kamera ->
	// Wolkenpunkt. Aus der Folgen-Kamera stand der scharfe 500-m-Boden der
	// Detailkacheln unter matschigen 2048er-Wolken (20 km/px) mit Deckung 0,95;
	// nah (unter WOLKEN_NAH_KM) jetzt WOLKEN_DECKUNG_NAH, ab WOLKEN_FERN_KM wie
	// bisher WOLKEN_DECKUNG_FERN, dazwischen smoothstep. Die Uebersicht (Erde aus
	// 3,2 R, Oberflaeche >= 7000 km entfernt) bleibt unveraendert.
	var WOLKEN_DECKUNG_NAH = 0.75, WOLKEN_DECKUNG_FERN = 0.95, WOLKEN_NAH_KM = 1000, WOLKEN_FERN_KM = 3000;
	var VOLL_AB_PX = 2048;                          // Tag-Karte ab dieser Breite = volle Aufloesung
	// Detailkacheln (Task 15b): Konstanten aus kacheln.js (vor erde.js geladen);
	// Rueckfall auf dieselben Werte, wenn Kacheln fehlt (Tests, alte Seite).
	// Uniform 4 Slots x vec4 + vec4 = 80 Byte; Kachel 2704 px mit 2 px Rand,
	// 8 Spalten x 4 Zeilen.
	var KA = window.Kacheln || {};
	var K_SLOTS = KA.SLOTS_MAX || 4, K_BYTES = (KA.TABELLE_FLOATS || K_SLOTS * 4 + 4) * 4;
	var K_KACHEL_PX = KA.KACHEL_PX || 2704, K_RAND_PX = KA.RAND_PX || 2, K_SPALTEN = KA.SPALTEN || 8, K_ZEILEN = KA.ZEILEN || 4;
	var R_KM = 6378.137;                            // Erdradius: Abstand Kamera -> Boden in km

	// O'Neil-Konstanten (Brief): Kr 0.0025, Km 0.0010, ESun 15, Wellenlaengen 0.650/0.570/0.475
	var KR = 0.0025, KM = 0.0010, ESUN = 15.0;
	// Task 12a (A1), Kalibrierung am 12:00-UTC-Bild (tmp/iss-tracker/t12a-*-12utc.png):
	// Die Einstreuung mit ESun 15 ueberdeckte den Ozean im Nadir (gerendert
	// 91-125/122-153/168-191 sRGB statt ~40/70/130) und machte die Sahara
	// grau-rosa. Boden- und Wolkenpfad (luftperspektive) bekommen deshalb einen
	// eigenen Faktor; die Huelle (Randsaum, atmoHinten) ein eigenes ESun, weil
	// der Saum bei 15 zwei Pixel weiss clippte und ~8 px (3 % R) hell stand.
	var BODEN_EINSTREUUNG = 0.35;                   // Faktor auf die Einstreuung im Oberflaechen-/Wolkenpfad (ESun ~5)
	var ESUN_HUELLE = 10.0;                         // ESun der Huelle (Randsaum ausserhalb der Scheibe)
	// Sonnenglanz auf Wasser: pow(180)*0,6 war ein ~80-px-Nebelfleck bei 720p.
	// Harter Kern (~40 px) plus schwacher, weiter Hof. Kern 0,5 statt 0,35 aus
	// der Liste: mit 0,35 blieb der Fleck bei sRGB 191 matt (Sonne auf Wasser
	// darf fast clippen); Hof 0,04 misst sich als ~50 px bei halber Hoehe.
	var GLANZ_KERN_POT = 800.0, GLANZ_KERN = 0.5;
	var GLANZ_HOF_POT = 40.0, GLANZ_HOF = 0.04;
	// Wassermaske im Glanzterm aus einer groeberen Mip-Stufe lesen: die binaere
	// Maske schnitt den Glanz an Kuesten hart ab (Bias 2 = 4 Texel weich).
	var GLANZ_MASKE_BIAS = 2.0;
	// Task 12b (A5): Limb-Innenkante. Huellenpfad (HUELLE_EINSTREUUNG) und Bodenpfad
	// (BODEN_EINSTREUUNG) trafen sich am Scheibenrand mit einem Sprung 222 -> 138
	// sRGB in einem Pixel. Der Bodenpfad blendet bei streifender Sicht gegen den
	// Huellenwert: mix(BODEN, HUELLE, pow(1 - n.v, LIMB_ANGLEICH_K)); mit k = 4
	// wirkt das nur in den letzten ~20 Grad (10 px innerhalb des Rands bei 720p/3,2 R).
	var LIMB_ANGLEICH_K = 4.0;
	// Blendziel am Rand = HUELLE_EINSTREUUNG * LIMB_HUELLE_FAKTOR: der Bodenpfad am
	// Scheibenrand integriert nur den halben Tangentenweg (bis zur Oberflaeche),
	// die Huelle daneben den ganzen - bei gleichem Faktor blieb ein Sprung von
	// ~40 sRGB (222 -> 180). 1,5 hebt den Randpixel auf ~205; das Profil faellt
	// dann in Schritten <= 20 nach innen.
	var LIMB_HUELLE_FAKTOR = 1.5;
	function wl4(w) { return (1 / Math.pow(w, 4)).toFixed(5); }
	var INV_WL4 = wl4(0.650) + ", " + wl4(0.570) + ", " + wl4(0.475);
	var KR4PI = (KR * 4 * Math.PI).toFixed(7), KM4PI = (KM * 4 * Math.PI).toFixed(7);
	var KR_ESUN = (KR * ESUN).toFixed(5), KM_ESUN = (KM * ESUN).toFixed(5);

	// ACES + sRGB + linear() (Task 12c): einzige Quelle ist Himmelszeichner.WGSL_AUSGABE
	// (himmel.js, in index.html vor erde.js geladen). Erst in neu() gelesen und
	// vorangestellt, damit erde.js auch ohne himmel.js ladbar bleibt (Node-Tests).
	function wgslAusgabe() {
		var H = window.Himmelszeichner;
		if (!H || typeof H.WGSL_AUSGABE !== "string") throw new Error("himmel.js missing (Himmelszeichner.WGSL_AUSGABE)");
		return H.WGSL_AUSGABE;
	}

	var WGSL = `
struct Welt {
	viewProj: mat4x4<f32>, modell: mat4x4<f32>,
	kamera: vec4<f32>, sonne: vec4<f32>, parameter: vec4<f32>, mond: vec4<f32>,
	mondRot: mat4x4<f32>
};
@group(0) @binding(0) var<uniform> W: Welt;
@group(0) @binding(1) var sTex: sampler;
@group(0) @binding(2) var tTag: texture_2d<f32>;
@group(0) @binding(3) var tNacht: texture_2d<f32>;
@group(0) @binding(4) var tWolken: texture_2d<f32>;
@group(0) @binding(5) var tMaske: texture_2d<f32>;
@group(0) @binding(6) var tMond: texture_2d<f32>;
// Detailkacheln (Task 15b): je Slot (u0, v0, skala, aktiv); blend = (nahKm, fernKm, slots, 0)
struct Kacheln { slot: array<vec4<f32>, ${K_SLOTS}>, blend: vec4<f32> };
@group(0) @binding(7) var tKacheln: texture_2d_array<f32>;
@group(0) @binding(8) var<uniform> K: Kacheln;
@group(0) @binding(9) var sKacheln: sampler;
const KACHEL_RAND = ${K_RAND_PX}.0 / ${K_KACHEL_PX}.0;
const KACHEL_RASTER = vec2<f32>(${K_SPALTEN}.0, ${K_ZEILEN}.0);
const R_KM = ${R_KM};

// Tagfarbe mit Detailkachel: Slot der Kachel unter uv suchen, bei Treffer die
// Kachel lesen und nach dem Abstand Kamera -> Boden in die Basis mischen
// (voll unter blendNah, aus ueber blendFern). Ableitungen ddx/ddy stammen aus
// der globalen uv (im uniformen Teil von fsErde gebildet, in Kacheleinheiten):
// textureSampleGrad darf im nicht-uniformen Zweig stehen, und die impliziten
// Ableitungen der lokalen uv wuerden an jeder Kachelgrenze springen (1-px-Naht).
fn kachelFarbe(basis: vec3<f32>, uv: vec2<f32>, abstandKm: f32, ddx: vec2<f32>, ddy: vec2<f32>) -> vec3<f32> {
	if (K.blend.z < 0.5) { return basis; }                             // keine Kacheln gebunden
	let blend = 1.0 - smoothstep(K.blend.x, K.blend.y, abstandKm);
	if (blend <= 0.0) { return basis; }
	let raster = min(floor(uv * KACHEL_RASTER), KACHEL_RASTER - 1.0);   // u = 1 liegt noch in Spalte 7
	let ursprung = raster / KACHEL_RASTER;
	var slot = -1;
	let n = i32(K.blend.z);
	for (var j = 0; j < n; j++) {
		let e = K.slot[j];
		if (e.w > 0.5 && all(abs(e.xy - ursprung) < vec2(0.001))) { slot = j; }
	}
	if (slot < 0) { return basis; }
	let e = K.slot[slot];
	let lokal = vec2(KACHEL_RAND) + (uv - e.xy) * KACHEL_RASTER * e.z;
	let kachel = linear(textureSampleGrad(tKacheln, sKacheln, lokal, slot, ddx * e.z, ddy * e.z).rgb);
	return mix(basis, kachel, blend);
}

// ---------------------------------------------------------- Atmosphaere (O'Neil, GPU Gems 2 Kap. 16)
const INNEN = 1.0;
const AUSSEN = ${AUSSEN_RADIUS};
const SKALEN_TIEFE = 0.25;
const SKALA = 1.0 / (AUSSEN - INNEN);              // Laengen in Huellendicken
const SKALA_TIEFE = SKALA / SKALEN_TIEFE;
const INV_WL4 = vec3<f32>(${INV_WL4});             // 1 / Wellenlaenge^4
const BETA = INV_WL4 * ${KR4PI} + vec3<f32>(${KM4PI});   // Kr 4pi, Km 4pi: Ausloeschung je Saeulendichte
const KR_ESUN = ${KR_ESUN};
const KM_ESUN = ${KM_ESUN};
const G = -0.95;
const G2 = G * G;
const BODEN_EINSTREUUNG = ${BODEN_EINSTREUUNG.toFixed(3)};        // Task 12a: Einstreuung im Boden-/Wolkenpfad
const HUELLE_EINSTREUUNG = ${(ESUN_HUELLE / ESUN).toFixed(4)};    // Task 12a: ESun der Huelle / ESun
const GLANZ_KERN_POT = ${GLANZ_KERN_POT.toFixed(1)};
const GLANZ_KERN = ${GLANZ_KERN.toFixed(3)};
const GLANZ_HOF_POT = ${GLANZ_HOF_POT.toFixed(1)};
const GLANZ_HOF = ${GLANZ_HOF.toFixed(3)};
const GLANZ_MASKE_BIAS = ${GLANZ_MASKE_BIAS.toFixed(1)};
const LIMB_ANGLEICH_K = ${LIMB_ANGLEICH_K.toFixed(1)};
const LIMB_HUELLE_FAKTOR = ${LIMB_HUELLE_FAKTOR.toFixed(2)};
const WOLKEN_R = ${WOLKEN_SKALA};
const WOLKEN_DECKUNG_NAH = ${WOLKEN_DECKUNG_NAH.toFixed(3)};       // Task 19: Deckung nah / fern nach Abstand
const WOLKEN_DECKUNG_FERN = ${WOLKEN_DECKUNG_FERN.toFixed(3)};
const WOLKEN_NAH_KM = ${WOLKEN_NAH_KM.toFixed(1)};
const WOLKEN_FERN_KM = ${WOLKEN_FERN_KM.toFixed(1)};

// Dichte in der Hoehe h (1 am Boden, exp(-4) an der Huelle)
fn dichte(h: f32) -> f32 { return exp(SKALA_TIEFE * (INNEN - h)); }
// Saeulendichte von einem Punkt bis in den Raum, je Dichte dort, fuer den Winkel
// (cos) zwischen Lot und Strahl; O'Neils Polynom in x = 1 - cos (gueltig fuer
// cos >= 0; fuer Sonnenstrahlen unter dem Horizont waechst es schnell, was die
// Abschattung durch die Erde nachbildet). Gedeckelt gegen Ueberlauf.
fn skala(cosW: f32) -> f32 {
	let x = 1.0 - cosW;
	return SKALEN_TIEFE * exp(min(-0.00287 + x * (0.459 + x * (3.83 + x * (-6.80 + x * 5.25))), 50.0));
}
fn phaseRayleigh(c: f32) -> f32 { return 0.75 * (1.0 + c * c); }
fn phaseMie(c: f32) -> f32 {
	return 1.5 * ((1.0 - G2) / (2.0 + G2)) * (1.0 + c * c) / pow(1.0 + G2 - 2.0 * G * c, 1.5);
}
// Strahl kam + t d gegen die Kugel mit Radius r um den Ursprung: (tNah, tFern);
// ohne Schnitt ist x > y.
fn kugelSchnitt(kam: vec3<f32>, d: vec3<f32>, r: f32) -> vec2<f32> {
	let b = dot(kam, d);
	let c = dot(kam, kam) - r * r;
	let det = b * b - c;
	if (det < 0.0) { return vec2(1.0, -1.0); }
	let s = sqrt(det);
	return vec2(-b - s, -b + s);
}

// Saeulen des Sichtwegs (Task 12c: vorher in integriere und fsAtmoVorn doppelt):
// x = Saeule vom Eintritt in die Huelle (tNah) in den Raum, gegen den Strahl
// gemessen; y = Saeule vom Scheitel (tiefster Punkt des Strahls, mindestens
// 0,9 R) waagerecht in den Raum.
fn saeulen(kam: vec3<f32>, d: vec3<f32>, tNah: f32) -> vec2<f32> {
	let start = kam + d * tNah;
	let hStart = length(start);
	let tT = -dot(kam, d);
	let hT = max(sqrt(max(dot(kam, kam) - tT * tT, 0.0)), 0.9);
	return vec2(dichte(hStart) * skala(-dot(d, start) / hStart), dichte(hT) * skala(0.0));
}

struct Integral { summe: vec3<f32>, saeuleStart: f32 };
// Einstreuung entlang des Strahls von tNah (Eintritt in die Huelle) bis tEnde,
// n Schritte. Optische Tiefe je Schritt: Sonnenweg vom Punkt in den Raum plus
// Sichtweg vom Eintritt bis zum Punkt. Der Sichtweg wird ueber Saeulen in den
// Raum gebildet, immer in der Richtung, in der der Strahl nach oben zeigt:
// absteigend vom Punkt zurueck zum Eintritt, aufsteigend vom Scheitel (tiefster
// Punkt T) weiter zum Austritt. So bleibt das Polynom in seinem Bereich cos >= 0.
fn integriere(kam: vec3<f32>, d: vec3<f32>, tNah: f32, tEnde: f32, l: vec3<f32>, n: i32) -> Integral {
	let s0 = saeulen(kam, d, tNah);
	let saeuleStart = s0.x;
	let saeuleScheitel = s0.y;
	let schritt = (tEnde - tNah) / f32(n);
	let laenge = schritt * SKALA;
	var t = tNah + schritt * 0.5;
	var summe = vec3<f32>(0.0);
	for (var i = 0; i < n; i++) {
		let p = kam + d * t;
		let h = length(p);
		let rho = dichte(h);
		let kamWinkel = dot(d, p) / h;
		var sicht = 0.0;
		if (kamWinkel < 0.0) { sicht = rho * skala(-kamWinkel) - saeuleStart; }
		else { sicht = 2.0 * saeuleScheitel - saeuleStart - rho * skala(kamWinkel); }
		let sonne = rho * skala(dot(l, p) / h);
		summe += exp(-(max(sicht, 0.0) + sonne) * BETA) * (rho * laenge);
		t += schritt;
	}
	return Integral(summe, saeuleStart);
}
// c = cos zwischen Sonnenrichtung und Richtung zur Kamera
fn einstreuung(summe: vec3<f32>, c: f32) -> vec3<f32> {
	return summe * (INV_WL4 * KR_ESUN * phaseRayleigh(c) + KM_ESUN * phaseMie(c));
}
// Luftperspektive fuer einen Oberflaechenpunkt p (Boden, Wolken): sonnig wird
// auf dem Hinweg (Sonne -> p) und Rueckweg (p -> Kamera) geschwaecht, nacht
// (Eigenleuchten) nur auf dem Rueckweg; dazu die Einstreuung mit 4 Schritten,
// deren Faktor bei streifender Sicht vom Boden- zum Huellenwert uebergeht
// (Limb-Innenkante, Task 12b).
fn luftperspektive(sonnig: vec3<f32>, nacht: vec3<f32>, p: vec3<f32>, kam: vec3<f32>, l: vec3<f32>) -> vec3<f32> {
	let dv = p - kam;
	let tEnde = length(dv);
	let d = dv / tEnde;
	let tNah = max(kugelSchnitt(kam, d, AUSSEN).x, 0.0);
	let s = integriere(kam, d, tNah, tEnde, l, 4);
	let h = length(p);
	let n = p / h;
	let rho = dichte(h);
	let ndv = max(dot(-d, n), 0.0);
	let sichtT = exp(-max(rho * skala(ndv) - s.saeuleStart, 0.0) * BETA);
	let sonneT = exp(-rho * skala(dot(l, n)) * BETA);
	let anteil = mix(BODEN_EINSTREUUNG, HUELLE_EINSTREUUNG * LIMB_HUELLE_FAKTOR, pow(1.0 - ndv, LIMB_ANGLEICH_K));
	return (sonnig * sonneT + nacht) * sichtT + einstreuung(s.summe, dot(l, -d)) * anteil;
}

// ---------------------------------------------------------- Vertex
// Centroid-Interpolation (Task 12b): am Silhouettenpixel der Erde liegt die
// Pixelmitte ausserhalb der Kugel; mit der Vorgabe (center) wurde pWelt dorthin
// extrapoliert und der Bodenpfad rechnete eine ganze Tangentensehne - die
// weisse 1-px-Randlinie (255) am Limb. Centroid haelt den Schattierungspunkt
// in der gedeckten Flaeche.
struct VOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) @interpolate(perspective, centroid) uv: vec2<f32>,
	@location(1) @interpolate(perspective, centroid) nWelt: vec3<f32>,
	@location(2) @interpolate(perspective, centroid) pWelt: vec3<f32>,
	@location(3) @interpolate(perspective, centroid) tangU: vec3<f32>
};
// Kugel um den Ursprung, Radius 'skalierung', mit der Modellmatrix (rotZ gmst) gedreht.
// tangU = Richtung wachsender Laenge (u) in der Tangentialebene.
// Clip-Position kamerarelativ (Task 12b): W.viewProj hat die Kamera im Ursprung.
fn kugelVertex(p: vec3<f32>, uv: vec2<f32>, skalierung: f32) -> VOut {
	var o: VOut;
	let pw = (W.modell * vec4(p * skalierung, 1.0)).xyz;
	o.pos = W.viewProj * vec4(pw - W.kamera.xyz, 1.0);
	o.uv = uv;
	o.nWelt = (W.modell * vec4(p, 0.0)).xyz;
	o.pWelt = pw;
	let lon = uv.x * 6.283185307 - 3.141592654;
	o.tangU = (W.modell * vec4(-sin(lon), cos(lon), 0.0, 0.0)).xyz;
	return o;
}
@vertex fn vsErde(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut { return kugelVertex(p, uv, 1.0); }
@vertex fn vsWolken(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut { return kugelVertex(p, uv, ${WOLKEN_SKALA}); }
@vertex fn vsAtmo(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut { return kugelVertex(p, uv, AUSSEN); }
// Vorderseite der Huelle: pWelt je MSAA-Sample interpoliert und der Fragment-
// Shader je Sample ausgefuehrt (sample_index). Sonst entscheidet der Strahl der
// Pixelmitte ueber "Boden oder Rand", waehrend die Deckung je Sample gilt - an
// der Silhouette wuerden vom Erd-Pass gefuellte Samples mit dem Durchlass des
// Tangentialwegs multipliziert (braune Perlen im Netzraster).
struct VOutS { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(perspective, sample) pWelt: vec3<f32> };
@vertex fn vsAtmoVorn(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOutS {
	var o: VOutS;
	let pw = p * AUSSEN;                              // Kugel: keine Drehung noetig
	o.pos = W.viewProj * vec4(pw - W.kamera.xyz, 1.0);
	o.pWelt = pw;
	return o;
}
@vertex fn vsMond(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut {
	var o: VOut;
	let n = (W.mondRot * vec4(p, 0.0)).xyz;
	let pw = W.mond.xyz + n * W.mond.w;
	o.pos = W.viewProj * vec4(pw - W.kamera.xyz, 1.0);
	o.uv = uv; o.nWelt = n; o.pWelt = pw; o.tangU = vec3(0.0);
	return o;
}

// ---------------------------------------------------------- Fragment
@fragment fn fsErde(i: VOut) -> @location(0) vec4<f32> {
	let n = normalize(i.nWelt);                       // Normale in ECI (Modellmatrix angewandt)
	let l = normalize(W.sonne.xyz);
	let kam = W.kamera.xyz;
	let zurKamera = kam - i.pWelt;
	let v = normalize(zurKamera);
	let ndl = dot(n, l);
	let tag = smoothstep(-0.05, 0.05, ndl);           // Terminator ~6 Grad breit
	// Ableitungen der globalen uv in Kacheleinheiten - hier, im uniformen Fluss (Task 15b)
	let ddx = dpdx(i.uv) * KACHEL_RASTER;
	let ddy = dpdy(i.uv) * KACHEL_RASTER;
	let abstandKm = length(zurKamera) * R_KM;
	let tagTex = kachelFarbe(linear(textureSample(tTag, sTex, i.uv).rgb), i.uv, abstandKm, ddx, ddy);
	// Black Marble: Lichter warm und hell, Land und Eis als blauer Schleier
	// (~0,02 linear). Nur die warmen Pixel (r > b) gelten als Lichter, der
	// Schleier bleibt schwach als Mondlicht - sonst leuchtet die Nachtseite violett.
	let nachtRoh = linear(textureSample(tNacht, sTex, i.uv).rgb);
	let lichter = nachtRoh * vec3(1.0, 0.93, 0.8) * smoothstep(0.0, 0.1, nachtRoh.r - nachtRoh.b);
	let nachtTex = (lichter * 1.6 + nachtRoh * 0.2) * W.parameter.z;
	// Wassermaske fuer den Glanz aus einer groeberen Mip-Stufe (weiche Kuesten)
	let wasser = textureSampleBias(tMaske, sTex, i.uv, GLANZ_MASKE_BIAS).r;
	// Wolkenschatten: Wolkenbild entlang der Lichtrichtung in Tangentenrichtung
	// versetzt (Schatten liegt von der Sonne weg, also die Wolke sonnenwaerts lesen).
	let lt = l - n * ndl;                              // Lichtrichtung in der Tangentialebene
	let tangU = normalize(i.tangU);
	let tangV = cross(tangU, n);                       // Richtung wachsender v (Sueden)
	let du = vec2(dot(lt, tangU), dot(lt, tangV)) * 0.004;
	let wolkenUv = vec2(i.uv.x + W.parameter.x, i.uv.y);
	let schatten = 1.0 - 0.55 * textureSample(tWolken, sTex, wolkenUv + du).r * W.parameter.y;
	let diffus = tagTex * max(ndl, 0.0) * 1.35 * schatten;
	let h = normalize(l + v);
	let ndh = max(dot(n, h), 0.0);
	// Sonnenglanz: harter Kern plus weiter Hof (Task 12a)
	let spek = (pow(ndh, GLANZ_KERN_POT) * GLANZ_KERN + pow(ndh, GLANZ_HOF_POT) * GLANZ_HOF) * wasser * tag;
	let sonnig = diffus + vec3(spek);
	let nacht = nachtTex * (1.0 - tag);
	var farbe = sonnig + nacht;
	if (W.parameter.w > 0.5) { farbe = luftperspektive(sonnig, nacht, i.pWelt, kam, l); }
	return vec4(ausgabe(farbe), 1.0);
}
@fragment fn fsErsatz(i: VOut) -> @location(0) vec4<f32> {
	let n = normalize(i.nWelt);
	let l = normalize(W.sonne.xyz);
	let ndl = dot(n, l);
	let tag = smoothstep(-0.05, 0.05, ndl);
	var farbe = mix(vec3(0.02, 0.05, 0.12), vec3(0.15, 0.35, 0.7), tag) * max(ndl, 0.15);
	if (W.parameter.w > 0.5) { farbe = luftperspektive(vec3(0.0), farbe, i.pWelt, W.kamera.xyz, l); }
	return vec4(ausgabe(farbe), 1.0);
}
@fragment fn fsWolken(i: VOut) -> @location(0) vec4<f32> {
	let uv = vec2(i.uv.x + W.parameter.x, i.uv.y);
	let deckung = textureSample(tWolken, sTex, uv).r;
	let n = normalize(i.nWelt);
	let l = normalize(W.sonne.xyz);
	let ndl = dot(n, l);
	let licht = clamp((ndl + 0.1) / 1.1, 0.0, 1.0);   // Wolken leuchten etwas ueber den Terminator hinaus
	var farbe = vec3(0.02 + 0.98 * licht);
	if (W.parameter.w > 0.5) { farbe = luftperspektive(vec3(0.98 * licht), vec3(0.02), i.pWelt, W.kamera.xyz, l); }
	// Task 19 (Look a): Deckung nach Abstand Kamera -> Wolkenpunkt (nah duenner)
	let abstandKm = length(W.kamera.xyz - i.pWelt) * R_KM;
	let staerke = mix(WOLKEN_DECKUNG_NAH, WOLKEN_DECKUNG_FERN, smoothstep(WOLKEN_NAH_KM, WOLKEN_FERN_KM, abstandKm));
	return vec4(ausgabe(farbe), deckung * staerke);
}
@fragment fn fsMond(i: VOut) -> @location(0) vec4<f32> {
	let n = normalize(i.nWelt);
	let l = normalize(W.sonne.xyz);
	let tex = linear(textureSample(tMond, sTex, i.uv).rgb);
	let farbe = max(dot(n, l), 0.0) * tex * 1.2 + 0.02 * tex;   // Lambert + Erdschein
	return vec4(ausgabe(farbe), 1.0);
}
// Huelle, Vorderseite: Durchlass T der ganzen Strecke Eintritt -> Austritt
// (Saeule symmetrisch: 2 (Scheitel - Eintritt)), multiplikativ auf das Bild dahinter.
@fragment fn fsAtmoVorn(i: VOutS, @builtin(sample_index) sample: u32) -> @location(0) vec4<f32> {
	let kam = W.kamera.xyz;
	let d = normalize(i.pWelt - kam);
	// Ueber der Erdscheibe verworfen: dort rechnet der Erd-Shader die Luft-
	// perspektive. Die Wolken werden nach der Huelle gezeichnet (Task 12b), der
	// Wolkenring 1,0-1,004 R wird also nicht mehr doppelt geschwaecht - der Test
	// gilt wieder der Erdkugel (12a hatte hier WOLKEN_R).
	let erde = kugelSchnitt(kam, d, INNEN);
	if (erde.x <= erde.y && erde.x > 0.0) { discard; }
	let huelle = kugelSchnitt(kam, d, AUSSEN);
	if (huelle.x > huelle.y) { discard; }
	let s0 = saeulen(kam, d, max(huelle.x, 0.0));
	let durchlass = exp(-max(2.0 * (s0.y - s0.x), 0.0) * BETA);
	return vec4(srgb(durchlass), 1.0);                   // Bild dahinter ist sRGB-kodiert
}
// Huelle, Rueckseite: Einstreuung Eintritt -> Austritt (oder bis zum Boden), additiv.
@fragment fn fsAtmoHinten(i: VOut) -> @location(0) vec4<f32> {
	let kam = W.kamera.xyz;
	let d = normalize(i.pWelt - kam);
	let l = normalize(W.sonne.xyz);
	let huelle = kugelSchnitt(kam, d, AUSSEN);
	if (huelle.x > huelle.y) { discard; }
	let tNah = max(huelle.x, 0.0);
	var tEnde = huelle.y;
	let erde = kugelSchnitt(kam, d, INNEN);
	if (erde.x <= erde.y && erde.x > 0.0) { tEnde = erde.x; }
	let s = integriere(kam, d, tNah, tEnde, l, 8);
	return vec4(ausgabe(einstreuung(s.summe, dot(l, -d)) * HUELLE_EINSTREUUNG), 1.0);
}
`;

	var VERTEX_BUFFERS = [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },   // Position (= Normale)
		{ arrayStride: 8,  attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] }    // UV
	];

	function neu(gpu, format) {
		var device = gpu.device;
		var G = window.GPU;
		format = format || gpu.format;

		var modul = G.shader(device, wgslAusgabe() + WGSL, "erde");
		var bindLayout = device.createBindGroupLayout({
			label: "welt",
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
				{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
				{ binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
				{ binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
				{ binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
				{ binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
				{ binding: 9, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
			]
		});
		var pipelineLayout = device.createPipelineLayout({ label: "welt", bindGroupLayouts: [bindLayout] });

		function pipeline(label, vs, fs, o) {
			return device.createRenderPipeline({
				label: label,
				layout: pipelineLayout,
				vertex: { module: modul, entryPoint: vs, buffers: VERTEX_BUFFERS },
				fragment: { module: modul, entryPoint: fs, targets: [{ format: format, blend: o.blend }] },
				primitive: { topology: "triangle-list", cullMode: o.cull || "back", frontFace: "ccw" },
				depthStencil: { format: "depth32float", depthWriteEnabled: !!o.tiefeSchreiben, depthCompare: "greater" },
				multisample: { count: 4 }
			});
		}
		var BLEND_ALPHA = {
			color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
			alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
		};
		var BLEND_ADDITIV = {
			color: { srcFactor: "one", dstFactor: "one", operation: "add" },
			alpha: { srcFactor: "one", dstFactor: "one", operation: "add" }
		};
		var BLEND_MULTIPLIKATIV = {                       // dst * src: Durchlass je Kanal
			color: { srcFactor: "zero", dstFactor: "src", operation: "add" },
			alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" }
		};
		var pErde = pipeline("erde", "vsErde", "fsErde", { tiefeSchreiben: true });
		var pErsatz = pipeline("erde ersatz", "vsErde", "fsErsatz", { tiefeSchreiben: true });
		var pMond = pipeline("mond", "vsMond", "fsMond", { tiefeSchreiben: true });
		var pWolken = pipeline("wolken", "vsWolken", "fsWolken", { blend: BLEND_ALPHA });
		var pAtmoVorn = pipeline("atmosphaere vorn", "vsAtmoVorn", "fsAtmoVorn", { blend: BLEND_MULTIPLIKATIV, cull: "back" });
		var pAtmoHinten = pipeline("atmosphaere hinten", "vsAtmo", "fsAtmoHinten", { blend: BLEND_ADDITIV, cull: "front" });

		// Netze: Erde/Wolken/Huelle teilen sich die Kugel (Skalierung im Shader),
		// die Normale ist bei der Einheitskugel die Position - kein eigener Puffer.
		function netz(segLat, segLon, label) {
			var k = G.kugel(segLat, segLon);
			return {
				pos: G.puffer(device, k.positionen, GPUBufferUsage.VERTEX),
				uv: G.puffer(device, k.uv, GPUBufferUsage.VERTEX),
				idx: G.puffer(device, k.indizes, GPUBufferUsage.INDEX),
				n: k.indizes.length,
				label: label
			};
		}
		// Die Huelle nutzt bewusst das feine Erdnetz (Task 12c gemessen): mit 64 x 128
		// verschoben sich die Centroid-Abtastpunkte an den Dreieckskanten, der Halo
		// am Rand aenderte sich um bis 7 (Erde) bzw. 17 (Folgen) sRGB-Stufen.
		var erdNetz = netz(256, 512, "erde"), mondNetz = netz(64, 128, "mond");
		function setzeNetz(pass, m) {
			pass.setVertexBuffer(0, m.pos);
			pass.setVertexBuffer(1, m.uv);
			pass.setIndexBuffer(m.idx, "uint32");
		}

		var uniformPuffer = G.uniform(device, U_BYTES);
		var uniformDaten = new Float32Array(U_BYTES / 4);
		var sampler = G.sampler(device, { wiederholen: true, anisotropie: 8 });
		// Kacheln: klemmen in u und v (Rand 2 px deckt nur den bilinearen Filter)
		var samplerKacheln = G.sampler(device, { wiederholen: false, anisotropie: 8 });
		// Uniform "Kacheln": Puffer starten mit Nullen, also slots = 0 -> kein Slot,
		// solange keine Tabelle geschrieben wird.
		var kachelPuffer = G.uniform(device, K_BYTES);

		// 1x1-Ersatz je Karte: Tag (nie gesampelt, Ersatz-Pipeline), Nacht/Wolken/Maske
		// schwarz (keine Lichter, keine Wolken, kein Glanz), Mond grau.
		function einsMalEins(rgba, label) {
			var t = device.createTexture({ label: "ersatz " + label, size: [1, 1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
			device.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1, 1]);
			return t;
		}
		var ersatz = {
			tag: einsMalEins([40, 90, 180, 255], "tag"),
			nacht: einsMalEins([0, 0, 0, 255], "nacht"),
			wolken: einsMalEins([0, 0, 0, 255], "wolken"),
			maske: einsMalEins([0, 0, 0, 255], "maske"),
			mond: einsMalEins([140, 140, 140, 255], "mond"),
			kacheln: einsMalEins([0, 0, 0, 255], "kacheln")   // eine Schicht, als 2D-Array gebunden; nie gelesen (slots 0)
		};
		var texturen = { tag: null, nacht: null, wolken: null, maske: null, mond: null, kacheln: null };
		var kachelnGeschrieben = -1;                     // kachelnVersion der zuletzt geschriebenen Tabelle
		var bindGroup = null;
		function baueBindgruppe() {
			bindGroup = device.createBindGroup({
				label: "welt",
				layout: bindLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformPuffer } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: (texturen.tag || ersatz.tag).createView() },
					{ binding: 3, resource: (texturen.nacht || ersatz.nacht).createView() },
					{ binding: 4, resource: (texturen.wolken || ersatz.wolken).createView() },
					{ binding: 5, resource: (texturen.maske || ersatz.maske).createView() },
					{ binding: 6, resource: (texturen.mond || ersatz.mond).createView() },
					{ binding: 7, resource: (texturen.kacheln || ersatz.kacheln).createView({ dimension: "2d-array" }) },
					{ binding: 8, resource: { buffer: kachelPuffer } },
					{ binding: 9, resource: samplerKacheln }
				]
			});
		}
		baueBindgruppe();

		// Drehung des Mondes (spaltenweise 3x3 in der mat4): Karten-+X (lon 0) zur
		// Erde, Nordpol so nah wie moeglich an +Z (Ekliptikpol genaehert).
		function schreibeMondRot(p, ab) {
			var L = Math.hypot(p[0], p[1], p[2]) || 1;
			var x = [-p[0] / L, -p[1] / L, -p[2] / L];
			var z = [-x[2] * x[0], -x[2] * x[1], 1 - x[2] * x[2]];
			var lz = Math.hypot(z[0], z[1], z[2]);
			if (lz < 1e-6) { z = [1, 0, 0]; lz = 1; }                // Mond genau ueber einem Pol
			z = [z[0] / lz, z[1] / lz, z[2] / lz];
			var y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
			var u = uniformDaten;
			u[ab] = x[0]; u[ab + 1] = x[1]; u[ab + 2] = x[2]; u[ab + 3] = 0;
			u[ab + 4] = y[0]; u[ab + 5] = y[1]; u[ab + 6] = y[2]; u[ab + 7] = 0;
			u[ab + 8] = z[0]; u[ab + 9] = z[1]; u[ab + 10] = z[2]; u[ab + 11] = 0;
			u[ab + 12] = 0; u[ab + 13] = 0; u[ab + 14] = 0; u[ab + 15] = 1;
		}

		// Projektion mit der Kamera im Ursprung (Task 12b): kamera.matrizen liefert
		// welt.viewProjRel; fehlt es (aeltere Aufrufer), aus view/proj gebildet.
		function viewProjRelativ(m) {
			if (m.viewProjRel) return m.viewProjRel;
			var v = new Float32Array(m.view);
			v[12] = 0; v[13] = 0; v[14] = 0;
			return G.mat4.mul(m.proj, v);
		}

		var z = {
			modus: "ersatz",

			// t = { tag, nacht, wolken, maske, mond, kacheln } (GPUTexture oder null =
			// Ersatz; kacheln = texture_2d_array aus Kacheln.neu). Baut die Bindgruppe
			// neu (die alte gibt der Garbage Collector frei) und leitet modus ab
			// (optional t.modus setzt ihn).
			setzeTexturen: function (t) {
				t = t || {};
				texturen = { tag: t.tag || null, nacht: t.nacht || null, wolken: t.wolken || null, maske: t.maske || null, mond: t.mond || null, kacheln: t.kacheln || null };
				kachelnGeschrieben = -1;                     // Tabelle beim naechsten Bild neu schreiben
				baueBindgruppe();
				// 'voll', sobald die grosse Tagkarte da ist; fehlende uebrige Karten
				// bleiben Ersatz (1x1) und meldet der Lader als Warnung (tracker.js).
				if (t.modus) z.modus = t.modus;
				else if (!texturen.tag) z.modus = "ersatz";
				else if (texturen.tag.width >= VOLL_AB_PX) z.modus = "voll";
				else z.modus = "vorschau";
			},

			// weltMatrizen = kamera.matrizen(..).welt ({viewProjRel, pos}; viewProj/view/proj
			// als Rueckfall); o = { sonne [x,y,z]
			// (Einheitsvektor ECI), gmst (rad), mondPositionR [x,y,z] (Erdradien, optional),
			// zeitSek (Unix-Sekunden der Simulationszeit, fuer die Wolkendrift),
			// schalter: { wolken, atmosphaere, nachtlichter },
			// kacheln: Float32Array(20) von Kacheln.tabelle() (optional),
			// kachelnVersion: k.version - die Tabelle wird nur bei Aenderung geschrieben }
			zeichne: function (pass, weltMatrizen, o) {
				var s = o.schalter || {};
				var wolkenAn = s.wolken !== false && !!texturen.wolken;
				var atmoAn = s.atmosphaere !== false;
				var nachtAn = s.nachtlichter !== false;
				var u = uniformDaten;
				u.set(viewProjRelativ(weltMatrizen), U_VIEWPROJ);
				u.set(G.mat4.rotZ(o.gmst || 0), U_MODELL);
				var kp = weltMatrizen.pos;
				u[U_KAMERA] = kp[0]; u[U_KAMERA + 1] = kp[1]; u[U_KAMERA + 2] = kp[2]; u[U_KAMERA + 3] = 1;
				var so = o.sonne || [1, 0, 0];
				u[U_SONNE] = so[0]; u[U_SONNE + 1] = so[1]; u[U_SONNE + 2] = so[2]; u[U_SONNE + 3] = 0;
				// Wolkendrift: fract auf der CPU in doppelter Genauigkeit (zeitSek ~ 1,8e9).
				// Der Shader liest die Wolken bei u + versatz; ein wachsender Versatz
				// schiebt das Bild also nach Westen. Negativ = ostwaerts, wie die
				// Westwinde der mittleren Breiten (Task 12a).
				var umlaeufe = (o.zeitSek || 0) / 3600 * WOLKEN_DRIFT_GRAD_JE_H / 360;
				u[U_PARAMETER] = -(umlaeufe - Math.floor(umlaeufe));
				u[U_PARAMETER + 1] = wolkenAn ? 1 : 0;
				u[U_PARAMETER + 2] = nachtAn ? 1 : 0;
				u[U_PARAMETER + 3] = atmoAn ? 1 : 0;
				var mp = o.mondPositionR;
				var mondDa = !!(mp && isFinite(mp[0]) && isFinite(mp[1]) && isFinite(mp[2]));
				u[U_MOND] = mondDa ? mp[0] : 0; u[U_MOND + 1] = mondDa ? mp[1] : 0; u[U_MOND + 2] = mondDa ? mp[2] : 0;
				u[U_MOND + 3] = MOND_RADIUS;
				schreibeMondRot(mondDa ? mp : [1, 0, 0], U_MONDROT);
				device.queue.writeBuffer(uniformPuffer, 0, u);
				// Kacheltabelle nur, wenn auch die Kacheltextur gebunden ist (sonst
				// bleibt der Puffer bei slots = 0 und der Shader liest keinen Slot),
				// und nur bei geaenderter Version (Fix-Runde 1).
				var kv = isFinite(o.kachelnVersion) ? o.kachelnVersion : 0;
				if (o.kacheln && texturen.kacheln && o.kacheln.length * 4 === K_BYTES && kv !== kachelnGeschrieben) {
					device.queue.writeBuffer(kachelPuffer, 0, o.kacheln);
					kachelnGeschrieben = kv;
				}

				pass.setBindGroup(0, bindGroup);
				// Opak zuerst (Tiefe): Erde, Mond. Dann die Huelle: erst Durchlass
				// (multiplikativ), dann Einstreuung (additiv). Die Wolken zuletzt
				// (Task 12b): im Ring 1,0-1,004 R schreiben sie keine Tiefe, und die
				// additive Huelle (volle Tangentensehne) legte sich vorher auf die
				// Wolkenfarbe (halbe Sehne) - eine weisse 1-px-Randlinie (255) am
				// Limb. Jetzt blenden die Wolken ueber T * Hintergrund + Huelle.
				setzeNetz(pass, erdNetz);
				pass.setPipeline(z.modus === "ersatz" ? pErsatz : pErde);
				pass.drawIndexed(erdNetz.n);
				if (mondDa) {
					setzeNetz(pass, mondNetz);
					pass.setPipeline(pMond);
					pass.drawIndexed(mondNetz.n);
					setzeNetz(pass, erdNetz);
				}
				if (atmoAn) {
					pass.setPipeline(pAtmoVorn);
					pass.drawIndexed(erdNetz.n);
					pass.setPipeline(pAtmoHinten);
					pass.drawIndexed(erdNetz.n);
				}
				if (wolkenAn) {
					pass.setPipeline(pWolken);
					pass.drawIndexed(erdNetz.n);
				}
			}
		};
		return z;
	}

	window.Erdzeichner = { neu: neu, U_BYTES: U_BYTES, K_BYTES: K_BYTES };
})(window);
