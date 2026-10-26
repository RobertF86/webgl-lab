/*
 * ISS Tracker - ISS-Ebene: das prozedurale Stationsmodell (iss-modell.js) in
 * Metern um die Stationsmitte, mit Sonnenlicht (GGX), Erdschatten, Erdschein,
 * Solarfluegel-Nachfuehrung und Positionslichtern. Das Modell ist opak (Task
 * 12a: der Uebergang zum Marker liegt im Subpixelbereich, ein Alpha-Blend
 * brachte nur den Tiefenschreib-Kompromiss); den Marker blendet tracker.js.
 *
 * Koordinaten: Das Modell liegt im Stationssystem (+X Steuerbord entlang des
 * Traegers, +Y Flugrichtung, +Z Zenit). Die Kameramatrizen der ISS-Ebene sind
 * in Metern relativ zur Station, aber ECI-orientiert; 'modell' ist deshalb die
 * Drehung Stationssystem -> ECI mit den Spalten seite, vorn, oben (Bahnsystem
 * der Kamera). Beleuchtet wird im Stationssystem: Die Anwendung uebergibt
 * Sonnen- und Erdrichtung schon dorthin gedreht, die Kameraposition wird hier
 * umgerechnet ([dot(p, seite), dot(p, vorn), dot(p, oben)]).
 *
 * Solarfluegel (Material 2) drehen um die Traegerachse (parallel x durch
 * y 0, z 5,5 - die z-Hoehe wird aus dem Modell gelesen) um solarWinkel; die
 * Auswahl geschieht im Vertex-Shader ueber das Material, es gibt also nur eine
 * Uniform mit zwei Modellmatrizen. Drehsinn: Fluegelnormale (0,0,1) -> (0, sin w,
 * cos w), also zeigt sie fuer w = atan2(sonne.y, sonne.z) zur Sonne.
 *
 * Pipelines (ein Shader, depth32float greater, MSAA 4x): 'koerper' opak mit
 * Rueckseiten-Culling fuer die geschlossenen Koerper (CCW nach aussen),
 * 'platten' opak ohne Culling fuer die einseitigen Solarfluegel und Radiatoren
 * (Normale im Fragment ueber front_facing gekehrt; Rueckseite der Fluegel als
 * Kapton), 'streben' (Task 12b) Alpha-Blend, Tiefe nur lesen: nur der Traeger,
 * nur die auf STREBE_MIN_PX aufgeweiteten Streben mit Alpha = Deckung (die
 * opaken Durchgaenge verwerfen sie), 'lichter' mit Max-Blend, Tiefe nur lesen: zwei Bildpixel-Sprites (Quad
 * wie der Marker in spur.js, LICHT_PX * dpr) an den Positionslichtern, rot
 * Backbord (-x) / gruen Steuerbord (+x), sanft pulsierend mit 1 Hz Simulations-
 * zeit; Sprite und emissiver Quader nur sRGB-kodiert, ohne Tonemapping.
 * Die Draw-Laeufe entstehen aus der Teileliste des Modells.
 *
 * Vertex-Puffer verschraenkt, 48 Byte je Ecke: Position 0 (float32x3), Normale
 * 12 (float32x3), UV 24 (float32x2), Material 32 (uint8x4; das Modell liefert
 * 1 Byte je Ecke, hier auf 4 aufgefuellt), Querversatz 36 (float32x3, Task 12b:
 * Versatz der Ecke von der Achse ihrer Traegerstrebe, sonst 0 - der Vertex-
 * Shader weitet damit Streben auf STREBE_MIN_PX auf). Positionslichter: zwei
 * kleine Quader an den Traegerenden, Material 0 mit UV.x = -1 als Kennung ->
 * emissiv (fuer Nahaufnahmen); die Sprites liegen 0,6 m davor.
 *
 * Umgebungslicht (Task 12b): richtungsloser Rest UMGEBUNG plus Halbkugel (oben
 * Weltraum, unten Erdblau nach erdschein), gemischt nach n . Erdrichtung.
 *
 * Uniform "Iss" (272 Byte): viewProj 0, modell 64 (Station -> ECI), fluegel 128
 * (Fluegeldrehung, Station -> Station), kamera 192 (Stationssystem, m; w =
 * Projektionsfaktor f = 1/tan(fov/2)), sonne 208, erde 224 (Richtungen im
 * Stationssystem), parameter 240 (imSchatten, erdschein, lichtX, lichtZ: Ort der
 * Positionslichter +-x / z im Stationssystem), bild 256 (Viewport in
 * Geraetepixeln, dpr, Pulsphase 0..1).
 *
 * Nichts hier fasst auf oberster Ebene navigator, document oder GPU* an.
 */
