/*
 * ISS Tracker - Spuren in der Welt-Ebene: Bahnspur (ECI), Bodenspur und
 * Sichtkreis (erdfest), Marker an der Station.
 *
 * Einheiten: Erdradien, Welt = ECI (+Z Nordpol). Die Bahnspur liegt in ECI
 * (keine Modellmatrix). Bodenspur und Sichtkreis sind erdfest auf Radius 1,002
 * (Erde 1,0, Wolken 1,004) und werden im Vertex-Shader mit erdfest = rotZ(gmst)
 * nach ECI gedreht - dieselbe Konvention wie die Erde in erde.js.
 *
 * Stuetzstellen (Spurzeichner.punkte, reine Rechnung, in Node testbar): alle
 * 20 s von -1 bis +1 Umlauf um jd, innerhalb von +-90 s um jd jede Sekunde
 * (die 20-s-Sehnen, 153 km, haben 430 m Sagitta - aus der Folgen-Kamera bei
 * 0,8 km ein sichtbarer Polygonzug; 1-s-Sehnen 7,7 km, Sagitta 1 m). Genau eine
 * Stuetzstelle bei jd selbst. t = Zeitabstand / sekundenJeT (laengere Seite
 * des groben Fensters): -1..+1, vergangen negativ. Der Sichtkreis
 * (Spurzeichner.kreis) wird je Bild um den aktuellen Fusspunkt gerechnet.
 *
 * Baender (Task 12a): Jede Spur ist ein triangle-strip mit zwei Ecken je
 * Stuetzstelle. Der Vertex-Shader projiziert die Ecke und ihre beiden
 * Nachbarn, bildet die Bildschirmrichtung (Mittel beider Segmente, keine
 * Gehrung) und schiebt die Ecke senkrecht dazu um die halbe Breite (CSS-Pixel
 * x dpr) plus 1 Geraetepixel Rand; der Fragment-Shader zeichnet die Kante mit
 * smoothstep ueber 1 Geraetepixel aus dem Abstand zur Mittellinie. Runde
 * Gelenke: je Stuetzstelle ein instanziertes Quad (stepMode instance auf
 * demselben Puffer), dessen Fragment-Shader nur den Keil zeichnet, den das
 * Band an einem Knick frei laesst (Abstand zur Mittellinie des jeweiligen
 * Segments > halbe Breite * cos(Knick/2)) - keine Doppeldeckung, keine
 * Luecken, bei beliebigem Bildschirmwinkel.
 *
 * Nahebene: Ecken mit Clip-w <= NAH_W (hinter der Kamera) werden auf die
 * Strecke zum sichtbaren Nachbarn gezogen; sind beide Nachbarn hinten, bleibt
 * die Ecke unversetzt und das Clipping entfernt das Dreieck (kein Durchschlag).
 * Die Tiefe wird im Vertex-Shader auf die Nahebene geklemmt (z <= w), damit
 * die Bahn auch dann durch die Station laeuft, wenn die Folgen-Kamera naeher
 * steht als die Nahebene der Welt-Projektion (0,64 km); dort verdeckt in der
 * Welt-Ebene ohnehin nichts die Linie.
 *
 * Vertex-Layout der Baender (44 Byte, 2 Ecken je Stuetzstelle): Position
 * float32x3, Vorgaenger float32x3, Nachfolger float32x3, t float32, Art float32
 * (0 Bahn, 1 Boden, 2 Kreis); die Seite (-1/+1) kommt aus vertex_index & 1.
 * Ein Puffer je Spur. Dazu je Bild ein 3-Stuetzstellen-Spleiss [p_k, Station,
 * p_k+1], der die Bahnspur genau durch die Station fuehrt.
 *
 * Kamerarelativ (Task 12b): Welt-Koordinaten in float32 haben bei 1 R ein ulp
 * von 0,76 m - stand die Folgen-Kamera wenige Meter auf der Bahnlinie, sprang
 * die Richtung des Spleisses, und Linie und Modell deckten sich unter 0,2 km
 * nur auf ~4 px. Deshalb liegen die Bahn-Ecken relativ zur Kamera im Puffer:
 * punkte() liefert die Stuetzstellen auch in double (bahnD), zeichne() zieht
 * je Bild den Kameraort (double) ab, schreibt float32 und laedt den Bahnpuffer
 * neu hoch (731 Stuetzstellen, 64 KB); Spleiss und Marker ebenso relativ.
 * Bodenspur und Kreis bleiben absolut (erdfest) und werden im Vertex-Shader
 * nach der Drehung um U.kamera verschoben - ihr float32-Fehler (~1 m) ist bei
 * >= 400 km Abstand unsichtbar. Projiziert wird mit viewProjRel (Kamera im
 * Ursprung, kamera.js); fehlt es, bleibt alles absolut wie vor 12b.
 *
 * Pipelines (depth32float, Vergleich greater, Tiefe nur lesen, MSAA 4x,
 * Alpha-Blend, ein gemeinsames Bindgruppen-Layout):
 *   band    triangle-strip; Breite und Farbe im Shader nach Art und t:
 *           Bahn vergangen 2,0 / kommend 1,5 CSS-px, Bodenspur 1,5 mit je 1 px
 *           dunklem Saum, Kreis 1,25
 *   gelenk  Quad je Stuetzstelle (Instanz = Eckenpaar), gleiche Breite/Farbe/Striche
 *   marker  Quad aus 6 Ecken (vertex_index) an der Station, 14 px * DPR,
 *           hinter der Erde durch den Tiefenpuffer verdeckt
 *
 * Uniform "Spur" (192 Byte): viewProj 0 (kamerarelativ), erdfest 64 (rotZ gmst),
 * iss 128 (xyz Position relativ zur Kamera in R, w markerAlpha), bild 144
 * (Viewport in Geraetepixeln, dpr, 0), spur 160 (tJetzt, strichPhase,
 * nachbarAlpha, 0), kamera 176 (xyz Kameraort in R fuer Boden/Kreis).
 * tJetzt = seit der letzten Berechnung vergangene Zeit in t-Einheiten: die
 * Grenze vergangen/kommend folgt der Station zwischen zwei Neuberechnungen.
 * strichPhase haelt das Strichmuster an der absoluten Zeit fest, damit die
 * Striche bei einer Neuberechnung nicht springen. nachbarAlpha (Task 12b):
 * Faktor auf das Alpha der Nachbarrunden (|t - tJetzt| > NACHBAR_AB_T), im
 * Folgen-Modus und naeher als 2000 km an der Station 0,3 (tracker.js, Task
 * 12c) - beim Blick entlang der Bahn lagen sie fast auf derselben Bildlinie
 * wie die eigene Runde.
 *
 * Nichts hier fasst auf oberster Ebene navigator, document oder GPU* an.
 */
(function (window) {
	"use strict";

	var R_KM = 6378.137;
	var BODEN_R = 1.002;                             // Bodenspur, Sichtkreis (ueber der Erde, unter den Wolken)
	var SCHRITT_S = 20, UMLAEUFE_VOR = 1, UMLAEUFE_NACH = 1;
	// Feine Stuetzstellen um die Station (Nachtrag 12a): FEIN_SCHRITT_S innerhalb
	// von +-FEIN_FENSTER_S um jd. tracker.js rechnet neu, bevor die Station das
	// Fenster verlaesst (Zeitraffer).
	var FEIN_SCHRITT_S = 1, FEIN_FENSTER_S = 90;
	var KREIS_PUNKTE = 128;
	var STRIDE = 44;                                 // Byte je Band-Ecke
	var FLOATS = STRIDE / 4;
	var MARKER_PX = 14;                              // Durchmesser in CSS-Pixeln
	var STRICHE_JE_T = 60;
	// Task 12a (A2): Bandbreiten in CSS-Pixeln (der Shader nimmt x dpr). Der
	// line-strip war 1 Geraetepixel, bei DPR 2 also 0,5 CSS-px: Bodenspur und
	// Kreis Haarlinien, auf der Nachtseite unsichtbar (t8-zoom-dpr2.png).
	var BAHN_VERGANGEN_PX = 2.0, BAHN_KOMMEND_PX = 1.5, BODEN_PX = 1.5, BODEN_SAUM_PX = 1.0, KREIS_PX = 1.25;
	var BODEN_FARBE = "#8FA3A2", BODEN_ALPHA = 0.85; // Kern der Bodenspur
	var SAUM_FARBE = "#0B0E14", SAUM_ALPHA = 0.35;   // je Seite BODEN_SAUM_PX dunkler Saum (lesbar auf der Tagseite)
	var KREIS_ALPHA = 0.5;
	// Kommende Bahn bis hier ohne Strichmuster: 0,01 t-Einheiten = 0,01 * 5580 s
	// = 56 s = ~430 km vor der Station (sekundenJeT = laengere Seite des groben
	// Fensters = 1 Umlauf = 279 * 20 s, siehe punkte()). Mit 60 Strichen je
	// t-Einheit (Strich + Luecke 93 s = ~710 km) verschwand die Bahn vor der
	// Station in der Folgen-Kamera bis 46 s lang (t8-folgen-45s.png).
	var NAH_DURCHGEZOGEN_T = 0.01;
	// Clip-w (R), unter dem eine Ecke als "hinter der Kamera" gilt. Muss deutlich
	// unter jeder Folgen-Distanz (ab 50 m) liegen, sonst wird die Station selbst
	// "an die Nahebene gezogen" (Knick, Nachtrag 12a). Task 12b: mit den
	// kamerarelativen Ecken (mm-genau) reicht 1e-9 R = 6 mm absolut - so laeuft
	// die vergangene Bahn, wenn die Kamera auf der Linie steht, bis an den
	// Bildrand statt 6 m vor der Kamera zu enden (Stummel). Dazu ein relativer
	// Anteil NAH_W_REL vom groessten |w| der drei Ecken: die Verschiebung auf die
	// Nahebene interpoliert in float32 (Fehler ~6e-8 des Betrags), bei fernen
	// Segmenten der Erde-Ansicht (w bis 2 R) darf das Ergebnis nicht unter 0 fallen.
	var NAH_W = 1e-9, NAH_W_REL = 2e-6;
	// Nachbarrunden (Task 12b): ab NACHBAR_AB_T Umlaeufen Abstand zur Station
	// (weich ueber NACHBAR_BREITE_T) gilt der Faktor nachbarAlpha aus der
	// Uniform (tracker.js: NACHBAR_ALPHA im Folgen-Modus oder naeher als
	// NACHBAR_AB_KM, sonst 1).
	var NACHBAR_AB_T = 0.5, NACHBAR_BREITE_T = 0.05;
	// Float-Indizes in der Uniform (Byte / 4)
	var U_VIEWPROJ = 0, U_ERDFEST = 16, U_ISS = 32, U_BILD = 36, U_SPUR = 40, U_KAMERA = 44;
	var U_BYTES = 192;

	// ---------------------------------------------------------- Farben
	// Vorgaben als sRGB-Hex. Die Shader rechnen linear und geben ueber ausgabe()
	// (ACES + sRGB) aus; die Konstanten sind deshalb die lineare Farbe VOR dem
	// Tonemapping, die ausgabe() genau auf den Hexwert abbildet (Umkehr der
	// ACES-Naeherung). So erscheinen Akzent und Grau bei Alpha 1 wie vorgegeben.
	function acesUmkehr(y) {
		y = Math.max(0, Math.min(y, 0.999));
		var a = 2.51 - 2.43 * y, b = 0.03 - 0.59 * y, c = -0.14 * y;   // a x^2 + b x + c = 0
		return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
	}
	function vorAces(hex) {
		var n = parseInt(hex.slice(1), 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (byte) {
			var s = byte / 255;
			return acesUmkehr(s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
		});
	}
	function vec3(v) { return "vec3<f32>(" + v.map(function (x) { return x.toFixed(6); }).join(", ") + ")"; }
	function f(x) { return x.toFixed(4); }

	// ACES + sRGB (Task 12c): einzige Quelle ist Himmelszeichner.WGSL_AUSGABE
	// (himmel.js, in index.html vor spur.js geladen; bringt auch linear() mit,
	// hier ungenutzt). Erst in neu() gelesen und vorangestellt, damit spur.js
	// auch ohne himmel.js ladbar bleibt (sgp4_test.js rechnet Spurzeichner.punkte).
	function wgslAusgabe() {
		var H = window.Himmelszeichner;
		if (!H || typeof H.WGSL_AUSGABE !== "string") throw new Error("himmel.js missing (Himmelszeichner.WGSL_AUSGABE)");
		return H.WGSL_AUSGABE;
	}

	var WGSL = `
struct Spur {
	viewProj: mat4x4<f32>, erdfest: mat4x4<f32>,
	iss: vec4<f32>, bild: vec4<f32>, spur: vec4<f32>, kamera: vec4<f32>
};
@group(0) @binding(0) var<uniform> U: Spur;

const AKZENT = ${vec3(vorAces("#81E458"))};       // #81E458 nach ausgabe()
const GRAU = ${vec3(vorAces("#5F7170"))};         // #5F7170 nach ausgabe()
const BODEN = ${vec3(vorAces(BODEN_FARBE))};      // ${BODEN_FARBE} nach ausgabe()
const SAUM = ${vec3(vorAces(SAUM_FARBE))};        // ${SAUM_FARBE} nach ausgabe()
const KERN = vec3<f32>(2.5, 2.5, 2.3);            // heller Kern des Markers (fast weiss)
const MARKER_PX = ${MARKER_PX.toFixed(1)};
const STRICHE_JE_T = ${STRICHE_JE_T.toFixed(1)};
const BAHN_VERGANGEN_PX = ${f(BAHN_VERGANGEN_PX)};
const BAHN_KOMMEND_PX = ${f(BAHN_KOMMEND_PX)};
const BODEN_PX = ${f(BODEN_PX)};
const BODEN_SAUM_PX = ${f(BODEN_SAUM_PX)};
const KREIS_PX = ${f(KREIS_PX)};
const BODEN_ALPHA = ${f(BODEN_ALPHA)};
const SAUM_ALPHA = ${f(SAUM_ALPHA)};
const KREIS_ALPHA = ${f(KREIS_ALPHA)};
const NAH_DURCHGEZOGEN_T = ${f(NAH_DURCHGEZOGEN_T)};
const NAH_W = ${NAH_W};
const NAH_W_REL = ${NAH_W_REL};
const NACHBAR_AB_T = ${f(NACHBAR_AB_T)};
const NACHBAR_BREITE_T = ${f(NACHBAR_BREITE_T)};

// ---------------------------------------------------------- gemeinsam: Projektion, Richtung, Stil
// Bahn-Ecken liegen schon relativ zur Kamera im Puffer (CPU, double); Boden und
// Kreis sind erdfest absolut: nach ECI drehen, dann um die Kamera verschieben.
fn projiziere(p: vec3<f32>, art: f32) -> vec4<f32> {
	var w = p;
	if (art > 0.5) { w = (U.erdfest * vec4(p, 1.0)).xyz - U.kamera.xyz; }
	return U.viewProj * vec4(w, 1.0);
}
// Punkt der Strecke a -> b (Clip-Raum) mit w = nah (a dahinter, b davor)
fn zurNahebene(a: vec4<f32>, b: vec4<f32>, nah: f32) -> vec4<f32> {
	return mix(a, b, (nah - a.w) / (b.w - a.w));
}
// Tiefe auf die Nahebene klemmen (Reversed-Z: z <= w), siehe Kopf
fn nahClip(pos: vec4<f32>) -> vec4<f32> { return vec4(pos.xy, min(pos.z, pos.w), pos.w); }
// Volle Bandbreite in Geraetepixeln nach Art (Bahn: vergangen breiter als die
// gestrichelte kommende)
fn breiteFuer(art: f32, t: f32) -> f32 {
	var breite = BAHN_VERGANGEN_PX;
	if (art > 1.5) { breite = KREIS_PX; }
	else if (art > 0.5) { breite = BODEN_PX + 2.0 * BODEN_SAUM_PX; }
	else if (t - U.spur.x > 0.0) { breite = BAHN_KOMMEND_PX; }
	return breite * U.bild.z;
}
// Ecke und Nachbarn im Clip-Raum, Nahebene behandelt; ok = false: ganz hinten
struct Proj { c: vec4<f32>, cV: vec4<f32>, cN: vec4<f32>, ok: bool };
fn projiziereDrei(p: vec3<f32>, vor: vec3<f32>, nach: vec3<f32>, art: f32) -> Proj {
	var c = projiziere(p, art);
	var cV = projiziere(vor, art);
	var cN = projiziere(nach, art);
	let nah = max(NAH_W, NAH_W_REL * max(abs(c.w), max(abs(cV.w), abs(cN.w))));
	var ok = true;
	if (c.w <= nah) {
		if (cN.w > nah) { c = zurNahebene(c, cN, nah); }
		else if (cV.w > nah) { c = zurNahebene(c, cV, nah); }
		else { ok = false; }
	}
	if (ok) {
		if (cN.w <= nah) { cN = zurNahebene(cN, c, nah); }
		if (cV.w <= nah) { cV = zurNahebene(cV, c, nah); }
	}
	return Proj(c, cV, cN, ok);
}
// Einheitsrichtungen im Bild (Pixel): eV vom Vorgaenger zur Ecke, eN von der
// Ecke zum Nachfolger; fehlt ein Nachbar (Strip-Ende), gilt der andere.
struct Richtung { eV: vec2<f32>, eN: vec2<f32> };
fn richtungen(pr: Proj) -> Richtung {
	let vp = U.bild.xy;
	let sc = pr.c.xy / pr.c.w * vp;
	let dN = pr.cN.xy / pr.cN.w * vp - sc;
	let dV = sc - pr.cV.xy / pr.cV.w * vp;
	let lN = length(dN);
	let lV = length(dV);
	var eN = vec2(0.0);
	var eV = vec2(0.0);
	if (lN > 1e-4) { eN = dN / lN; }
	if (lV > 1e-4) { eV = dV / lV; }
	if (lN <= 1e-4) { eN = eV; }
	if (lV <= 1e-4) { eV = eN; }
	return Richtung(eV, eN);
}
// Mittlere Richtung an der Ecke (bei 180-Grad-Knick die des Nachfolgers)
fn mittelRichtung(r: Richtung) -> vec2<f32> {
	var d = r.eV + r.eN;
	if (length(d) < 1e-4) { d = r.eN; }
	if (length(d) < 1e-4) { d = vec2(1.0, 0.0); }
	return normalize(d);
}
// Farbe und Alpha fuer den Abstand a (Geraetepixel) zur Mittellinie bzw. zum
// Gelenk bei halber Bandbreite halb; alpha < 0 = verwerfen
struct Stil { farbe: vec3<f32>, alpha: f32 };
fn stil(art: f32, t: f32, a: f32, halb: f32) -> Stil {
	let kante = 1.0 - smoothstep(halb - 0.5, halb + 0.5, a);       // Kante 1 Geraetepixel weich
	if (kante <= 0.0) { return Stil(vec3(0.0), -1.0); }
	if (art > 1.5) { return Stil(AKZENT, KREIS_ALPHA * kante); }   // Sichtkreis
	if (art > 0.5) {
		// Bodenspur: Kern innen, dunkler Saum ueber den Randbereich des Bandes
		let kernHalb = BODEN_PX * 0.5 * U.bild.z;
		let kern = 1.0 - smoothstep(kernHalb - 0.5, kernHalb + 0.5, a);
		return Stil(mix(SAUM, BODEN, kern), mix(SAUM_ALPHA, BODEN_ALPHA, kern) * kante);
	}
	// Bahn: s < 0 vergangen (Grau -> Akzent zur Station hin, Alpha 0,15..0,9),
	// s > 0 kommend (Akzent gestrichelt, zum Ende hin ausgeblendet; die ersten
	// NAH_DURCHGEZOGEN_T vor der Station durchgezogen). Nachbarrunden (|s| ueber
	// NACHBAR_AB_T) mit dem Faktor U.spur.z (Task 12b).
	let s = t - U.spur.x;
	let nachbar = mix(1.0, U.spur.z, smoothstep(NACHBAR_AB_T - NACHBAR_BREITE_T, NACHBAR_AB_T + NACHBAR_BREITE_T, abs(s)));
	if (s <= 0.0) {
		let k = clamp(s + 1.0, 0.0, 1.0);
		return Stil(mix(GRAU, AKZENT, k), mix(0.15, 0.9, k) * kante * nachbar);
	}
	if (s > NAH_DURCHGEZOGEN_T && fract(t * STRICHE_JE_T + U.spur.y) > 0.5) { return Stil(vec3(0.0), -1.0); }
	return Stil(AKZENT, mix(0.9, 0.15, clamp(s, 0.0, 1.0)) * kante * nachbar);
}

// ---------------------------------------------------------- Baender
struct BOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) t: f32,
	@location(1) @interpolate(flat) art: f32,
	@location(2) @interpolate(linear) abstand: f32,   // Abstand zur Mittellinie, Geraetepixel (bildschirmlinear)
	@location(3) @interpolate(flat) breite: f32       // volle Bandbreite, Geraetepixel
};
@vertex fn vsBand(@builtin(vertex_index) vi: u32, @location(0) p: vec3<f32>, @location(1) vor: vec3<f32>,
                  @location(2) nach: vec3<f32>, @location(3) t: f32, @location(4) art: f32) -> BOut {
	let seite = f32(vi & 1u) * 2.0 - 1.0;
	let breite = breiteFuer(art, t);
	let halb = breite * 0.5 + 1.0;                    // + 1 Geraetepixel Rand fuer die weiche Kante
	var o: BOut;
	o.t = t; o.art = art; o.breite = breite; o.abstand = seite * halb;
	let pr = projiziereDrei(p, vor, nach, art);
	if (!pr.ok) { o.pos = pr.c; return o; }           // ganz hinten: Clipping entfernt das Dreieck
	let d = mittelRichtung(richtungen(pr));
	let n = vec2(-d.y, d.x) * (seite * halb);        // Versatz in Pixeln
	o.pos = nahClip(vec4(pr.c.xy + n * 2.0 / U.bild.xy * pr.c.w, pr.c.z, pr.c.w));
	return o;
}
@fragment fn fsBand(i: BOut) -> @location(0) vec4<f32> {
	let st = stil(i.art, i.t, abs(i.abstand), i.breite * 0.5);
	if (st.alpha < 0.0) { discard; }
	return vec4(ausgabe(st.farbe), st.alpha);
}

// ---------------------------------------------------------- Gelenke
// Quad (6 Ecken) je Stuetzstelle, Radius halbe Breite + 1 px. Der Fragment-
// Shader zeichnet nur, was das Band an einem Knick frei laesst: Punkte, deren
// Abstand zur Mittellinie des zugehoerigen Segments (Vorgaengerseite der
// Winkelhalbierenden: eV, sonst eN) groesser ist als (halb + 0,5) * cos(Knick/2)
// - genau bis dorthin reicht das Band mit seiner Mittelrichtung an der Ecke.
// Bei geradem Verlauf zeichnet das Gelenk nichts (keine Doppeldeckung).
struct GOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,                       // Versatz zur Stuetzstelle, Geraetepixel
	@location(1) @interpolate(flat) art: f32,
	@location(2) @interpolate(flat) t: f32,
	@location(3) @interpolate(flat) breite: f32,
	@location(4) @interpolate(flat) eV: vec2<f32>,
	@location(5) @interpolate(flat) eN: vec2<f32>
};
@vertex fn vsGelenk(@builtin(vertex_index) vi: u32, @location(0) p: vec3<f32>, @location(1) vor: vec3<f32>,
                    @location(2) nach: vec3<f32>, @location(3) t: f32, @location(4) art: f32) -> GOut {
	var ecken = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(1.,1.), vec2(-1.,-1.), vec2(1.,1.), vec2(-1.,1.));
	let breite = breiteFuer(art, t);
	let halb = breite * 0.5 + 1.0;
	var o: GOut;
	o.uv = ecken[vi] * halb; o.art = art; o.t = t; o.breite = breite;
	o.eV = vec2(1.0, 0.0); o.eN = vec2(1.0, 0.0);
	let pr = projiziereDrei(p, vor, nach, art);
	if (!pr.ok) { o.pos = pr.c; return o; }
	let r = richtungen(pr);
	o.eV = r.eV; o.eN = r.eN;
	o.pos = nahClip(vec4(pr.c.xy + o.uv * 2.0 / U.bild.xy * pr.c.w, pr.c.z, pr.c.w));
	return o;
}
@fragment fn fsGelenk(i: GOut) -> @location(0) vec4<f32> {
	let halb = i.breite * 0.5;
	let d = mittelRichtung(Richtung(i.eV, i.eN));
	let cosHalb = max(dot(d, i.eN), 0.0);             // cos(Knick/2)
	let vorSeite = dot(i.uv, d) <= 0.0;
	let e = select(i.eN, i.eV, vorSeite);
	let quer = abs(i.uv.x * e.y - i.uv.y * e.x);      // Abstand zur Mittellinie des Segments
	if (quer <= (halb + 0.5) * cosHalb) { discard; }  // vom Band gedeckt
	let st = stil(i.art, i.t, length(i.uv), halb);
	if (st.alpha < 0.0) { discard; }
	return vec4(ausgabe(st.farbe), st.alpha);
}

// ---------------------------------------------------------- Marker
struct MOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vsMarker(@builtin(vertex_index) vi: u32) -> MOut {
	var ecken = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(1.,1.), vec2(-1.,-1.), vec2(1.,1.), vec2(-1.,1.));
	let e = ecken[vi];
	let clip = U.viewProj * vec4(U.iss.xyz, 1.0);                          // Station relativ zur Kamera
	let px = MARKER_PX * U.bild.z;                                        // Durchmesser in Geraetepixeln
	var o: MOut;
	o.pos = vec4(clip.xy + e * px / U.bild.xy * clip.w, clip.z, clip.w);  // Tiefe der Station
	o.uv = e;
	return o;
}
@fragment fn fsMarker(i: MOut) -> @location(0) vec4<f32> {
	let r = length(i.uv);
	let px = MARKER_PX * U.bild.z;
	let deckung = 1.0 - smoothstep(1.0 - 2.0 / px, 1.0, r);               // Kante ~1 Geraetepixel weich
	if (deckung <= 0.0) { discard; }
	let kern = 1.0 - smoothstep(0.3, 0.55, r);
	return vec4(ausgabe(mix(AKZENT, KERN, kern)), deckung * U.iss.w);
}
`;

	// ---------------------------------------------------------- Rechnung (ohne GPU)
	// Zeitabstaende (s) der Stuetzstellen zu jd: grob alle schrittSek von
	// -nVor..+nNach, dazu fein alle fein.schrittSek innerhalb +-fein.fensterSek
	// (die groben Punkte im Fenster entfallen). Aufsteigend, 0 enthalten.
	function zeitliste(schrittSek, nVor, nNach, fein) {
		var fenster = fein && fein.fensterSek > 0 && fein.schrittSek > 0 && fein.schrittSek < schrittSek ? fein : null;
		var sek = [];
		for (var i = -nVor; i <= nNach; i++) {
			var x = i * schrittSek;
			if (fenster && Math.abs(x) <= fenster.fensterSek) continue;
			sek.push(x);
		}
		if (fenster) {
			var von = Math.max(-fenster.fensterSek, -nVor * schrittSek), bis = Math.min(fenster.fensterSek, nNach * schrittSek);
			for (var k = Math.ceil(von / fenster.schrittSek); k * fenster.schrittSek <= bis + 1e-9; k++) sek.push(k * fenster.schrittSek);
		} else if (sek.indexOf(0) < 0) sek.push(0);
		sek.sort(function (a, b) { return a - b; });
		return sek;
	}

	// Stuetzstellen um jd: grob alle schrittSek von -umlaeufeVor bis +umlaeufeNach
	// Umlaeufe, fein alle fein.schrittSek innerhalb +-fein.fensterSek (Vorgabe
	// FEIN_SCHRITT_S / FEIN_FENSTER_S; fein = {schrittSek: 0} schaltet ab).
	// Liefert { n, iJetzt, jd, schrittSek, sekundenJeT, sek, bahn, bahnD, boden, t,
	// hoehenKm }: sek Float64Array(n) Zeitabstand zu jd in Sekunden (aufsteigend);
	// bahn Float32Array(3n) ECI in Erdradien, bahnD dieselben Werte als
	// Float64Array (Task 12b, fuer die kamerarelative Rechnung je Bild); boden
	// Float32Array(3n) erdfest, normiert * 1,002 (temeNachEcef mit gmst des
	// jeweiligen Zeitpunkts); t Float32Array(n) = sek / sekundenJeT (-1..+1,
	// sekundenJeT = laengere Seite des groben Fensters); hoehenKm Float64Array(n)
	// geodaetisch.
	// Stuetzstellen mit fehler != 0 (auch 6, verfallen) fallen weg; iJetzt ist
	// der Index der Stuetzstelle bei jd (-1, wenn sie fehlt). Punktzahl bei 1/1
	// (ISS): grob round(U/20) * 2 + 1 = 559, davon 9 im Fenster ersetzt durch
	// 181 feine = 731.
	function punkte(satrec, jd, schrittSek, umlaeufeVor, umlaeufeNach, fein) {
		var S = window.SGP4, Z = window.Zeit;
		var umlaufS = S.umlaufzeitMin(satrec) * 60;
		var nVor = Math.max(0, Math.round(umlaeufeVor * umlaufS / schrittSek));
		var nNach = Math.max(0, Math.round(umlaeufeNach * umlaufS / schrittSek));
		var sekundenJeT = Math.max(nVor, nNach, 1) * schrittSek;
		var liste = zeitliste(schrittSek, nVor, nNach, fein === undefined ? { schrittSek: FEIN_SCHRITT_S, fensterSek: FEIN_FENSTER_S } : fein);
		var gesamt = liste.length;
		var bahn = new Float32Array(3 * gesamt), bahnD = new Float64Array(3 * gesamt), boden = new Float32Array(3 * gesamt);
		var t = new Float32Array(gesamt), hoehenKm = new Float64Array(gesamt), sek = new Float64Array(gesamt);
		var n = 0, iJetzt = -1;
		for (var i = 0; i < gesamt; i++) {
			var x = liste[i];
			var jdI = jd + x / 86400;
			var e = S.propagiere(satrec, jdI);
			if (e.fehler !== 0) continue;                     // leere Vektoren (ausser 6) oder verfallen
			var r = e.r;
			var f = S.temeNachEcef(r, Z.gmst(jdI));
			var fl = Math.hypot(f[0], f[1], f[2]);
			if (!(fl > 0)) continue;
			bahnD[3 * n] = r[0] / R_KM; bahnD[3 * n + 1] = r[1] / R_KM; bahnD[3 * n + 2] = r[2] / R_KM;
			bahn[3 * n] = bahnD[3 * n]; bahn[3 * n + 1] = bahnD[3 * n + 1]; bahn[3 * n + 2] = bahnD[3 * n + 2];
			boden[3 * n] = f[0] / fl * BODEN_R; boden[3 * n + 1] = f[1] / fl * BODEN_R; boden[3 * n + 2] = f[2] / fl * BODEN_R;
			sek[n] = x;
			t[n] = x / sekundenJeT;
			hoehenKm[n] = S.geodaetisch(f).hoehe;
			if (x === 0) iJetzt = n;
			n++;
		}
		if (n < gesamt) {
			bahn = bahn.slice(0, 3 * n); bahnD = bahnD.slice(0, 3 * n); boden = boden.slice(0, 3 * n);
			t = t.slice(0, n); hoehenKm = hoehenKm.slice(0, n); sek = sek.slice(0, n);
		}
		return { n: n, iJetzt: iJetzt, jd: jd, schrittSek: schrittSek, sekundenJeT: sekundenJeT, sek: sek,
		         bahn: bahn, bahnD: bahnD, boden: boden, t: t, hoehenKm: hoehenKm };
	}

	// Sichtkreis um den Fusspunkt (fuss = erdfeste Richtung, Laenge egal) fuer
	// die Hoehe hoeheKm: Winkelradius acos(R/(R+h)), punkteZahl Ecken plus die
	// erste am Ende (geschlossener Strip), auf Radius 1,002, erdfest.
	// Liefert Float32Array(3 * (punkteZahl + 1)); ziel (optional, Task 12c):
	// wiederverwendbares Array mindestens dieser Laenge (je Bild keine Allokation).
	function kreis(fuss, hoeheKm, punkteZahl, ziel) {
		var m = punkteZahl || KREIS_PUNKTE;
		var l = Math.hypot(fuss[0], fuss[1], fuss[2]) || 1;
		var u = [fuss[0] / l, fuss[1] / l, fuss[2] / l];
		var winkel = Math.acos(R_KM / (R_KM + Math.max(0, hoeheKm)));
		// Basis in der Tangentialebene: e1 = Osten (z x u), am Pol ersatzweise x
		var e1 = [-u[1], u[0], 0], l1 = Math.hypot(e1[0], e1[1]);
		if (l1 < 1e-9) { e1 = [1, 0, 0]; l1 = 1; }
		e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
		var e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
		var c = Math.cos(winkel) * BODEN_R, s = Math.sin(winkel) * BODEN_R;
		var p = ziel && ziel.length >= 3 * (m + 1) ? ziel : new Float32Array(3 * (m + 1));
		for (var k = 0; k < m; k++) {
			var phi = 2 * Math.PI * k / m, cp = Math.cos(phi), sp = Math.sin(phi);
			for (var a = 0; a < 3; a++) p[3 * k + a] = c * u[a] + s * (cp * e1[a] + sp * e2[a]);
		}
		p[3 * m] = p[0]; p[3 * m + 1] = p[1]; p[3 * m + 2] = p[2];
		return p;
	}

	// Eine Band-Stuetzstelle (zwei Ecken) schreiben: Position p (Index ip in
	// pos), Vorgaenger iv, Nachfolger inx, t, Art.
	function setzeBandEcke(d, i, pos, ip, iv, inx, t, art) {
		for (var s = 0; s < 2; s++) {
			var e = FLOATS * (2 * i + s);
			d[e] = pos[3 * ip]; d[e + 1] = pos[3 * ip + 1]; d[e + 2] = pos[3 * ip + 2];
			d[e + 3] = pos[3 * iv]; d[e + 4] = pos[3 * iv + 1]; d[e + 5] = pos[3 * iv + 2];
			d[e + 6] = pos[3 * inx]; d[e + 7] = pos[3 * inx + 1]; d[e + 8] = pos[3 * inx + 2];
			d[e + 9] = t;
			d[e + 10] = art;
		}
	}
	// Positionen (3 je Stuetzstelle) mit t und Art zu Band-Ecken (2 x FLOATS je
	// Stuetzstelle). geschlossen: erster = letzter Punkt (Kreis), Nachbarn ueber
	// die Naht hinweg. ziel: wiederverwendbares Array (mindestens 2 n FLOATS).
	function bandEcken(pos, t, n, art, geschlossen, ziel) {
		var d = ziel && ziel.length >= 2 * n * FLOATS ? ziel : new Float32Array(2 * n * FLOATS);
		var ueberNaht = geschlossen && n > 2;
		for (var i = 0; i < n; i++) {
			var iv = i > 0 ? i - 1 : (ueberNaht ? n - 2 : 0);
			var inx = i < n - 1 ? i + 1 : (ueberNaht ? 1 : n - 1);
			setzeBandEcke(d, i, pos, i, iv, inx, t ? t[i] : 0, art);
		}
		return d;
	}

	function endlich3(p) { return !!(p && p.length >= 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2])); }

	// ---------------------------------------------------------- Zeichner
	function neu(gpu, format) {
		var device = gpu.device;
		var G = window.GPU;
		format = format || gpu.format;

		var modul = G.shader(device, wgslAusgabe() + WGSL, "spur");
		var bindLayout = device.createBindGroupLayout({
			label: "spur",
			entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }]
		});
		var pipelineLayout = device.createPipelineLayout({ label: "spur", bindGroupLayouts: [bindLayout] });
		var BLEND_ALPHA = {
			color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
			alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
		};
		var TIEFE_LESEN = { format: "depth32float", depthWriteEnabled: false, depthCompare: "greater" };
		var ATTRIBUTE = [
			{ shaderLocation: 0, offset: 0,  format: "float32x3" },   // Position
			{ shaderLocation: 1, offset: 12, format: "float32x3" },   // Vorgaenger
			{ shaderLocation: 2, offset: 24, format: "float32x3" },   // Nachfolger
			{ shaderLocation: 3, offset: 36, format: "float32" },     // t
			{ shaderLocation: 4, offset: 40, format: "float32" }      // Art
		];
		var pBand = device.createRenderPipeline({
			label: "spur band",
			layout: pipelineLayout,
			vertex: { module: modul, entryPoint: "vsBand", buffers: [{ arrayStride: STRIDE, attributes: ATTRIBUTE }] },
			fragment: { module: modul, entryPoint: "fsBand", targets: [{ format: format, blend: BLEND_ALPHA }] },
			primitive: { topology: "triangle-strip", cullMode: "none" },
			depthStencil: TIEFE_LESEN,
			multisample: { count: 4 }
		});
		// Gelenke: eine Instanz je Stuetzstelle = ein Eckenpaar des Bandpuffers
		var pGelenk = device.createRenderPipeline({
			label: "spur gelenk",
			layout: pipelineLayout,
			vertex: { module: modul, entryPoint: "vsGelenk", buffers: [{ arrayStride: 2 * STRIDE, stepMode: "instance", attributes: ATTRIBUTE }] },
			fragment: { module: modul, entryPoint: "fsGelenk", targets: [{ format: format, blend: BLEND_ALPHA }] },
			primitive: { topology: "triangle-list", cullMode: "none" },
			depthStencil: TIEFE_LESEN,
			multisample: { count: 4 }
		});
		var pMarker = device.createRenderPipeline({
			label: "spur marker",
			layout: pipelineLayout,
			vertex: { module: modul, entryPoint: "vsMarker", buffers: [] },
			fragment: { module: modul, entryPoint: "fsMarker", targets: [{ format: format, blend: BLEND_ALPHA }] },
			primitive: { topology: "triangle-list", cullMode: "none" },
			depthStencil: TIEFE_LESEN,
			multisample: { count: 4 }
		});

		var uniformPuffer = G.uniform(device, U_BYTES);
		var u = new Float32Array(U_BYTES / 4);
		var bindGroup = device.createBindGroup({
			label: "spur",
			layout: bindLayout,
			entries: [{ binding: 0, resource: { buffer: uniformPuffer } }]
		});

		// Bandpuffer je Spur: n Stuetzstellen = 2 n Ecken; daten != null heisst
		// "neu hochladen"; der Puffer waechst, wenn eine Spur mehr Ecken braucht.
		function spur(label) { return { label: label, puffer: null, ecken: 0, n: 0, daten: null }; }
		var bahn = spur("spur bahn"), boden = spur("spur boden"), kreisSpur = spur("spur kreis");
		function hochladen(sp) {
			if (!sp.daten) return;
			var ecken = 2 * sp.n;
			if (!sp.puffer || sp.ecken < ecken) {
				if (sp.puffer) sp.puffer.destroy();
				sp.ecken = Math.max(ecken, 2);
				sp.puffer = device.createBuffer({ label: sp.label, size: sp.ecken * STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
			}
			if (ecken > 0) device.queue.writeBuffer(sp.puffer, 0, sp.daten, 0, ecken * FLOATS);
			sp.daten = null;
		}
		// Band (Strip ab Stuetzstelle 'ab', 'anzahl' Stuetzstellen) und die
		// Gelenke der Stuetzstellen [gelenkAb, gelenkAb + gelenkAnzahl)
		function zeichneSpur(pass, puffer, ab, anzahl, gelenkAb, gelenkAnzahl) {
			pass.setVertexBuffer(0, puffer);
			if (anzahl >= 2) { pass.setPipeline(pBand); pass.draw(2 * anzahl, 1, 2 * ab, 0); }
			if (gelenkAnzahl >= 1) { pass.setPipeline(pGelenk); pass.draw(6, gelenkAnzahl, 0, gelenkAb); }
		}

		var spurJd = null, sekundenJeT = 1, strichPhase = 0;
		var bahnD = null, bahnT = null;                     // CPU-Kopie der letzten Bahnspur (double) und ihre t
		var bahnRel = null, bahnEckenDaten = null;          // je Bild: Stuetzstellen relativ zur Kamera (float32) und Band-Ecken
		var posRel = new Float64Array(3);                   // Station relativ zur Kamera
		var kreisFuss = null;                               // erdfester Fusspunkt (km) der letzten Kreisrechnung
		var kreisDaten = new Float32Array(2 * (KREIS_PUNKTE + 1) * FLOATS);   // wiederverwendet (je Bild bei Bewegung)
		var kreisPunkte = new Float32Array(3 * (KREIS_PUNKTE + 1));           // Task 12c: ebenso die Ecken aus kreis()
		var kreisKm = [0, 0, 0];                                              // Station in km (ECI) fuer temeNachEcef

		// Spleiss: Auch die 1-s-Sehnen (7,7 km) weichen 1 m vom Bogen ab, und
		// zwischen zwei Neuberechnungen wandert die Station weiter. Je Bild
		// ersetzt deshalb ein 3-Stuetzstellen-Stueck [p_k, Station, p_k+1] das
		// Segment k..k+1, in dem die Station gerade steht; die Station bekommt
		// t = tJetzt, die Grenze vergangen/kommend liegt damit genau auf ihr.
		// Nachbarn fuer die Richtung: p_k-1 und p_k+2. Die Gelenke von p_k und
		// p_k+1 zeichnet nur der Spleiss (die Strips lassen sie aus). Alle
		// Positionen relativ zur Kamera (bahnRel, posRel).
		var spleissPuffer = device.createBuffer({ label: "spur spleiss", size: 6 * STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		var spleissDaten = new Float32Array(6 * FLOATS);
		var spleissPos = new Float32Array(3 * 5);           // [p_k-1, p_k, Station, p_k+1, p_k+2]
		// Index k mit t_k <= tJetzt < t_k+1 oder -1 (Station ausserhalb des Fensters)
		function spleissIndex(tJetzt, n) {
			if (!bahnT || n < 2 || !(tJetzt >= bahnT[0] && tJetzt < bahnT[n - 1])) return -1;
			var lo = 0, hi = n - 1;
			while (hi - lo > 1) { var mitte = (lo + hi) >> 1; if (bahnT[mitte] <= tJetzt) lo = mitte; else hi = mitte; }
			return lo;
		}
		function schreibeSpleiss(k, n, pos, tJetzt) {
			var q = spleissPos, kv = Math.max(k - 1, 0), kn = Math.min(k + 2, n - 1);
			q.set(bahnRel.subarray(3 * kv, 3 * kv + 3), 0);
			q.set(bahnRel.subarray(3 * k, 3 * k + 3), 3);
			q[6] = pos[0]; q[7] = pos[1]; q[8] = pos[2];
			q.set(bahnRel.subarray(3 * k + 3, 3 * k + 6), 9);
			q.set(bahnRel.subarray(3 * kn, 3 * kn + 3), 12);
			setzeBandEcke(spleissDaten, 0, q, 1, 0, 2, bahnT[k], 0);
			setzeBandEcke(spleissDaten, 1, q, 2, 1, 3, tJetzt, 0);
			setzeBandEcke(spleissDaten, 2, q, 3, 2, 4, bahnT[k + 1], 0);
			device.queue.writeBuffer(spleissPuffer, 0, spleissDaten);
		}

		// Sichtkreis um den aktuellen Fusspunkt; nur neu, wenn er sich bewegt hat
		// (bei Pause bleibt er stehen). Task 12c: Ecken und Band-Ecken in
		// wiederverwendeten Arrays (vorher ~1,5 KB Float32Array je Bild). Eine
		// Schwelle (erst ab 1 km Weg neu) entfaellt bewusst: der Kreis liefe dann in
		// 0,3-0,6-px-Stufen (1 km in 1500-2300 km Abstand, Folgen/1,2 R).
		function aktualisiereKreis(pos, gmst) {
			kreisKm[0] = pos[0] * R_KM; kreisKm[1] = pos[1] * R_KM; kreisKm[2] = pos[2] * R_KM;
			var f = window.SGP4.temeNachEcef(kreisKm, gmst);
			if (kreisFuss && f[0] === kreisFuss[0] && f[1] === kreisFuss[1] && f[2] === kreisFuss[2]) return;
			kreisFuss = f;
			var p = kreis(f, window.SGP4.geodaetisch(f).hoehe, KREIS_PUNKTE, kreisPunkte);
			kreisSpur.n = p.length / 3;
			kreisSpur.daten = bandEcken(p, null, kreisSpur.n, 2, true, kreisDaten);
			hochladen(kreisSpur);
		}

		// Station im Bild (Geraetepixel ab links oben) oder null hinter der Kamera
		function markerPx(viewProj, pos, viewport) {
			if (!pos) return null;
			var c = G.mat4.transformiere(viewProj, pos);
			if (!(c[3] > 0)) return null;
			return [(c[0] / c[3] * 0.5 + 0.5) * viewport[0], (0.5 - c[1] / c[3] * 0.5) * viewport[1]];
		}

		var z = {
			punkte: 0,              // Stuetzstellen der Bahn-/Bodenspur (nur lesen)
			berechnungen: 0,        // Aufrufe von aktualisiere (nur lesen)
			markerPx: null,         // [x, y] Geraetepixel der Station im letzten Bild, null hinter der Kamera

			// Bahn- und Bodenspur -1..+1 Umlauf um jdJetzt, Stuetzstellen alle 20 s,
			// um jdJetzt jede Sekunde (+-FEIN_FENSTER_S).
			aktualisiere: function (satrec, jdJetzt) {
				if (!satrec || !isFinite(jdJetzt)) return;
				var p = punkte(satrec, jdJetzt, SCHRITT_S, UMLAEUFE_VOR, UMLAEUFE_NACH);
				// Bahn: Ecken entstehen je Bild relativ zur Kamera (zeichne); hier nur
				// die double-Stuetzstellen merken und die Arrays dafuer bereitstellen.
				bahn.n = p.n;
				bahnD = p.bahnD; bahnT = p.t;
				if (!bahnRel || bahnRel.length < 3 * p.n) {
					bahnRel = new Float32Array(3 * p.n);
					bahnEckenDaten = new Float32Array(2 * p.n * FLOATS);
				}
				boden.n = p.n; boden.daten = bandEcken(p.boden, p.t, p.n, 1, false, null);
				spurJd = jdJetzt;
				sekundenJeT = p.sekundenJeT;
				// Strichmuster an der absoluten Zeit (seit Epoche) festmachen, auf der
				// CPU in doppelter Genauigkeit
				var striche = (jdJetzt - satrec.epocheJd) * 86400 / sekundenJeT * STRICHE_JE_T;
				strichPhase = isFinite(striche) ? striche - Math.floor(striche) : 0;
				z.punkte = p.n;
				z.berechnungen++;
			},

			// weltMatrizen = kamera.matrizen(..).welt ({viewProjRel, pos}; ohne viewProjRel
			// wird viewProj absolut benutzt); o = { gmst (rad), jd (Simulationszeit,
			// fuer die Grenze vergangen/kommend), issPositionR ([x,y,z] ECI in R oder
			// null = kein Marker, kein Sichtkreis), markerAlpha (0..1), nachbarAlpha
			// (Faktor fuer die Nachbarrunden, Vorgabe 1), dpr, viewportPx [b, h]
			// (Geraetepixel), schalter: { bahn, boden, kreis } }
			zeichne: function (pass, weltMatrizen, o) {
				o = o || {};
				var s = o.schalter || {};
				var gmst = isFinite(o.gmst) ? o.gmst : 0;
				var pos = endlich3(o.issPositionR) ? o.issPositionR : null;
				var alpha = isFinite(o.markerAlpha) ? Math.max(0, Math.min(1, o.markerAlpha)) : 1;
				var nachbar = isFinite(o.nachbarAlpha) ? Math.max(0, Math.min(1, o.nachbarAlpha)) : 1;
				var vp = o.viewportPx || [1, 1];
				// Kameraort (double), den die CPU von allen Bahnpositionen abzieht;
				// ohne viewProjRel bleibt alles absolut (Kamera 0).
				var relativ = !!weltMatrizen.viewProjRel && endlich3(weltMatrizen.pos);
				var viewProj = relativ ? weltMatrizen.viewProjRel : weltMatrizen.viewProj;
				var kx = relativ ? weltMatrizen.pos[0] : 0, ky = relativ ? weltMatrizen.pos[1] : 0, kz = relativ ? weltMatrizen.pos[2] : 0;
				var pr = null;
				if (pos) { posRel[0] = pos[0] - kx; posRel[1] = pos[1] - ky; posRel[2] = pos[2] - kz; pr = posRel; }

				u.set(viewProj, U_VIEWPROJ);
				u.set(G.mat4.rotZ(gmst), U_ERDFEST);
				u[U_ISS] = pr ? pr[0] : 0; u[U_ISS + 1] = pr ? pr[1] : 0; u[U_ISS + 2] = pr ? pr[2] : 0;
				u[U_ISS + 3] = alpha;
				u[U_BILD] = Math.max(1, vp[0]); u[U_BILD + 1] = Math.max(1, vp[1]);
				u[U_BILD + 2] = o.dpr || 1; u[U_BILD + 3] = 0;
				var tJetzt = spurJd !== null && isFinite(o.jd) ? (o.jd - spurJd) * 86400 / sekundenJeT : 0;
				u[U_SPUR] = tJetzt;
				u[U_SPUR + 1] = strichPhase;
				u[U_SPUR + 2] = nachbar; u[U_SPUR + 3] = 0;
				u[U_KAMERA] = kx; u[U_KAMERA + 1] = ky; u[U_KAMERA + 2] = kz; u[U_KAMERA + 3] = 1;
				device.queue.writeBuffer(uniformPuffer, 0, u);

				// Bahn je Bild relativ zur Kamera: Differenz in double, dann float32
				if (bahnD && bahn.n > 0) {
					var n3 = 3 * bahn.n;
					for (var i = 0; i < n3; i += 3) {
						bahnRel[i] = bahnD[i] - kx; bahnRel[i + 1] = bahnD[i + 1] - ky; bahnRel[i + 2] = bahnD[i + 2] - kz;
					}
					bahn.daten = bandEcken(bahnRel, bahnT, bahn.n, 0, false, bahnEckenDaten);
				}
				hochladen(bahn);
				hochladen(boden);
				var bahnAn = s.bahn !== false && !!bahn.puffer && bahn.n > 1;
				var k = bahnAn && pr ? spleissIndex(tJetzt, bahn.n) : -1;
				if (k >= 0) schreibeSpleiss(k, bahn.n, pr, tJetzt);
				var kreisAn = s.kreis !== false && !!pos;
				if (kreisAn) aktualisiereKreis(pos, gmst);
				z.markerPx = markerPx(viewProj, pr, vp);

				pass.setBindGroup(0, bindGroup);
				// Reihenfolge: Oberflaeche (Boden, Kreis), dann die Bahn darueber
				if (s.boden !== false && boden.puffer && boden.n > 1) zeichneSpur(pass, boden.puffer, 0, boden.n, 0, boden.n);
				if (kreisAn && kreisSpur.puffer && kreisSpur.n > 1) zeichneSpur(pass, kreisSpur.puffer, 0, kreisSpur.n, 0, kreisSpur.n - 1);   // Naht: letzter = erster
				if (bahnAn) {
					var n = bahn.n;
					if (k < 0) zeichneSpur(pass, bahn.puffer, 0, n, 0, n);
					else {
						// Strips 0..k und k+1..n-1 (unter 2 Stuetzstellen entfallen sie), Gelenke
						// ohne p_k und p_k+1; dann der Spleiss [p_k, Station, p_k+1] mit seinen Gelenken
						zeichneSpur(pass, bahn.puffer, 0, k + 1, 0, k);
						zeichneSpur(pass, bahn.puffer, k + 1, n - k - 1, k + 2, n - k - 2);
						zeichneSpur(pass, spleissPuffer, 0, 3, 0, 3);
					}
				}
				if (pos && alpha > 0) {
					pass.setPipeline(pMarker);
					pass.draw(6);
				}
			}
		};
		return z;
	}

	window.Spurzeichner = { neu: neu, punkte: punkte, kreis: kreis, zeitliste: zeitliste, U_BYTES: U_BYTES,
	                        FEIN_SCHRITT_S: FEIN_SCHRITT_S, FEIN_FENSTER_S: FEIN_FENSTER_S };
})(window);