(function (window) {
	"use strict";

	// Float-Indizes in der Uniform (Byte / 4)
	var U_VIEWPROJ = 0, U_MODELL = 16, U_FLUEGEL = 32, U_KAMERA = 48, U_SONNE = 52, U_ERDE = 56, U_PARAMETER = 60, U_BILD = 64;
	var U_BYTES = 272;
	var STRIDE = 48;                                // Byte je Ecke (Task 12b: 36 + Querversatz float32x3)
	var TEXTUR_B = 512, TEXTUR_H = 1024;            // Solarzellen-Textur (u quer, v laengs)
	var ZELLEN_U = 8, ZELLEN_V = 30, LINIE_PX = 2;
	var ZELLE_RGB = [27, 42, 107];                  // #1b2a6b
	var LINIE_FARBE = "#c9a24a";
	var TRAEGER_Z_ERSATZ = 5.5;                     // Traegerachse, falls kein Fluegel im Modell gefunden wird
	var LICHT_GROESSE = 0.5;                        // Kantenlaenge der Positionslichter (m)
	// Task 12a (A3), aus der Pruefung t10-schatten-nah.png (Station im Erdschatten
	// praktisch unsichtbar, Traeger 20/22/26 auf Hintergrund 11/14/20) und
	// t10-nah80.png (Traeger als formlose graue Staebe: Material 0 hatte 0,1 Diffus):
	var LICHT_PX = 4;                               // Durchmesser der Positionslicht-Sprites (CSS-Pixel)
	var LICHT_VOR_M = 0.6;                          // Sprite zur Kamera hin versetzt, vor dem emissiven Quader (0,25 m Halbkante)
	// Lichtfarben linear; Ausgabe nur sRGB-kodiert (Fix-Runde 1: ACES machte aus
	// Rot Lachs 241/141/112). Ziel sRGB rot 255/97/80, gruen 108/255/137.
	var LICHT_ROT = [1.0, 0.12, 0.08], LICHT_GRUEN = [0.15, 1.0, 0.25];
	// Task 12b (A5): Traeger im Erdschatten war flach 72/72/71 (t12a-a3-zoom-schatten-nah.png).
	// Umgebung jetzt richtungslos UMGEBUNG (12a: 0,07) plus Halbkugel: oben (Weltraum)
	// HALBKUGEL_OBEN, unten (Erde) erdBlau * (HALBKUGEL_GRUND + HALBKUGEL_ERDSCHEIN *
	// erdschein) mit erdBlau = ERDSCHEIN_FARBE * ERDSCHEIN_STAERKE, gemischt nach
	// n . erdRichtung (smoothstep -1..1); Metalle ueber die Grundfarbe (F0). Ersetzt
	// den frueheren Lambert-Erdschein (nur max(n . erde, 0)): Silhouette oben dunkler
	// als unten, Werte ~60-120 sRGB im Schatten.
	var UMGEBUNG = 0.05;
	var HALBKUGEL_OBEN = 0.02, HALBKUGEL_GRUND = 0.25, HALBKUGEL_ERDSCHEIN = 0.75;
	var ERDSCHEIN_FARBE = [0.35, 0.5, 0.75], ERDSCHEIN_STAERKE = 0.5;
	var ERDBLAU = ERDSCHEIN_FARBE.map(function (c) { return c * ERDSCHEIN_STAERKE; });
	// Task 12b (A5): Streben-Mindestbreite in CSS-Pixeln. Die Traegerstreben (0,15-0,25 m)
	// sind bei 0,8 km 0,26-0,43 px duenn - MSAA-Deckung und Glanz auf Subpixel-Flaechen
	// ergaben eine Kette heller Punkte (Traegerfunkeln). Der Vertex-Shader skaliert den
	// Querschnitt jeder Strebe um ihre Achse (Attribut 'quer' aus iss-modell.js), bis
	// die projizierte Dicke STREBE_MIN_PX * dpr erreicht; groessere Streben bleiben.
	// Allein aufgeweitet wurde der Traeger bei 0,8 km ein massiver Balken (8
	// Diagonalen je 4-m-Feld fuellen den Querschnitt); deshalb bekommt jede
	// aufgeweitete Strebe die Deckung physikalische / aufgeweitete Breite als
	// Alpha: die opaken Durchgaenge verwerfen solche Fragmente, ein dritter
	// Durchgang 'streben' (Alpha-Blend, Tiefe nur lesen, nur der Traeger)
	// zeichnet sie - die mittlere Helligkeit je Pixel bleibt, das Flimmern der
	// Subpixel-Deckung entfaellt. Nah (Breite >= STREBE_MIN_PX) bleibt alles opak.
	var STREBE_MIN_PX = 1.5;
	var TRAEGER_STOFF = { farbe: [0.80, 0.81, 0.83], metall: 0.5, rauheit: 0.5 };      // Material 0 (war 0,75/0,76/0,78, 0,9, 0,4)
	var FLUEGEL_RUECKSEITE = { farbe: [0.45, 0.28, 0.12], metall: 0.2, rauheit: 0.5 }; // Kapton statt schwarz
	function v3(v) { return "vec3<f32>(" + v.map(function (x) { return x.toFixed(3); }).join(", ") + ")"; }
	function stoffWgsl(s) { return "Stoff(" + v3(s.farbe) + ", " + s.metall.toFixed(2) + ", " + s.rauheit.toFixed(2) + ")"; }

	// ACES + sRGB + linear() (Task 12c): einzige Quelle ist Himmelszeichner.WGSL_AUSGABE
	// (himmel.js, in index.html vor iss.js geladen). Erst in neu() gelesen und
	// vorangestellt, damit iss.js auch ohne himmel.js ladbar bleibt (iss_test.js).
	function wgslAusgabe() {
		var H = window.Himmelszeichner;
		if (!H || typeof H.WGSL_AUSGABE !== "string") throw new Error("himmel.js missing (Himmelszeichner.WGSL_AUSGABE)");
		return H.WGSL_AUSGABE;
	}

	var WGSL = `
struct Iss {
	viewProj: mat4x4<f32>, modell: mat4x4<f32>, fluegel: mat4x4<f32>,
	kamera: vec4<f32>, sonne: vec4<f32>, erde: vec4<f32>, parameter: vec4<f32>, bild: vec4<f32>
};
@group(0) @binding(0) var<uniform> U: Iss;
@group(0) @binding(1) var sTex: sampler;
@group(0) @binding(2) var tSolar: texture_2d<f32>;

const PI = 3.141592654;
const UMGEBUNG = ${UMGEBUNG.toFixed(3)};
const HALBKUGEL_OBEN = ${HALBKUGEL_OBEN.toFixed(3)};
const HALBKUGEL_GRUND = ${HALBKUGEL_GRUND.toFixed(3)};
const HALBKUGEL_ERDSCHEIN = ${HALBKUGEL_ERDSCHEIN.toFixed(3)};
const ERDBLAU = ${v3(ERDBLAU)};                     // ERDSCHEIN_FARBE * ERDSCHEIN_STAERKE
const STREBE_MIN_PX = ${STREBE_MIN_PX.toFixed(2)};
const LICHT_PX = ${LICHT_PX.toFixed(1)};
const LICHT_VOR_M = ${LICHT_VOR_M.toFixed(2)};
const LICHT_ROT = ${v3(LICHT_ROT)};                 // Backbord (-x), linear; emissiv nur sRGB-kodiert, nicht tonegemappt
const LICHT_GRUEN = ${v3(LICHT_GRUEN)};             // Steuerbord (+x)

struct VOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) p: vec3<f32>,                       // Stationssystem, Meter
	@location(1) n: vec3<f32>,                       // Stationssystem (flach je Flaeche)
	@location(2) uv: vec2<f32>,
	@location(3) @interpolate(flat) material: u32,
	@location(4) @interpolate(flat) licht: u32,                // Positionslicht (UV.x < 0 an allen Ecken): 1 Backbord rot, 2 Steuerbord gruen
	@location(5) @interpolate(flat) deckung: f32               // 1 opak; < 1: aufgeweitete Strebe, Alpha im Durchgang 'streben'
};
// Fluegel (Material 2) bekommen die zweite Modellmatrix (Drehung um die Traegerachse).
// Die Lichtkennung wird hier je Ecke entschieden und flach weitergegeben: Das
// interpolierte UV im Fragment-Shader wird bei MSAA an Kanten extrapoliert und
// rutscht auf duennen Streben unter 0 - jede Kante bekaeme Lichtfarbe.
// quer: Versatz der Ecke von der Achse ihrer Strebe (Traeger, sonst 0). Streben-
// Mindestbreite (Task 12b): projizierte Dicke d * f * (H/2) / w in Geraetepixeln;
// liegt sie unter STREBE_MIN_PX * dpr, wird der Querschnitt um die Achse skaliert
// (p += quer * (s - 1)) - alle Ecken eines Endes bekommen dasselbe s, der Kasten
// bleibt ein Kasten, Normale und Beleuchtung unveraendert. f steht in U.kamera.w.
@vertex fn vs(@location(0) p0: vec3<f32>, @location(1) n0: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) material: vec4<u32>,
              @location(4) quer: vec3<f32>) -> VOut {
	var p = p0;
	var n = n0;
	let m = material.x;
	if (m == 2u) {
		p = (U.fluegel * vec4(p0, 1.0)).xyz;
		n = (U.fluegel * vec4(n0, 0.0)).xyz;
	}
	var deckung = 1.0;
	let q2 = dot(quer, quer);
	if (q2 > 0.0) {
		let w = (U.viewProj * (U.modell * vec4(p, 1.0))).w;
		let dicke = sqrt(2.0 * q2);                                        // |quer| = Kantenlaenge / sqrt(2)
		let px = dicke * U.kamera.w * 0.5 * U.bild.y / max(w, 1e-3);
		let s = max(1.0, STREBE_MIN_PX * U.bild.z / max(px, 1e-4));
		p += quer * (s - 1.0);
		deckung = 1.0 / s;
	}
	var o: VOut;
	o.pos = U.viewProj * (U.modell * vec4(p, 1.0));
	o.p = p; o.n = n; o.uv = uv; o.material = m; o.deckung = deckung;
	o.licht = select(0u, select(2u, 1u, p0.x < 0.0), uv.x < 0.0);
	return o;
}

// Materialtabelle: Grundfarbe (linear), Metall, Rauheit; die Rueckseite der
// Solarfluegel (Material 2 von hinten) ist Kapton statt schwarz.
struct Stoff { farbe: vec3<f32>, metall: f32, rauheit: f32 };
fn stoff(m: u32, tex: vec3<f32>, vorn: bool) -> Stoff {
	switch (m) {
		case 1u: { return Stoff(vec3(0.92, 0.92, 0.90), 0.0, 0.7); }   // Weiss (Module, Radiatoren)
		case 2u: {
			if (vorn) { return Stoff(tex, 0.3, 0.25); }                // Solarzellen (Textur)
			return ${stoffWgsl(FLUEGEL_RUECKSEITE)};                    // Kapton-Rueckseite
		}
		case 3u: { return Stoff(vec3(0.85, 0.7, 0.35), 0.8, 0.3); }    // Folie (Zarya, Dragon)
		case 4u: { return Stoff(vec3(0.3, 0.4, 0.5), 0.5, 0.1); }      // Fenster (Cupola)
		default: { return ${stoffWgsl(TRAEGER_STOFF)}; }                // Metall (Traeger, Kleinteile)
	}
}

// Opake Durchgaenge (koerper, platten): aufgeweitete Streben (deckung < 1)
// verwerfen; Durchgang 'streben' (Alpha-Blend): nur diese, Alpha = deckung.
@fragment fn fsOpak(i: VOut, @builtin(front_facing) vorn: bool) -> @location(0) vec4<f32> {
	if (i.deckung < 0.999) { discard; }
	return schattiere(i, vorn);
}
@fragment fn fsStreben(i: VOut, @builtin(front_facing) vorn: bool) -> @location(0) vec4<f32> {
	if (i.deckung >= 0.999) { discard; }
	let f = schattiere(i, vorn);
	return vec4(f.rgb, i.deckung);
}
fn schattiere(i: VOut, vorn: bool) -> vec4<f32> {
	// Textur immer lesen (uniformer Kontrollfluss), erst danach nach Material waehlen
	let tex = linear(textureSample(tSolar, sTex, i.uv).rgb);
	let s = stoff(i.material, tex, vorn);
	var n = normalize(i.n);
	if (!vorn) { n = -n; }                            // einseitige Platten von hinten
	let v = normalize(U.kamera.xyz - i.p);
	let l = normalize(U.sonne.xyz);
	let radiance = 5.0 * (1.0 - U.parameter.x);      // Sonne, im Erdschatten aus
	let ndl = max(dot(n, l), 0.0);
	let ndv = max(dot(n, v), 1e-4);
	// GGX: Normalverteilung Trowbridge-Reitz, Geometrie Smith mit Schlick-GGX
	// (k = (r+1)^2/8 fuer direktes Licht), Fresnel nach Schlick; Diffus Lambert.
	// Halbvektor: bei v = -l ist v + l der Nullvektor (normalize -> NaN), dann n.
	let vl = v + l;
	let h = select(normalize(vl), n, dot(vl, vl) < 1e-8);
	let ndh = max(dot(n, h), 0.0);
	let vdh = max(dot(v, h), 0.0);
	let a = max(s.rauheit * s.rauheit, 0.02);        // Untergrenze gegen Glanzflimmern auf kleinen Flaechen
	let a2 = a * a;
	let dd = ndh * ndh * (a2 - 1.0) + 1.0;
	let D = a2 / (PI * dd * dd);
	let k = (s.rauheit + 1.0) * (s.rauheit + 1.0) / 8.0;
	let G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
	let F0 = mix(vec3(0.04), s.farbe, s.metall);
	let F = F0 + (vec3(1.0) - F0) * pow(1.0 - vdh, 5.0);
	let spek = min(D * G * F / max(4.0 * ndv * ndl, 1e-4), vec3(4.0));
	let diffus = s.farbe * (1.0 - s.metall) / PI;
	var farbe = (diffus + spek) * radiance * ndl;
	// Umgebung (Task 12b): Halbkugel - unten (Erdrichtung) Erdblau, auf der Tagseite
	// der Erde am staerksten (erdschein = U.parameter.y), oben der dunkle Weltraum;
	// dazu ein richtungsloser Rest UMGEBUNG. So bleibt die Station im Erdschatten
	// als Silhouette mit Gradation lesbar. Metalle nehmen die Umgebung ueber F0.
	let unten = ERDBLAU * (HALBKUGEL_GRUND + HALBKUGEL_ERDSCHEIN * U.parameter.y);
	let halbkugel = mix(vec3(HALBKUGEL_OBEN), unten, smoothstep(-1.0, 1.0, dot(n, normalize(U.erde.xyz))));
	farbe += mix(s.farbe, F0, s.metall) * (halbkugel + UMGEBUNG);
	// Positionslicht (Nahaufnahme): emissiv, ohne Tonemapping (ACES machte aus Rot Lachs)
	if (i.licht == 1u) { return vec4(srgb(LICHT_ROT), 1.0); }
	if (i.licht == 2u) { return vec4(srgb(LICHT_GRUEN), 1.0); }
	return vec4(ausgabe(farbe), 1.0);
}

// ---------------------------------------------------------- Positionslicht-Sprites
// Zwei Quads aus je 6 Ecken (vertex_index): 0..5 Backbord (-x, rot), 6..11
// Steuerbord (+x, gruen), LICHT_PX * dpr gross, an der Tiefe des Lichts
// (LICHT_VOR_M zur Kamera hin, damit der emissive Quader das Sprite nicht
// verdeckt); Max-Blend (je Kanal max(Sprite, Bild): ueber dem emissiven Quader
// und ueber dunklem Grund genau die Lichtfarbe, ueber sonnenhellem Traeger
// unsichtbar - additiv wurde der Kern weiss), Tiefe nur lesen (hinter
// Modulen/Fluegeln verdeckt). Farbe nur sRGB-kodiert, nicht tonegemappt.
struct LOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) @interpolate(flat) seite: f32 };
@vertex fn vsLicht(@builtin(vertex_index) vi: u32) -> LOut {
	var ecken = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(1.,1.), vec2(-1.,-1.), vec2(1.,1.), vec2(-1.,1.));
	let e = ecken[vi % 6u];
	let seite = select(-1.0, 1.0, vi >= 6u);
	var p = vec3(seite * U.parameter.z, 0.0, U.parameter.w);           // Licht im Stationssystem (m)
	p += normalize(U.kamera.xyz - p) * LICHT_VOR_M;
	let clip = U.viewProj * (U.modell * vec4(p, 1.0));
	let px = LICHT_PX * U.bild.z;                                        // Durchmesser in Geraetepixeln
	var o: LOut;
	o.pos = vec4(clip.xy + e * px / U.bild.xy * clip.w, clip.z, clip.w);
	o.uv = e; o.seite = seite;
	return o;
}
@fragment fn fsLicht(i: LOut) -> @location(0) vec4<f32> {
	let r = length(i.uv);
	let deckung = 1.0 - smoothstep(0.3, 1.0, r);                         // weicher Lichtpunkt
	if (deckung <= 0.0) { discard; }
	let farbe = select(LICHT_GRUEN, LICHT_ROT, i.seite < 0.0);
	let puls = 0.65 + 0.35 * sin(U.bild.w * 6.283185307);               // 1 Hz, nie ganz aus
	return vec4(srgb(farbe) * (deckung * puls), 1.0);                    // Max-Blend: Deckung in der Farbe
}
`;

	var VERTEX_BUFFERS = [{
		arrayStride: STRIDE,
		attributes: [
			{ shaderLocation: 0, offset: 0,  format: "float32x3" },   // Position
			{ shaderLocation: 1, offset: 12, format: "float32x3" },   // Normale
			{ shaderLocation: 2, offset: 24, format: "float32x2" },   // UV
			{ shaderLocation: 3, offset: 32, format: "uint8x4" },     // Material (x), Rest 0
			{ shaderLocation: 4, offset: 36, format: "float32x3" }    // Querversatz zur Strebenachse (Task 12b; 0 = keine Strebe)
		]
	}];

	// ---------------------------------------------------------- reine Helfer (auch ohne GPU)
	function istPlatte(teil) { return /^(Solarfluegel|Radiator)/.test(teil.name); }

	// Zusammenhaengende Teile gleicher Art zu Draw-Laeufen zusammenfassen
	// (Reihenfolge des Indexpuffers): [{art: 'koerper'|'platte', start, anzahl}].
	// Task 12c: vorher draufLaeufe (bleibt als Alias in IssZeichner).
	function zeichenLaeufe(teile) {
		var laeufe = [];
		teile.forEach(function (t) {
			if (!t.anzahl) return;
			var art = istPlatte(t) ? "platte" : "koerper";
			var l = laeufe[laeufe.length - 1];
			if (l && l.art === art && l.start + l.anzahl === t.start) l.anzahl += t.anzahl;
			else laeufe.push({ art: art, start: t.start, anzahl: t.anzahl });
		});
		return laeufe;
	}

	// Fluegeldrehung um die Traegerachse (parallel x durch y 0, z z0) als
	// spaltenweise mat4 in ziel ab Index ab (Vorgabe: neues Float32Array(16)):
	// y' = c y + s (z - z0), z' = z0 - s y + c (z - z0). Die Normale (0,0,1) wird
	// zu (0, sin w, cos w) - entspricht GPU.mat4.rotX(-w) um die Achse; fuer
	// w = atan2(sonne.y, sonne.z) zeigt sie zur Sonne (Test: tests/iss_test.js).
	function fluegelMatrix(w, z0, ziel, ab) {
		var u = ziel || new Float32Array(16), o = ab || 0;
		var c = Math.cos(w), s = Math.sin(w);
		u[o] = 1; u[o + 1] = 0; u[o + 2] = 0; u[o + 3] = 0;
		u[o + 4] = 0; u[o + 5] = c; u[o + 6] = -s; u[o + 7] = 0;
		u[o + 8] = 0; u[o + 9] = s; u[o + 10] = c; u[o + 11] = 0;
		u[o + 12] = 0; u[o + 13] = -s * z0; u[o + 14] = z0 * (1 - c); u[o + 15] = 1;
		return u;
	}

	// z der Traegerachse: die Solarfluegel liegen in ihrer Ebene (Wurzel an der
	// Traegerwand, Platte durch die Achse); erste Ecke des ersten Fluegels.
	function traegerAchseZ(netz) {
		for (var k = 0; k < netz.teile.length; k++) {
			var t = netz.teile[k];
			if (/^Solarfluegel/.test(t.name) && t.anzahl > 0) return netz.positionen[3 * netz.indizes[t.start] + 2];
		}
		return TRAEGER_Z_ERSATZ;
	}

	// Positionslichter: zwei kleine Quader an den Traegerenden (x = +-Halbbreite),
	// Material 0, UV.x = -1 als Kennung fuer den Fragment-Shader.
	function baueLichter(IssModell, netz, achseZ) {
		var b = IssModell.builder();
		var halb = netz.masse.breite / 2, g = LICHT_GROESSE;
		[-1, 1].forEach(function (vz) {
			IssModell.quader(b, { mitte: [vz * (halb + g / 2), 0, achseZ], groesse: [g, g, g], material: 0 });
		});
		var l = b.fertig();
		for (var k = 0; k < l.uv.length; k += 2) l.uv[k] = -1;
		return l;
	}

	// Ecken eines Netzes verschraenkt in den ArrayBuffer schreiben (ab Ecke 'ab');
	// quer (Task 12b) fehlt bei aelteren Netzen -> 0 (keine Aufweitung).
	function fuelleEcken(puffer, ab, netz) {
		var f = new Float32Array(puffer), u8 = new Uint8Array(puffer);
		var n = netz.positionen.length / 3, q = netz.quer && netz.quer.length >= 3 * n ? netz.quer : null;
		for (var k = 0; k < n; k++) {
			var e = (ab + k) * (STRIDE / 4);
			f[e] = netz.positionen[3 * k]; f[e + 1] = netz.positionen[3 * k + 1]; f[e + 2] = netz.positionen[3 * k + 2];
			f[e + 3] = netz.normalen[3 * k]; f[e + 4] = netz.normalen[3 * k + 1]; f[e + 5] = netz.normalen[3 * k + 2];
			f[e + 6] = netz.uv[2 * k]; f[e + 7] = netz.uv[2 * k + 1];
			u8[(ab + k) * STRIDE + 32] = netz.material[k];
			f[e + 9] = q ? q[3 * k] : 0; f[e + 10] = q ? q[3 * k + 1] : 0; f[e + 11] = q ? q[3 * k + 2] : 0;
		}
	}

	// Zellenraster: dunkles Blau, je Zelle leichte Helligkeitsvariation, goldene Linien
	function hash(i, j) { var s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453; return s - Math.floor(s); }
	function maleSolarzellen(canvas) {
		var ctx = canvas.getContext("2d");
		var b = canvas.width, h = canvas.height, zb = b / ZELLEN_U, zh = h / ZELLEN_V;
		ctx.fillStyle = "rgb(" + ZELLE_RGB.join(",") + ")";
		ctx.fillRect(0, 0, b, h);
		for (var j = 0; j < ZELLEN_V; j++) {
			for (var i = 0; i < ZELLEN_U; i++) {
				var f = 0.9 + 0.2 * hash(i, j);
				ctx.fillStyle = "rgb(" + Math.round(ZELLE_RGB[0] * f) + "," + Math.round(ZELLE_RGB[1] * f) + "," + Math.min(255, Math.round(ZELLE_RGB[2] * f)) + ")";
				ctx.fillRect(Math.round(i * zb), Math.round(j * zh), Math.ceil(zb), Math.ceil(zh));
			}
		}
		ctx.fillStyle = LINIE_FARBE;
		for (i = 0; i <= ZELLEN_U; i++) ctx.fillRect(Math.min(b - LINIE_PX, Math.round(i * zb)), 0, LINIE_PX, h);
		for (j = 0; j <= ZELLEN_V; j++) ctx.fillRect(0, Math.min(h - LINIE_PX, Math.round(j * zh)), b, LINIE_PX);
	}

	// ---------------------------------------------------------- Zeichner
	function neu(gpu, format) {
		var device = gpu.device;
		var G = window.GPU, IssModell = window.IssModell;
		format = format || gpu.format;
		if (!IssModell || typeof IssModell.baue !== "function") throw new Error("iss-modell.js missing");

		// ---- Netz: Modell plus Positionslichter, verschraenkt
		var netz = IssModell.baue();
		var achseZ = traegerAchseZ(netz);
		var lichter = baueLichter(IssModell, netz, achseZ);
		var lichtX = netz.masse.breite / 2 + LICHT_GROESSE / 2;   // Mitte der Positionslichter (+-x), fuer die Sprites
		var nModell = netz.positionen.length / 3, nLichter = lichter.positionen.length / 3;
		var ecken = new ArrayBuffer((nModell + nLichter) * STRIDE);
		fuelleEcken(ecken, 0, netz);
		fuelleEcken(ecken, nModell, lichter);
		var indizes = new Uint32Array(netz.indizes.length + lichter.indizes.length);
		indizes.set(netz.indizes);
		for (var k = 0; k < lichter.indizes.length; k++) indizes[netz.indizes.length + k] = lichter.indizes[k] + nModell;
		var teile = netz.teile.concat([{ name: "Positionslichter", material: 0, start: netz.indizes.length, anzahl: lichter.indizes.length }]);
		var laeufe = zeichenLaeufe(teile);
		var eckenPuffer = G.puffer(device, new Uint8Array(ecken), GPUBufferUsage.VERTEX);
		var indexPuffer = G.puffer(device, indizes, GPUBufferUsage.INDEX);

		// ---- Solarzellen-Textur aus einem Offscreen-Canvas, mit Mipmaps
		var canvas = document.createElement("canvas");
		canvas.width = TEXTUR_B; canvas.height = TEXTUR_H;
		maleSolarzellen(canvas);
		var solarTextur = G.textur(device, canvas, { mipmaps: true, label: "solarzellen" });
		var sampler = G.sampler(device, { wiederholen: false, anisotropie: 8 });

		// ---- Pipelines
		var modul = G.shader(device, wgslAusgabe() + WGSL, "iss");
		var bindLayout = device.createBindGroupLayout({
			label: "iss",
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } }
			]
		});
		var pipelineLayout = device.createPipelineLayout({ label: "iss", bindGroupLayouts: [bindLayout] });
		var BLEND_MAX = {                                    // je Kanal max(Quelle, Ziel); Faktoren sind bei max ohne Wirkung
			color: { srcFactor: "one", dstFactor: "one", operation: "max" },
			alpha: { srcFactor: "one", dstFactor: "one", operation: "max" }
		};
		var BLEND_ALPHA = {
			color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
			alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
		};
		function pipeline(label, cull, blend) {
			return device.createRenderPipeline({
				label: label,
				layout: pipelineLayout,
				vertex: { module: modul, entryPoint: "vs", buffers: VERTEX_BUFFERS },
				fragment: { module: modul, entryPoint: blend ? "fsStreben" : "fsOpak", targets: [{ format: format, blend: blend || undefined }] },
				primitive: { topology: "triangle-list", cullMode: cull, frontFace: "ccw" },
				depthStencil: { format: "depth32float", depthWriteEnabled: !blend, depthCompare: "greater" },
				multisample: { count: 4 }
			});
		}
		var pipelines = { koerper: pipeline("iss koerper", "back"), platte: pipeline("iss platten", "none") };
		// Task 12b: aufgeweitete Traegerstreben, Alpha = Deckung, Tiefe nur lesen (nach den opaken Laeufen)
		var pStreben = pipeline("iss streben", "back", BLEND_ALPHA);
		var traegerTeil = null;
		teile.forEach(function (t) { if (/^Traeger/.test(t.name) && t.anzahl > 0) traegerTeil = t; });
		var pLichter = device.createRenderPipeline({
			label: "iss lichter",
			layout: pipelineLayout,
			vertex: { module: modul, entryPoint: "vsLicht", buffers: [] },
			fragment: { module: modul, entryPoint: "fsLicht", targets: [{ format: format, blend: BLEND_MAX }] },
			primitive: { topology: "triangle-list", cullMode: "none" },
			depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "greater" },
			multisample: { count: 4 }
		});

		var uniformPuffer = G.uniform(device, U_BYTES);
		var u = new Float32Array(U_BYTES / 4);
		var bindGroup = device.createBindGroup({
			label: "iss",
			layout: bindLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformPuffer } },
				{ binding: 1, resource: sampler },
				{ binding: 2, resource: solarTextur.createView() }
			]
		});

		// Stationssystem -> ECI: Spalten seite, vorn, oben (spaltenweise mat4)
		function schreibeModell(ab, sys) {
			var s = sys.seite, v = sys.vorn, o = sys.oben;
			u[ab] = s[0]; u[ab + 1] = s[1]; u[ab + 2] = s[2]; u[ab + 3] = 0;
			u[ab + 4] = v[0]; u[ab + 5] = v[1]; u[ab + 6] = v[2]; u[ab + 7] = 0;
			u[ab + 8] = o[0]; u[ab + 9] = o[1]; u[ab + 10] = o[2]; u[ab + 11] = 0;
			u[ab + 12] = 0; u[ab + 13] = 0; u[ab + 14] = 0; u[ab + 15] = 1;
		}
		// Fluegeldrehung um die Traegerachse (fluegelMatrix, oben) direkt in die Uniform
		function schreibeFluegel(ab, w) { fluegelMatrix(w, achseZ, u, ab); }
		function schreibeVec(ab, v, w) { u[ab] = v[0]; u[ab + 1] = v[1]; u[ab + 2] = v[2]; u[ab + 3] = w; }
		function insStationssystem(r, sys) {
			return [r[0] * sys.seite[0] + r[1] * sys.seite[1] + r[2] * sys.seite[2],
			        r[0] * sys.vorn[0] + r[1] * sys.vorn[1] + r[2] * sys.vorn[2],
			        r[0] * sys.oben[0] + r[1] * sys.oben[1] + r[2] * sys.oben[2]];
		}
		function endlich3(v) { return !!(v && v.length >= 3 && isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2])); }
		function clamp01(x) { return isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; }
		var IDENTITAET = { seite: [1, 0, 0], vorn: [0, 1, 0], oben: [0, 0, 1] };

		var z = {
			dreiecke: indizes.length / 3,
			ecken: nModell + nLichter,
			laeufe: laeufe,
			achseZ: achseZ,

			// issMatrizen = kamera.matrizen(..).iss ({viewProj, pos}: Meter relativ zur
			// Station, ECI-orientiert). o = { stationssystem: {seite, vorn, oben} (ECI-
			// Einheitsvektoren des Bahnsystems), sonneRichtungStation, erdRichtungStation
			// (Einheitsvektoren im Stationssystem), imSchatten 0..1, erdscheinStaerke 0..1,
			// solarWinkel (rad), alpha (nur noch 0 = nicht zeichnen; das Modell ist opak),
			// dpr, viewportPx [b, h] (Geraetepixel, fuer die Licht-Sprites), zeitSek
			// (Simulationszeit, Puls der Lichter), lichter (false = keine Sprites) }.
			zeichne: function (pass, issMatrizen, o) {
				o = o || {};
				if (o.alpha !== undefined && !(clamp01(o.alpha) > 0)) return;
				var sys = o.stationssystem && endlich3(o.stationssystem.seite) ? o.stationssystem : IDENTITAET;
				var vp = o.viewportPx || [1, 1];
				u.set(issMatrizen.viewProj, U_VIEWPROJ);
				schreibeModell(U_MODELL, sys);
				schreibeFluegel(U_FLUEGEL, isFinite(o.solarWinkel) ? o.solarWinkel : 0);
				// kamera.w = Projektionsfaktor f = 1 / tan(fov/2) (proj[5]) fuer die Streben-Mindestbreite
				var f = issMatrizen.proj && isFinite(issMatrizen.proj[5]) ? issMatrizen.proj[5] : 2.1445;
				schreibeVec(U_KAMERA, insStationssystem(endlich3(issMatrizen.pos) ? issMatrizen.pos : [0, 0, 1000], sys), f);
				schreibeVec(U_SONNE, endlich3(o.sonneRichtungStation) ? o.sonneRichtungStation : [0, 0, 1], 0);
				schreibeVec(U_ERDE, endlich3(o.erdRichtungStation) ? o.erdRichtungStation : [0, 0, -1], 0);
				u[U_PARAMETER] = clamp01(o.imSchatten);
				u[U_PARAMETER + 1] = clamp01(o.erdscheinStaerke);
				u[U_PARAMETER + 2] = lichtX;
				u[U_PARAMETER + 3] = achseZ;
				u[U_BILD] = Math.max(1, vp[0]); u[U_BILD + 1] = Math.max(1, vp[1]);
				u[U_BILD + 2] = o.dpr || 1;
				var sek = isFinite(o.zeitSek) ? o.zeitSek : 0;
				u[U_BILD + 3] = sek - Math.floor(sek);            // Pulsphase 0..1 (fract auf der CPU, zeitSek ~ 1,8e9)
				device.queue.writeBuffer(uniformPuffer, 0, u);

				pass.setBindGroup(0, bindGroup);
				pass.setVertexBuffer(0, eckenPuffer);
				pass.setIndexBuffer(indexPuffer, "uint32");
				var letzte = null;
				for (var i = 0; i < laeufe.length; i++) {
					var l = laeufe[i];
					if (l.art !== letzte) { pass.setPipeline(pipelines[l.art]); letzte = l.art; }
					pass.drawIndexed(l.anzahl, 1, l.start);
				}
				if (traegerTeil) {                                    // duenne Streben geblendet (Task 12b)
					pass.setPipeline(pStreben);
					pass.drawIndexed(traegerTeil.anzahl, 1, traegerTeil.start);
				}
				if (o.lichter !== false) {                            // Sprites zuletzt (Tiefe der opaken Teile steht)
					pass.setPipeline(pLichter);
					pass.draw(12);
				}
			}
		};
		return z;
	}

	// Reine Helfer fuer die Tests (tests/iss_test.js); draufLaeufe = alter Name von zeichenLaeufe
	window.IssZeichner = { neu: neu, U_BYTES: U_BYTES, STRIDE: STRIDE, zeichenLaeufe: zeichenLaeufe, draufLaeufe: zeichenLaeufe,
	                       traegerAchseZ: traegerAchseZ, fluegelMatrix: fluegelMatrix, istPlatte: istPlatte };
})(window);
