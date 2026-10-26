/*
 * ISS Tracker - Anwendung: Geraete-Start, Laden, Schleife, HUD, Regal,
 * Zeitleiste, Telemetrie (window.trackerDebug fuer den Pruefstand).
 *
 * Je Bild:
 *   1. Uhr weiterschalten (echtes dt), jd und GMST der Simulationszeit (in der
 *      Pause gehalten, Task 12c).
 *   2. Sonne/Mond alle 10 s Simulationszeit neu, Planeten alle 60 s, ISS jedes
 *      Bild (SGP4, TEME = ECI; Position in Erdradien fuer die Kamera), Spuren
 *      alle 2 s echter Zeit oder bei mehr als 60 s Simulationszeit seit der
 *      letzten Rechnung.
 *   3. Kamera-Schritt (dt fuer die Glaettung auf 0,1 s gedeckelt), Matrizen
 *      (Welt-Ebene kamerarelativ, Task 12b); Stationssystem, Erdschatten,
 *      Erdschein, Solarwinkel und Sichtbarkeit des Modells (stationsBild, opak
 *      unter 200 km); Marker-Alpha nach der Ist-Distanz (20 -> 5 km), zeitlich
 *      begrenzt (aus 0,3 s, ein 0,1 s); Lichtsprites nur unter 20 km.
 *   4. Ebenen zeichnen: eine Render-Pass je aktiver Ebene in denselben
 *      MSAA-Farbpuffer. Die erste Ebene loescht, jede weitere laedt; nur die
 *      letzte aktive Ebene loest auf die Canvas-Textur auf (resolveTarget).
 *      Ebenen mit Tiefe loeschen die Tiefe (Reversed-Z: 0) zu Beginn ihrer Pass.
 *   5. HUD-Texte (nur bei Aenderung ins DOM), Labels (ISS, Mond, Sonne,
 *      sichtbare Planeten; labels.js projiziert kamerarelativ, verdeckt,
 *      entzerrt; Ziehen ab einem Label geht an die Kamera) und trackerDebug.
 *      Der Doppeltipp nutzt die Matrizen dieses Bildes.
 *   Sonne und Planeten gehen als Koerper-Liste an himmel.js (Task 16):
 *   Scheibengroesse nach Magnitude (Kompaktstufe kleiner), Lichtrichtung je
 *   Planet aus Himmel.phasenLicht, Sonne mit der Erdrand-Blende sonneSicht.
 *
 * Zeichner (Erdzeichner, Spurzeichner, IssZeichner) und Labels werden nur
 * angelegt, wenn ihr Skript geladen ist (window.X mit Funktion neu); sonst
 * entfaellt die Ebene und der Rest laeuft weiter.
 *
 * Texturen (Task 15b): Vorschau 1024, dann Tag-Basis 8192 (ab 1600 CSS-Pixeln
 * Kantenlaenge) oder 4096, Nacht immer 4096; dazu die Detailkacheln
 * (kacheln.js, 4 Slots ab 1600 CSS-Pixeln Kantenlaenge, sonst 2), die je Bild nach Fusspunkt der
 * Station und Kameradistanz nachgeladen werden (nur unter 6000 km oder im
 * Folgen-Modus) und deren Tabelle der Erd-Shader liest. Das Texturarray der
 * Kacheln entsteht erst beim ersten solchen Bedarf (Task 19). Maske und Wolken
 * als r8unorm (Task 19, nur der Rotkanal wird gelesen).
 *
 * Task 19: MSAA-/Tiefenpuffer in einem out-of-memory-Bereich; scheitert die
 * Anlage, sinkt die DPR (2 -> 1, sonst halbiert bis 0,5) und die Tafel zeigt
 * "reduced resolution" (Pruefpfad ?render=oom). Verborgener Tab haelt den
 * Zeitraffer an (zeit.js Uhr.anhalten).
 *
 * Hintergrundmusik (Task 17): klang.js ueber den Knopf #bKlang und die Taste m;
 * an per Voreinstellung (Nachtrag 01.10.2026) - sperrt der Browser Autoplay,
 * startet die erste Nutzergeste; trackerDebug.klang {zustand, lautstaerke, wunsch}.
 *
 * Pruefpfade: ?texturen=fehlt (Ersatzerde), ?texturen=oom (grosse Tagkarte
 * gilt als gescheitert -> Rueckfall 8192 -> 4096 bzw. Vorschau mit Warnzeile
 * "reduced texture quality"), ?render=oom (erste Anlage von MSAA/Tiefe gilt
 * als gescheitert -> DPR sinkt, Warnzeile "reduced resolution"), ?epoche=alt
 * (Bahndaten 20 Tage aelter ausgeben -> Warnzeile "orbit data is N days old;
 * position may be off by tens of kilometres"),
 * ?kacheln=aus (keine Detailkacheln, Vergleich mit der Basis).
 */
(function () {
	"use strict";

	var R_KM = 6378.137;                              // Erdradius (Einheit der Welt-Ebene)
	var GRAD = 180 / Math.PI;
	var KOMPAKT = "(max-width: 640px), (max-height: 460px)";
	// Loeschfarbe #0b0e14. Die Canvas ist bgra8unorm (ohne -srgb) und die Shader
	// kodieren selbst nach sRGB; der Puffer haelt also sRGB-Werte, und die
	// Loeschfarbe steht deshalb direkt als 0..1 der Hexwerte darin.
	var HINTERGRUND = { r: 11 / 255, g: 14 / 255, b: 20 / 255, a: 1 };
	var WARN_ALTER_TAGE = 14;
	var SONNE_ALLE_S = 10, PLANETEN_ALLE_S = 60;
	// Spuren neu: alle 2 s ECHTER Zeit oder wenn die Simulationszeit seit dem
	// VORIGEN BILD um mehr als 60 s gesprungen ist (Zeitsprung). Der Zeitraffer
	// (x100 = 1,7 s je Bild) zaehlt damit nicht mehr als Sprung (Task 12a; vorher
	// 8 statt 2-3 Rechnungen je 5 s bei x100). Nach Simulationszeit waere es bei
	// x100 fast jedes Bild ein voller Doppelumlauf (559 Stuetzstellen).
	var SPUR_ALLE_MS_ECHT = 2000, SPUR_SPRUNG_S = 60;
	// Task 12c: in der Pause wird die Simulationszeit gehalten; erst eine Abweichung
	// ueber PAUSE_SPRUNG_MS gilt als Sprung (gemessenes Zittern +-1 ms, Spruenge
	// ueber Now/Pruefstand sind Sekunden und mehr).
	var PAUSE_SPRUNG_MS = 50;
	// Nachtrag 12a: die Spur hat feine 1-s-Stuetzstellen +-FEIN_FENSTER_S um die
	// letzte Rechnung; bevor die Station sie verlaesst (Zeitraffer: bei x100 nach
	// 0,9 s echter Zeit), wird neu gerechnet - sonst laege der Spleiss wieder
	// zwischen 20-s-Punkten (430 m Sagitta, Knick aus der Folgen-Kamera).
	var SPUR_FEIN_S = ((window.Spurzeichner && window.Spurzeichner.FEIN_FENSTER_S) || 90) - 10;
	var SPUR_FEIN_AB_KM = 500;                        // ... aber nur im Folgen-Modus oder naeher als 500 km (Fix-Runde 1)
	// Task 12a (A3): Modell opak ab MODELL_AB_KM (bei 100 km war es 0,84 px, ein
	// Alpha-Blend dort sinnlos); der Marker blendet zwischen MARKER_EIN_KM und
	// MARKER_AUS_KM (Modell 4-17 px) und wird zeitlich mit MARKER_BLENDE_S
	// begrenzt - beim Moduswechsel laeuft er damit ueber die Uebergangsdauer der
	// Kamera (kamera.js DAUER_UEBERGANG 1,2 s) statt ueber die Distanz.
	// Task 12b (A5): Der Marker blendet nach der IST-Distanz (smoothstep 20 -> 5 km),
	// zeitlich mit MARKER_BLENDE_S begrenzt. 12a blendete beim Moduswechsel ueber
	// die Zieldistanz und 1,2 s: die Kamera fliegt aber mit Smoothstep und erreicht
	// 20 km erst nach ~1,18 s (aus 13 600 km), der Marker war da laengst weg und das
	// Modell noch subpixel - nur die beiden Lichtsprites (4 px, weiss) fuellten das
	// Loch. Jetzt: Marker voll bis 20 km, dann in MARKER_BLENDE_S (heute
	// MARKER_BLENDE_AUS_S) ueber dem angekommenen Modell aus; zurueck zur Erde in
	// MARKER_BLENDE_S (heute MARKER_BLENDE_EIN_S) ein (das Modell ist nach ~60 ms
	// subpixel). 1,2 s ginge auf dem Rueckweg nicht ohne Loch.
	// Task 12c (N2): asymmetrisch. Ausblenden (Anflug, Modell steht schon) weiter
	// ueber MARKER_BLENDE_AUS_S 0,3 s; Einblenden (Rueckflug) in MARKER_BLENDE_EIN_S
	// 0,1 s - mit 0,3 s blieb nach dem Subpixel-Modell (~60 ms) 100-150 ms lang
	// eine Delle mit Marker-Alpha 0,15-0,4 (Pruefung 12b).
	var MODELL_AB_KM = 200, MARKER_EIN_KM = 20, MARKER_AUS_KM = 5, MARKER_BLENDE_AUS_S = 0.3, MARKER_BLENDE_EIN_S = 0.1;
	// Task 12b (A5): Nachbarrunden der Bahnspur (|t| > 0,5 Umlauf) im Folgen-Modus
	// mit diesem Alpha-Faktor - beim Blick entlang der Bahn lagen sie fast auf
	// derselben Bildlinie wie die eigene Runde (t12a-bahn-08-hinten.png). Der
	// Faktor laeuft ueber NACHBAR_BLENDE_S (= Uebergangsdauer der Kamera, kamera.js
	// DAUER_UEBERGANG 1,2 s) hin und zurueck.
	// Task 12c (N3): auch in der Erde-Ansicht, sobald die Kamera naeher als
	// NACHBAR_AB_KM an der Station ist - bei 1,2 R (Pruefung 12b) lief die
	// Nachbarrunde 11 km parallel zur eigenen Bahn.
	var NACHBAR_ALPHA = 0.3, NACHBAR_BLENDE_S = 1.2, NACHBAR_AB_KM = 2000;
	// Erdschein der Station: Grundanteil auch ueber der Nachtseite (t10-schatten-nah.png:
	// Station im Erdschatten praktisch unsichtbar), Rest nach Sonnenhoehe ueber der Erde.
	var ERDSCHEIN_GRUND = 0.08;
	// Task 16: Sonne und Planeten als Scheiben (himmel.js). Die Sonne blendet am
	// Erdrand ueber SONNE_BLENDE_PX (Winkelradius in CSS-Pixeln) weich aus; die
	// Planetenscheibe ist groessePx = clamp(min + (2 - mag) * 1.2, min, min + 4)
	// CSS-Pixel mit min 12 (Kompaktstufe 8): Mars/Merkur klein, Venus/Jupiter gross.
	var HZ = window.Himmelszeichner || {};
	var SONNE_BLENDE_PX = HZ.SONNE_BLENDE_PX || 20;
	var SONNE_KERN_PX = HZ.SONNE_KERN_PX || 14;
	var PLANET_MIN_PX = 12, PLANET_MIN_PX_KOMPAKT = 8, PLANET_SPANNE_PX = 4, PLANET_MAG_BEZUG = 2, PLANET_PX_JE_MAG = 1.2;
	var SATURN_RING_FAKTOR = HZ.RING_AUSSEN || 2.3;   // Ringbreite in Scheibenradien (Label haelt den Ring frei)
	var KOERPER_ART = { Mercury: 1, Venus: 2, Mars: 3, Jupiter: 4, Saturn: 5 };
	// Task 11: Labels und Doppeltipp
	var LICHTMINUTEN_JE_AE = 8.317;                   // 149 597 871 km / 299 792,458 km/s / 60
	var PLANET_ELONGATION_MIN = 10;                   // Grad; naeher an der Sonne im Glanz verloren (Punkt und Label aus)
	var MOND_RADIUS_KM = 1737.4;
	var ISS_MODELL_RADIUS_M = 68;                     // halbe Raumdiagonale 109 x 74,5 x 28,8 m (T10)
	var MARKER_RADIUS_PX = 8, SONNE_LABEL_RADIUS_PX = 26;   // frei gehaltener Bildradius je Objekt (Sonne: Kern + innere Korona; Planeten: halbe Scheibe)
	var MODELL_LABEL_ANTEIL = 0.35;                   // Task 19 (I1): Label-Kreis des Modells hoechstens 0,35 x kurze Bildkante
	var TIPP_RADIUS_PX = 24;                          // Doppeltipp auf den Marker
	var EPOCHE_ALT_TAGE = 20;                         // ?epoche=alt
	var SPERREN_ALLE_MS = 500;                        // Bedienfelder neu vermessen
	// Task 15b: Tag-Basis 8192 ab dieser CSS-Kantenlaenge, sonst 4096; die Nacht
	// bleibt ueberall bei 4096 (Quelle nur 3 km/px, 8192 braechte nichts und
	// kostete 134 MB). Cache-Version der Karten (v2: Tag-Stufen neu aus der
	// 21600er-Quelle) und der Kacheln.
	var BASIS_8192_AB_PX = 1600, NACHT_PX = 4096;
	var TEXTUR_VERSION = "?v=2", KACHELN_VERSION = "?v=1";
	// Task 17: Musik (tmp/iss-tracker/baue_audio.py), ogg vor mp3; Lautstaerke 0,35
	var KLANG_QUELLEN = ["audio/space-ambient.ogg?v=1", "audio/space-ambient.mp3?v=1"], KLANG_LAUTSTAERKE = 0.35;

	function $(id) { return document.getElementById(id); }
	var canvas = $("c");

	// ---------------------------------------------------------- Pruefstand
	// Nur lesen (ausser zeit.rateSetzen/zeit.live und kamera.schaueAuf, die
	// JSON.stringify weglaesst). Felder werden je Bild ueberschrieben.
	var debug = window.trackerDebug = {
		zeit: { jd: null, utc: "", rate: 1, versatzMs: 0, istLive: true, rateSetzen: function () {}, live: function () {}, springe: function () {} },
		iss: { lat: null, lon: null, hoehe: null, v: null, gueltig: false,
		       imSchatten: null, erdschein: null, solarWinkel: null, alpha: null, sonneStation: null,      // Task 10: Licht des Modells; alpha 1 = Modell gezeichnet (opak, Task 12a)
		       markerAlpha: 1 },                                                                          // Task 12a: Deckung des Markers (0..1)
		kamera: { modus: "erde", rahmen: "erdfest", distanzKm: null, schaueAuf: function () { return false; },
		          setzeFolgenDistanz: function () { return null; }, setzeFolgenWinkel: function () { return null; } },
		modellSichtbar: false,
		fps: 0,
		warnungen: [],
		// liste: [{id, x, y, breite, hoehe, rand, versatz}] CSS-Pixel; entfallen: [{id, grund: 'hinten'|'erde'}]
		labels: { anzahl: 0, kollisionen: 0, liste: [], entfallen: [] },
		texturen: null,                               // 'ersatz' | 'vorschau' | 'voll' (Erdzeichner.modus)
		texturenGroesse: 0,                           // Breite der Tagkarte: 8192 oder 4096 (ab Ladebeginn), 1024 (grosse Karte gescheitert, Vorschau bleibt) oder 0 (keine)
		texturenGroesseNacht: 0,                      // Breite der Nachtkarte (immer 4096)
		// Task 15b: Detailkacheln - an, slots, geladen ["4-0", ...] (Slotreihenfolge), ladend, fehlgeschlagen, aktiv, wartend;
		// Task 19: angelegt (Texturarray erst beim ersten Bedarf, vorher false)
		kacheln: { an: false, angelegt: false, slots: 0, geladen: [], ladend: null, fehlgeschlagen: [], aktiv: 0, wartend: [] },
		sterne: 0,
		himmel: { sonneSichtbar: false, planeten: [], koerper: [] },   // koerper (Task 16): [{name, groessePx, anteil, hell, sichtbar}]
		spur: { punkte: 0, berechnungen: 0, markerPx: null, nachbarAlpha: 1 },  // markerPx: [x, y] CSS-Pixel der Station, null hinter der Kamera; nachbarAlpha: Faktor der Nachbarrunden (Task 12c)
		klang: { zustand: "aus", lautstaerke: 0, wunsch: false },   // Task 17: 'aus' | 'laedt' | 'an' | 'fehler', aktuelle volume (0..0,35); wunsch: Autoplay gesperrt, erste Geste startet
		groesse: [0, 0],
		dpr: 1,                                       // Task 19: wirksame DPR (hoechstens 2; nach OOM der Puffer 1 bzw. halbiert)
		bilder: 0
	};

	// Hinweis-Overlay (#fehler) - dasselbe Verhalten wie in gpu.js.
	function zeigeHinweis(text) {
		var feld = $("fehler");
		if (!feld) return;
		feld.textContent = text;
		feld.hidden = false;
	}

	// Text/Zustand nur ins DOM schreiben, wenn er sich geaendert hat.
	var zuletztText = {};
	function setzeText(el, text) {
		if (!el || zuletztText[el.id] === text) return;
		zuletztText[el.id] = text;
		el.textContent = text;
	}
	function setzeGedrueckt(el, an) {
		var w = an ? "true" : "false";
		if (el && el.getAttribute("aria-pressed") !== w) el.setAttribute("aria-pressed", w);
	}
	function smoothstep(a, b, x) { var t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
	function meldung(e) { return e && e.message ? e.message : String(e); }

	// ---------------------------------------------------------- Station (Task 10)
	function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
	function norm3(v) { var l = Math.hypot(v[0], v[1], v[2]); return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null; }
	// Das Stationssystem des Modells (+X Steuerbord, +Y Flugrichtung, +Z Zenit)
	// ist das Bahnsystem der Kamera: Kamera.bahnsystem({positionR,
	// geschwindigkeitRproS}) -> {seite, vorn, oben} (Task 12c; vorher eine eigene
	// Kopie hier). Dieselbe Konvention haelt die Folgen-Kamera "schraeg von
	// hinten" wirklich hinter der Station.
	// Richtung r (ECI) ins Stationssystem: [dot(r, seite), dot(r, vorn), dot(r, oben)] -> aus
	function insStationssystem(r, sys, aus) {
		aus[0] = dot3(r, sys.seite); aus[1] = dot3(r, sys.vorn); aus[2] = dot3(r, sys.oben);
		return aus;
	}
	// Erdschatten 0..1: Strahl von der Station (pos in R) zur Sonne gegen die
	// Einheitskugel. Nur wenn die Sonne "hinter" der Station steht (dot < 0) kann
	// der Strahl die Erde treffen; sein kleinster Abstand zum Erdmittelpunkt ist
	// |pos - sonne dot(pos, sonne)|. Uebergang 0,016 R (~100 km) breit.
	function erdschatten(pos, sonne) {
		var d = dot3(pos, sonne);
		if (d >= 0) return 0;
		var q = [pos[0] - sonne[0] * d, pos[1] - sonne[1] * d, pos[2] - sonne[2] * d];
		return smoothstep(-0.008, 0.008, 1 - Math.hypot(q[0], q[1], q[2]));
	}

	// ---------------------------------------------------------- Bahn (SGP4)
	// Pruefsumme beider Zeilen, dann init; jeder Fehler -> ohne Station weiter,
	// Warnzeile "orbit data unusable".
	function ladeBahn() {
		var B = window.BAHN, S = window.SGP4;
		if (!B || !S || typeof B.zeile1 !== "string" || typeof B.zeile2 !== "string") {
			console.warn("orbit data missing (bahn.js)");
			return null;
		}
		if (!S.pruefsumme(B.zeile1) || !S.pruefsumme(B.zeile2)) {
			console.warn("orbit data: TLE checksum failed");
			return null;
		}
		var s = S.init(B.zeile1, B.zeile2);
		if (!s || s.fehler) {
			console.warn("orbit data: SGP4 init error " + (s ? s.fehler : "?"));
			return null;
		}
		return s;
	}

	// Zustand der Station zur Zeit jd. positionR/geschwindigkeitRproS in
	// Erdradien (ECI = TEME), lat/lon in Grad, hoehe in km, v in km/s.
	function berechneIss(satrec, jd, gmst) {
		var z = { gueltig: false, fehler: 0, positionR: null, geschwindigkeitRproS: null, rKm: null, lat: NaN, lon: NaN, hoehe: NaN, v: NaN };
		if (!satrec) { z.fehler = -1; return z; }
		var e = window.SGP4.propagiere(satrec, jd);
		z.fehler = e.fehler;
		if (e.fehler !== 0 || !e.r || e.r.length !== 3 || !e.v || e.v.length !== 3) return z;   // auch 6 (verfallen): ausblenden
		var r = e.r, v = e.v;
		z.rKm = r;
		z.positionR = [r[0] / R_KM, r[1] / R_KM, r[2] / R_KM];
		z.geschwindigkeitRproS = [v[0] / R_KM, v[1] / R_KM, v[2] / R_KM];
		var g = window.SGP4.geodaetisch(window.SGP4.temeNachEcef(r, gmst));
		z.lat = g.lat * GRAD; z.lon = g.lon * GRAD; z.hoehe = g.hoehe;
		z.v = Math.hypot(v[0], v[1], v[2]);
		z.gueltig = isFinite(z.lat) && isFinite(z.lon) && isFinite(z.hoehe) && isFinite(z.positionR[0]);
		return z;
	}

	// ---------------------------------------------------------- Zeittexte
	function dauerText(ms) {
		var s = Math.round(Math.abs(ms) / 1000), vz = ms < 0 ? "−" : "+";
		var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
		if (d) return vz + d + " d " + h + " h";
		if (h) return vz + h + " h " + m + " min";
		if (m) return vz + m + " min";
		return vz + (s % 60) + " s";
	}
	function zeitZeile(uhr) {
		if (uhr.istLive()) return "live";
		var t = uhr.rate === 0 ? "paused" : (uhr.rate === 1 ? "real time" : "×" + uhr.rate + " time-lapse");
		if (Math.abs(uhr.versatzMs) >= 1000) t += " · " + dauerText(uhr.versatzMs);
		return t;
	}
	function alterText(tage) {
		var n = Math.floor(tage);
		if (n < 1) return "under a day old";
		return n + (n === 1 ? " day old" : " days old");
	}

	// ---------------------------------------------------------- Labeltexte (Task 11)
	// Grad mit einer Nachkommastelle und Hemisphaere; das Vorzeichen nach dem
	// Runden, damit -0.04 als 0.0°N erscheint und nicht als 0.0°S.
	function gradText(wert, plus, minus) {
		var r = Math.round(wert * 10) / 10;
		return Math.abs(r).toFixed(1) + "°" + (r >= 0 ? plus : minus);
	}
	function issText(iss) {
		return "ISS · " + gradText(iss.lat, "N", "S") + " " + gradText(iss.lon, "E", "W") +
			" · " + Math.round(iss.hoehe) + " km · " + iss.v.toFixed(2) + " km/s";
	}
	function mondText(mond) {
		return "Moon · " + Math.round(mond.beleuchtung * 100) + " % " + (mond.zunehmend ? "waxing" : "waning");
	}
	// Bildradius des Stationsmodells in CSS-Pixeln (T10): halbe Raumdiagonale
	// 68 m in distKm Abstand, f = proj[5] = 1 / tan(fov/2), cssH Bildhoehe.
	// 0 bei unbrauchbarem Abstand. Fuer Label (radiusPx) und Doppeltipp (Trefferkreis).
	function modellRadiusPx(distKm, f, cssH) {
		if (!(distKm > 0) || !isFinite(distKm)) return 0;
		return ISS_MODELL_RADIUS_M / (distKm * 1000) * f * cssH / 2;
	}
	// Planet sichtbar = Scheibe im Himmel und Label (Elongation, endliche
	// Magnitude, Grenzmagnitude). Die Regel steht nur hier (seit Task 16 blendet
	// himmel.js allein nach 'hell'; PLANET_ELONGATION_MIN gibt es nur in
	// tracker.js): einmal je Bild entschieden, als p.verdeckt bzw. hell 0 weiter.
	function planetSichtbar(p, grenzMag) {
		return !!(p && p.helligkeit > 0 && p.elongationGrad >= PLANET_ELONGATION_MIN &&
			isFinite(p.magnitude) && p.magnitude <= grenzMag);
	}
	// Task 16: Scheibendurchmesser eines Planeten in CSS-Pixeln nach Magnitude
	function planetGroessePx(magnitude, kompaktAn) {
		var min = kompaktAn ? PLANET_MIN_PX_KOMPAKT : PLANET_MIN_PX;
		var px = min + (PLANET_MAG_BEZUG - (isFinite(magnitude) ? magnitude : PLANET_MAG_BEZUG)) * PLANET_PX_JE_MAG;
		return Math.max(min, Math.min(min + PLANET_SPANNE_PX, px));
	}

	// Strahl von der Kamera (pos in R) in Richtung d gegen die Erdkugel (Radius 1):
	// liefert den Sichtbarkeitsfaktor 0..1 der Sonne. Hinter der Erdscheibe 0,
	// ueber den Halo-Radius (Winkel) am Rand weich ausgeblendet - kein Springen
	// des 40-px-Halos am Erdrand.
	function sonneSichtbarkeit(pos, d, haloWinkel) {
		var l = Math.hypot(pos[0], pos[1], pos[2]);
		if (!(l > 1)) return 0;                                   // Kamera in der Erde
		var alpha = Math.asin(1 / l);                             // Winkelradius der Erde
		var c = -(pos[0] * d[0] + pos[1] * d[1] + pos[2] * d[2]) / l;
		var beta = Math.acos(Math.max(-1, Math.min(1, c)));      // Winkel Sonne <-> Erdmitte
		return smoothstep(alpha - haloWinkel, alpha, beta);
	}

	// ---------------------------------------------------------- Start
	async function main() {
		var gpu = await window.GPU.starte(canvas);
		if (!gpu) return;                                         // Hinweis zeigt gpu.js schon
		var device = gpu.device, context = gpu.context, format = gpu.format;
		var laeuft = true;
		device.lost.then(function () { laeuft = false; });       // Hinweis zeigt gpu.js

		// ---- Zeichner: nur die vorhandenen anlegen, im Validierungs-Scope
		function neuerZeichner(name) {
			var modul = window[name];
			if (!modul || typeof modul.neu !== "function") return null;   // Skript fehlt (noch)
			try { return modul.neu(gpu, format); }
			catch (e) { console.error(name + ".neu failed: " + (e && e.message ? e.message : e)); return null; }
		}
		device.pushErrorScope("validation");
		var himmel = neuerZeichner("Himmelszeichner");
		var erde = neuerZeichner("Erdzeichner");               // Task 7
		var spur = neuerZeichner("Spurzeichner");              // Task 8
		var issZeichner = neuerZeichner("IssZeichner");        // Task 10
		var fehlerAufbau = await device.popErrorScope();
		if (fehlerAufbau) {
			console.error("WebGPU validation error: " + fehlerAufbau.message);
			zeigeHinweis("WebGPU setup failed — see the browser console.");
			return;
		}

		// ---- Uhr, Bahn, Kamera
		var uhr = new window.Zeit.Uhr();
		var rateVorPause = 1;
		var satrec = ladeBahn();
		var epocheMs = satrec ? window.Zeit.ms(satrec.epocheJd) : Date.parse(window.BAHN && window.BAHN.epoche);
		// Pruefpfad ?epoche=alt: nur die ausgegebene und fuer das Alter verglichene
		// Epoche liegt 20 Tage frueher. satrec rechnet weiter mit der echten Epoche
		// aus Zeile 1, die Station steht also am richtigen Ort.
		if (new URLSearchParams(window.location.search).get("epoche") === "alt" && isFinite(epocheMs)) {
			epocheMs -= EPOCHE_ALT_TAGE * 86400000;
		}
		var kamera = window.Kamera.neu(canvas);
		var labelEbene = null;                                   // Task 11
		if (window.Labels && typeof window.Labels.neu === "function" && $("labels")) {
			try { labelEbene = window.Labels.neu($("labels"), $("linien"), { zeigerZiel: canvas }); }   // Task 12c: Ziehen ab Label dreht die Kamera
			catch (e) { console.error("Labels.neu failed: " + (e && e.message ? e.message : e)); }
		}
		var sterneFehlen = false;

		// ---- Regal und Zeitleiste
		var schalter = { wolken: true, atmosphaere: true, nachtlichter: true, bahn: true, boden: true, kreis: true, labels: true };
		var grenzMag = 6.5;
		var issGueltig = false;

		function pauseUmschalten() {
			if (uhr.rate === 0) uhr.setzeRate(rateVorPause || 1);
			else { rateVorPause = uhr.rate; uhr.pause(); }
		}
		function jetzt() { uhr.fortsetzen(); uhr.springe(-uhr.versatzMs); }   // zur echten Zeit, Rate bleibt
		function folgen() { if (issGueltig) kamera.setzeModus("folgen"); }

		$("bLive").addEventListener("click", function () { uhr.live(); });
		$("bPause").addEventListener("click", pauseUmschalten);
		$("b10").addEventListener("click", function () { uhr.setzeRate(10); });
		$("b100").addEventListener("click", function () { uhr.setzeRate(100); });
		$("bJetzt").addEventListener("click", jetzt);

		// Task 17: Hintergrundmusik. Den Knopf verdrahtet Klang.neu selbst (Klick,
		// aria-pressed); hier die Taste m - nicht, wenn ein Eingabefeld den Fokus
		// hat (wie kamera.js), nicht bei Tastenwiederholung. Nachtrag 01.10.2026:
		// Klang.neu startet selbst (an per Voreinstellung) bzw. wartet auf die
		// erste Geste; m zaehlt dort nicht als Geste (tasten), sonst schaltete die
		// erste Taste m an und gleich wieder aus - im Wunsch startet m die Musik.
		var klang = null;
		if (window.Klang && typeof window.Klang.neu === "function" && $("bKlang")) {
			var klangSpeicher = null;
			try { klangSpeicher = window.localStorage; } catch (e) { /* gesperrt: Wahl wird nicht gemerkt */ }
			try { klang = window.Klang.neu({ knopf: $("bKlang"), quellen: KLANG_QUELLEN, lautstaerke: KLANG_LAUTSTAERKE, speicher: klangSpeicher, tasten: ["m", "M"] }); }
			catch (e) { console.error("Klang.neu failed: " + meldung(e)); }
		}
		if (klang) {
			window.addEventListener("keydown", function (e) {
				if (e.key !== "m" && e.key !== "M") return;
				if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
				var ziel = e.target, tag = ziel && ziel.tagName ? ziel.tagName.toLowerCase() : "";
				if (tag === "input" || tag === "textarea" || tag === "select" || (ziel && ziel.isContentEditable)) return;
				e.preventDefault();
				klang.umschalten();
			});
		}

		$("kErde").addEventListener("click", function () { kamera.setzeModus("erde"); });
		$("kFolgen").addEventListener("click", folgen);
		$("kBlick").addEventListener("click", function () { kamera.setzeModus("blick"); });
		$("kErdfest").addEventListener("click", function () { kamera.setzeRahmen("erdfest"); });
		$("kRaumfest").addEventListener("click", function () { kamera.setzeRahmen("raumfest"); });
		$("bZurueck").addEventListener("click", function () { kamera.zurueckZurErde(); });

		kamera.onTaste = function (name) {
			if (name === "folgen") folgen();
			else if (name === "erde") kamera.zurueckZurErde();
			else if (name === "jetzt") jetzt();
			else if (name === "pause") pauseUmschalten();
		};
		// Doppeltipp (CSS-Pixel im Canvas) gegen den Stand des letzten Bildes:
		// Marker bzw. Modell getroffen -> Folgen; sonst im Blick-Modus ein Strahl
		// durch das Pixel, der die Erdkugel trifft -> zurueck zur Erde.
		var tipp = { markerPx: null, trefferPx: TIPP_RADIUS_PX, view: null, proj: null, pos: null, breite: 0, hoehe: 0, gmst: 0 };
		kamera.onDoppeltipp = function (x, y) {
			if (tipp.markerPx && Math.hypot(x - tipp.markerPx[0], y - tipp.markerPx[1]) < tipp.trefferPx) { folgen(); return; }
			if (kamera.modus === "blick" && window.Labels && tipp.view && tipp.breite > 0) {
				var d = window.Labels.strahl(tipp.view, tipp.proj, x, y, tipp.breite, tipp.hoehe);
				if (d && window.Labels.richtungVerdeckt(tipp.pos, d)) kamera.zurueckZurErde();
			}
		};

		[["sWolken", "wolken"], ["sAtmo", "atmosphaere"], ["sNacht", "nachtlichter"], ["sBahn", "bahn"],
		 ["sBoden", "boden"], ["sKreis", "kreis"], ["sLabels", "labels"]].forEach(function (p) {
			var el = $(p[0]);
			schalter[p[1]] = el.checked;
			el.addEventListener("change", function () {
				schalter[p[1]] = el.checked;
				if (p[1] === "labels") { $("labels").hidden = !el.checked; $("linien").hidden = !el.checked; }
			});
		});
		var sMag = $("sMag");
		function magGeaendert() {
			var w = parseFloat(sMag.value);
			grenzMag = isFinite(w) ? w : 6.5;
			setzeText($("oMag"), grenzMag.toFixed(1));
		}
		sMag.addEventListener("input", magGeaendert);
		magGeaendert();

		var rack = $("rack"), bRack = $("bRack");
		// Bedienfelder als Sperrflaechen fuer Randlabels (CSS-Pixel), alle 0,5 s
		// oder nach dem Auf-/Zuklappen des Regals neu vermessen.
		var sperrElemente = [document.querySelector(".plate"), rack, document.querySelector(".zeit")];
		var sperren = [], sperrenZeit = -Infinity;
		function messeSperren(t) {
			if (t - sperrenZeit < SPERREN_ALLE_MS) return;
			sperrenZeit = t;
			sperren = [];
			sperrElemente.forEach(function (e) {
				if (!e) return;
				var r = e.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) sperren.push({ x: r.left, y: r.top, breite: r.width, hoehe: r.height });
			});
		}
		function rackZu(zu) {
			rack.classList.toggle("zu", zu);
			bRack.setAttribute("aria-expanded", zu ? "false" : "true");
			bRack.textContent = zu ? "+" : "−";
			bRack.title = zu ? "Expand" : "Collapse";
			sperrenZeit = -Infinity;
		}
		bRack.addEventListener("click", function () { rackZu(!rack.classList.contains("zu")); });
		var kompakt = window.matchMedia ? window.matchMedia(KOMPAKT) : null;
		rackZu(!!(kompakt && kompakt.matches));                  // Kompaktstufe: Regal startet zu
		if (kompakt) {
			var beiWechsel = function (e) { if (e.matches) rackZu(true); };
			if (kompakt.addEventListener) kompakt.addEventListener("change", beiWechsel);
			else if (kompakt.addListener) kompakt.addListener(beiWechsel);
		}

		// Info: Bahnelemente
		if (satrec) {
			setzeText($("iEpoche"), window.Zeit.formatUTC(epocheMs).replace(/:\d\d UTC$/, " UTC"));
			setzeText($("iUmlauf"), window.SGP4.umlaufzeitMin(satrec).toFixed(1) + " min");
			setzeText($("iNeigung"), window.SGP4.neigungGrad(satrec).toFixed(2) + "°");
		}

		// ---- Pruefstand: Zeitsteuerung, Schwenk auf ein Himmelsobjekt
		debug.zeit.rateSetzen = function (r) { uhr.setzeRate(+r); return uhr.rate; };
		debug.zeit.live = function () { uhr.live(); return true; };
		debug.zeit.springe = function (deltaMs) { uhr.springe(+deltaMs || 0); return uhr.versatzMs; };   // Simulationszeit verschieben
		var himmelsDaten = { sonne: null, mond: null, planeten: [] };
		var kameraPos = null;                                    // Kameraort (R) des letzten Bildes
		// Richtung von der Kamera zu einem Himmelsobjekt. Der Mond ist nah (60 R):
		// vom Kameraort aus gesehen weicht er bis ~3 Grad von der geozentrischen
		// Richtung ab, also Mondort minus Kameraort. Sonne/Planeten: Richtung.
		function richtungZu(name) {
			var n = String(name).toLowerCase(), d = null;
			if (n === "sun" && himmelsDaten.sonne) d = himmelsDaten.sonne.richtung;
			if (n === "moon" && himmelsDaten.mond) {
				var mp = himmelsDaten.mond.position, kp = kameraPos || kamera.debug().pos;
				d = norm3([mp[0] - kp[0], mp[1] - kp[1], mp[2] - kp[2]]);
			}
			himmelsDaten.planeten.forEach(function (p) { if (p.name.toLowerCase() === n) d = p.richtung; });
			return d;
		}
		// Klick auf ein Himmelslabel: Blick-Modus, 1,2 s Schwenk dorthin (kamera.zentriere)
		function schaueAuf(name) {
			var d = richtungZu(name);
			if (!d) return false;
			kamera.zentriere(d);
			return true;
		}
		debug.kamera.schaueAuf = schaueAuf;
		var klickAuf = {};                                       // je Name eine Funktion, einmal angelegt
		function klickHimmel(name) {
			return klickAuf[name] || (klickAuf[name] = function () { schaueAuf(name); });
		}
		// Task 10: Folgen-Kamera aus dem Pruefstand einstellen (Sollwerte in km bzw.
		// rad; die Kamera begrenzt sie im naechsten Schritt auf FOLGEN_DIST / +-89 Grad).
		debug.kamera.setzeFolgenDistanz = function (km) { if (isFinite(+km)) kamera.folgen.dist = +km; return kamera.folgen.dist; };
		debug.kamera.setzeFolgenWinkel = function (az, hoehe) {
			if (isFinite(+az)) kamera.folgen.az = +az;
			if (isFinite(+hoehe)) kamera.folgen.hoehe = +hoehe;
			return [kamera.folgen.az, kamera.folgen.hoehe];
		};
		// Task 12a: Erd-Kamera aus dem Pruefstand einstellen (Sollwerte rad, rad, R;
		// im Rahmen 'erdfest' ist az die geographische Laenge) - fuer den
		// Sichtvergleich der Erde an einem festen Ort (z. B. 12:00 UTC ueber Afrika).
		debug.kamera.setzeErdeWinkel = function (az, hoehe, dist) {
			if (isFinite(+az)) kamera.erde.az = +az;
			if (isFinite(+hoehe)) kamera.erde.hoehe = +hoehe;
			if (isFinite(+dist)) kamera.erde.dist = +dist;
			return [kamera.erde.az, kamera.erde.hoehe, kamera.erde.dist];
		};
		// Task 15b: Bodenpunkt (Grad) mit den Matrizen des letzten Bildes ins Bild
		// projizieren -> [x, y] CSS-Pixel oder null (hinter der Kamera). Damit
		// findet der Pruefstand eine Kachelgrenze (z. B. lon 0) im Screenshot.
		debug.kamera.projiziere = function (latGrad, lonGrad) {
			if (!tipp.view || !window.Labels || !(tipp.breite > 0)) return null;
			var la = latGrad / GRAD, lo = lonGrad / GRAD, M = window.GPU.mat4;
			var p = M.transformiere(M.rotZ(tipp.gmst || 0), [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]);
			var q = window.Labels.projiziere(M.mul(tipp.proj, tipp.view), [p[0], p[1], p[2]], tipp.breite, tipp.hoehe);
			return q && q.vorne ? [q.x, q.y] : null;
		};

		// ---- Sterne (Fehler -> ohne Sterne weiter)
		if (himmel) {
			window.Sterne.lade("sterne.bin?v=1").then(function (kat) {
				var T = window.Zeit.T(window.Zeit.jd(uhr.jetztMs()));
				himmel.setzeSterne(kat, window.Himmel.praezession(T));
				debug.sterne = himmel.sterne;
			}).catch(function (e) {
				sterneFehlen = true;
				console.warn("star catalog unavailable: " + (e && e.message ? e.message : e));
			});
		}

		// ---- Texturen der Erde (Fehler -> Ersatzerde bzw. Vorschau bleibt)
		// Vorschau erde-tag-1024 zuerst, danach Tag in 4096 oder 8192 (ab 1600
		// CSS-Pixeln Kantenlaenge), Nacht 4096, Wolken, Maske, Mond - unabhaengig voneinander;
		// nach jedem Schritt setzeTexturen (neue Bindgruppe). ?texturen=fehlt haengt
		// ".fehlt" an jeden Dateinamen (Pruefpfad fuer die Ersatzerde).
		// Task 15b (Fix-Runde 1): jede Textur wird in Fehlerbereichen (out-of-memory,
		// validation) angelegt - die 8192er-Tagkarte belegt 179 MB; scheiterte sie
		// ungefangen, waere die Bindgruppe ungueltig und jedes Bild schwarz. Bei
		// Fehler: Textur zerstoeren, Warnung, Tag 8192 -> Rueckfall auf 4096, Tag
		// 4096 -> Vorschau bleibt. ?texturen=oom behandelt die erste grosse Tagkarte
		// als gescheitert (Pruefpfad fuer den Rueckfall).
		var texturSatz = { tag: null, nacht: null, wolken: null, maske: null, mond: null, kacheln: null };
		var vorschauFehlt = false, tagReduziert = false;
		var texturenArt = new URLSearchParams(window.location.search).get("texturen");   // null | 'fehlt' | 'oom'
		var oomSimuliert = null;                                 // Dateiname, dessen Anlage als gescheitert gilt
		var kacheln = null, kachelnVersion = -1;                 // Task 15b (kacheln.js), null = aus oder nicht verfuegbar
		// format (optional, Task 19 M6): Texturformat, Vorgabe rgba8unorm (GPU.textur)
		function ladeTextur(name, label, format) {
			var suffix = texturenArt === "fehlt" ? ".fehlt" : "";
			return fetch("texturen/" + name + suffix + TEXTUR_VERSION).then(function (r) {
				if (!r.ok) throw new Error(name + " (" + r.status + ")");
				return r.blob();
			}).then(function (blob) {
				return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
			}).then(function (bitmap) {
				// push/pop synchron um die Anlage, damit sich parallele Ladevorgaenge
				// nicht in die Fehlerbereiche des anderen schieben; nur die Ergebnisse
				// kommen asynchron.
				var t = null, ausnahme = null;
				device.pushErrorScope("out-of-memory");
				device.pushErrorScope("validation");
				try { t = window.GPU.textur(device, bitmap, { mipmaps: true, label: label, format: format }); }
				catch (e) { ausnahme = e; }
				var pV = device.popErrorScope(), pM = device.popErrorScope();
				if (bitmap.close) bitmap.close();
				return Promise.all([pV, pM]).then(function (f) {
					var fehler = ausnahme || f[0] || f[1];
					if (!fehler && texturenArt === "oom" && name === oomSimuliert) fehler = { message: "simulated out-of-memory (?texturen=oom)" };
					if (fehler) {
						if (t) { try { t.destroy(); } catch (e2) { /* schon weg */ } }
						throw new Error(name + " (" + (fehler.message || fehler) + ")");
					}
					return t;
				});
			});
		}
		function setzeTextur(schluessel, t) {
			var alt = texturSatz[schluessel];
			texturSatz[schluessel] = t;
			erde.setzeTexturen(texturSatz);
			if (alt) alt.destroy();                               // die Vorschau, sobald die volle Karte da ist
		}
		// Tagkarte in 'groesse' laden; scheitert 8192, dann 4096; scheitert 4096,
		// bleibt die Vorschau (texturenGroesse = deren Breite, 0 ohne Karte).
		// Task 19 (M10): bleibt nur die Vorschau, zeigt die Tafel "reduced texture
		// quality" (tagReduziert; wie "textures failed to load" fuer die Ersatzerde).
		function ladeTag(groesse) {
			debug.texturenGroesse = groesse;
			return ladeTextur("erde-tag-" + groesse + ".jpg", "erde tag").then(function (t) { setzeTextur("tag", t); }, function (e) {
				console.warn("texture unavailable: " + meldung(e));
				if (groesse > 4096) return ladeTag(4096);
				debug.texturenGroesse = texturSatz.tag ? texturSatz.tag.width : 0;
				tagReduziert = !!texturSatz.tag;
			});
		}
		// Task 12c (B): eine Ausnahme in einer Erfolgsfunktion (setzeTextur) faengt
		// das zweite Argument desselben then nicht - ohne catch bliebe sie
		// unbehandelt und die Kette nach der Vorschau (Tag, Nacht, ...) liefe nicht an.
		function warnSetzen(e) { console.warn("texture setup failed: " + meldung(e)); }
		function ladeTexturen() {
			var css = Math.max(canvas.clientWidth, canvas.clientHeight);
			var start = css >= BASIS_8192_AB_PX ? 8192 : 4096;
			debug.texturenGroesse = start;
			debug.texturenGroesseNacht = NACHT_PX;
			if (texturenArt === "oom") oomSimuliert = "erde-tag-" + start + ".jpg";
			ladeTextur("erde-tag-1024.jpg", "erde tag vorschau").then(function (t) {
				setzeTextur("tag", t);
			}, function (e) {
				vorschauFehlt = true;
				console.warn("textures failed to load: " + meldung(e));
			}).catch(warnSetzen).then(function () {
				ladeTag(start).catch(warnSetzen);
				// Task 19 (M6): Wolken und Maske als r8unorm - die Shader lesen nur .r
				// (erde.js fsErde/fsWolken); 2,8 statt 11,2 MB je Karte samt Mips.
				[["nacht", "erde-nacht-" + NACHT_PX + ".jpg"],
				 ["wolken", "wolken-2048.jpg", "r8unorm"], ["maske", "maske-2048.png", "r8unorm"], ["mond", "mond-1024.jpg"]].forEach(function (p) {
					ladeTextur(p[1], "erde " + p[0], p[2]).then(function (t) { setzeTextur(p[0], t); }, function (e) {
						console.warn("texture unavailable: " + meldung(e));
					}).catch(warnSetzen);
				});
			});
		}
		if (erde) ladeTexturen();

		// ---- Task 15b: Detailkacheln. Texturarray (bis 156 MB) in eigenen
		// Fehlerbereichen anlegen: schlaegt es fehl (Speicher, Validierung), laeuft
		// die Demo mit der Basis weiter. ?kacheln=aus schaltet ab.
		// Task 19 (M4): das Array entsteht erst beim ersten Bedarf (kachelnBeiBedarf
		// aus der Bildschleife: Station naeher als Kacheln.BLEND_FERN_KM oder
		// Folgen-Modus - dieselbe Bedingung, unter der kacheln.aktualisiere laedt).
		// Im Uebersichtsfall spart das 78 MB (Handy, 2 Slots) bzw. 156 MB (4 Slots).
		// Die Slotzahl wird weiter beim Start nach der Fenstergroesse bestimmt.
		// kachelnArt: 'wartet' (an, noch nicht angelegt) | 'anlegen' | 'da' | 'aus'
		// (?kacheln=aus, Modul fehlt oder Anlage gescheitert).
		var KA = window.Kacheln;
		var kachelnArt = "aus", kachelnSlots = 0;
		if (erde && KA && typeof KA.neu === "function" && new URLSearchParams(window.location.search).get("kacheln") !== "aus") {
			kachelnArt = "wartet";
			kachelnSlots = KA.slotsFuer(canvas.clientWidth, canvas.clientHeight);
		}
		var KACHELN_AB_KM = (KA && KA.BLEND_FERN_KM) || 6000;
		debug.kacheln = { an: kachelnArt === "wartet", angelegt: false, slots: kachelnSlots, geladen: [], ladend: null, fehlgeschlagen: [], aktiv: 0, wartend: [] };
		async function erzeugeKacheln() {
			var k = null;
			device.pushErrorScope("out-of-memory");
			device.pushErrorScope("validation");
			try {
				k = KA.neu(gpu, { slots: kachelnSlots, url: "texturen/kacheln/", version: KACHELN_VERSION });
			} catch (e) {
				console.warn("tiles unavailable: " + (e && e.message ? e.message : e));
			}
			var pV = device.popErrorScope(), pM = device.popErrorScope();   // beide synchron abheben (LIFO)
			var f = (await pV) || (await pM);
			if (f) {
				console.warn("tiles unavailable: " + f.message);
				if (k) k.zerstoere();
				return null;
			}
			return k;
		}
		function kachelnAus() { kachelnArt = "aus"; debug.kacheln.an = false; }
		function kachelnBeiBedarf() {
			if (kachelnArt !== "wartet") return;
			kachelnArt = "anlegen";
			erzeugeKacheln().then(function (k) {
				if (!k || !laeuft) { if (k) k.zerstoere(); kachelnAus(); return; }
				kacheln = k;
				kachelnArt = "da";
				texturSatz.kacheln = k.textur;
				erde.setzeTexturen(texturSatz);
			}, function (e) {
				console.warn("tiles unavailable: " + (e && e.message ? e.message : e));
				kachelnAus();
			});
		}

		// ---- Canvas-Groesse, MSAA-Farbe und Tiefe
		var cssGroesse = null, dpr = 1;
		var msaa = null, msaaView = null, tiefe = null, tiefeView = null;
		if (typeof ResizeObserver === "function") {
			new ResizeObserver(function (eintraege) {
				var r = eintraege[eintraege.length - 1].contentRect;
				cssGroesse = [r.width, r.height];
			}).observe(canvas);
		} else {
			window.addEventListener("resize", function () { cssGroesse = null; });
		}
		// Task 19 (M5): MSAA-Farbe und Tiefe (bei 3840 x 2160 je 133 MB, mit DPR 2 auf
		// 4K je 530 MB) in einem out-of-memory-Bereich anlegen. Scheitert die Anlage,
		// sinkt die DPR-Obergrenze (2 -> 1, darunter halbiert bis DPR_MIN), die
		// Puffer werden im naechsten Bild kleiner neu angelegt und die Tafel zeigt
		// "reduced resolution". Scheitert es auch bei DPR_MIN: Hinweis, Schleife
		// stoppt (sonst meldete jedes Bild einen Validierungsfehler). Das Ergebnis
		// kommt asynchron; bis dahin wird mit den neuen Puffern gezeichnet. Nur die
		// letzte Anlage zaehlt (pufferNr). ?render=oom: die erste Anlage gilt als
		// gescheitert (Pruefpfad).
		var DPR_MAX = 2, DPR_MIN = 0.5;
		var dprGrenze = DPR_MAX, aufloesungReduziert = false, pufferNr = 0;
		var renderOom = new URLSearchParams(window.location.search).get("render") === "oom";
		function pufferGescheitert(nr, b, h, f) {
			if (nr !== pufferNr || !laeuft) return;                    // inzwischen neu angelegt
			var neu = dpr > 1 ? 1 : dpr / 2;
			if (msaa) msaa.destroy();
			if (tiefe) tiefe.destroy();
			msaa = null; tiefe = null;                               // naechstes Bild legt neu an
			if (neu < DPR_MIN) {
				console.error("render buffers unavailable at " + b + "x" + h + ": " + meldung(f));
				zeigeHinweis("Not enough GPU memory to render this view.");
				laeuft = false;
				return;
			}
			console.warn("render buffers unavailable at " + b + "x" + h + " (" + meldung(f) + "); device pixel ratio " + dpr + " -> " + neu);
			dprGrenze = neu;
			aufloesungReduziert = true;
		}
		function passeGroesseAn() {
			dpr = Math.min(window.devicePixelRatio || 1, dprGrenze);
			if (!cssGroesse) cssGroesse = [canvas.clientWidth, canvas.clientHeight];
			var max = device.limits.maxTextureDimension2D;
			var b = Math.max(1, Math.min(max, Math.floor(cssGroesse[0] * dpr)));
			var h = Math.max(1, Math.min(max, Math.floor(cssGroesse[1] * dpr)));
			if (msaa && canvas.width === b && canvas.height === h) return;
			canvas.width = b; canvas.height = h;
			if (msaa) msaa.destroy();
			if (tiefe) tiefe.destroy();
			var nr = ++pufferNr;
			device.pushErrorScope("out-of-memory");
			msaa = device.createTexture({ label: "msaa farbe", size: [b, h], sampleCount: 4, format: format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
			tiefe = device.createTexture({ label: "tiefe", size: [b, h], sampleCount: 4, format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
			device.popErrorScope().then(function (f) {
				if (!f && renderOom) { renderOom = false; f = { message: "simulated out-of-memory (?render=oom)" }; }
				if (f) pufferGescheitert(nr, b, h, f);
			}, function (e) { console.warn("render buffer check failed: " + meldung(e)); });
			msaaView = msaa.createView();
			tiefeView = tiefe.createView();
		}

		// ---- Ebenen in Zeichenreihenfolge. Folgetasks haengen hier ein:
		//   aktiv(b) entscheidet je Bild, tiefe: true = Tiefen-Attachment (Loeschen auf 0).
		//   Die letzte aktive Ebene loest das MSAA auf die Canvas-Textur auf.
		var ebenen = [
			{
				name: "himmel", tiefe: false,
				aktiv: function () { return !!himmel; },
				zeichne: function (pass, b) {
					himmel.zeichne(pass, b.m.himmel, {
						koerper: b.koerper,                                   // Task 16: Sonne + Planeten als Scheiben
						grenzMag: grenzMag,
						dpr: dpr,
						viewportPx: [canvas.width, canvas.height]
					});
				}
			},
			{
				// Task 7/8: Erde, Wolken, Atmosphaere, Mond; Bahn-/Bodenspur, Sichtkreis, Marker
				name: "welt", tiefe: true,
				aktiv: function () { return !!(erde || spur); },
				zeichne: function (pass, b) {
					if (erde) erde.zeichne(pass, b.m.welt, {
						sonne: b.sonne.richtung, gmst: b.gmst, mondPositionR: b.mond.position, zeitSek: b.ms / 1000,
						schalter: { wolken: schalter.wolken, atmosphaere: schalter.atmosphaere, nachtlichter: schalter.nachtlichter },
						kacheln: kacheln ? kacheln.tabelle() : null,          // Task 15b
						kachelnVersion: kacheln ? kacheln.version : 0         // Tabelle nur bei Aenderung schreiben
					});
					// issPositionR ist null bei ungueltiger Station: dann kein Marker, kein Sichtkreis.
					// jd: Grenze vergangen/kommend folgt der Station zwischen zwei Neuberechnungen;
					// dpr/viewportPx wie beim Himmel (Marker 14 CSS-Pixel).
					if (spur) spur.zeichne(pass, b.m.welt, {
						gmst: b.gmst, jd: b.jd, issPositionR: b.iss.positionR, markerAlpha: b.markerAlpha,
						nachbarAlpha: b.nachbarAlpha,                         // Task 12b: Nachbarrunden im Folgen-Modus gedaempft
						dpr: dpr, viewportPx: [canvas.width, canvas.height],
						schalter: { bahn: schalter.bahn, boden: schalter.boden, kreis: schalter.kreis }
					});
				}
			},
			{
				// Task 10: ISS-Modell in Metern; b.modellSichtbar und b.issLicht setzt Task 10
				name: "iss", tiefe: true,
				aktiv: function (b) { return !!issZeichner && b.modellSichtbar; },
				zeichne: function (pass, b) { issZeichner.zeichne(pass, b.m.iss, b.issLicht); }
			}
		];

		function zeichneBild(b) {
			var aktiv = [];
			for (var i = 0; i < ebenen.length; i++) if (ebenen[i].aktiv(b)) aktiv.push(ebenen[i]);
			var encoder = device.createCommandEncoder({ label: "bild" });
			var ziel = context.getCurrentTexture().createView();
			var n = Math.max(1, aktiv.length);                       // ohne Ebene: nur loeschen und aufloesen
			for (var k = 0; k < n; k++) {
				var ebene = aktiv[k] || null, letzte = k === n - 1;
				var farbe = {
					view: msaaView,
					loadOp: k === 0 ? "clear" : "load",
					clearValue: HINTERGRUND,
					storeOp: letzte ? "discard" : "store"                // nach dem Aufloesen wird MSAA nicht mehr gebraucht
				};
				if (letzte) farbe.resolveTarget = ziel;
				var d = { label: ebene ? ebene.name : "leer", colorAttachments: [farbe] };
				if (ebene && ebene.tiefe) {
					d.depthStencilAttachment = { view: tiefeView, depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "discard" };
				}
				var pass = encoder.beginRenderPass(d);
				if (ebene) ebene.zeichne(pass, b);
				pass.end();
			}
			device.queue.submit([encoder.finish()]);
		}

		// ---- HUD
		var el = {
			live: $("tLive"), bahn: $("tBahn"), warnung: $("tWarnung"), utc: $("tUtc"), lokal: $("tLokal"),
			bLive: $("bLive"), bPause: $("bPause"), b10: $("b10"), b100: $("b100"),
			kErde: $("kErde"), kFolgen: $("kFolgen"), kBlick: $("kBlick"), kErdfest: $("kErdfest"), kRaumfest: $("kRaumfest")
		};
		var warnSchluessel = null;
		function hud(b) {
			setzeText(el.utc, window.Zeit.formatUTC(b.ms));
			setzeText(el.lokal, window.Zeit.formatLokal(b.ms));
			setzeText(el.live, zeitZeile(uhr));
			setzeGedrueckt(el.bLive, uhr.istLive());
			setzeGedrueckt(el.bPause, uhr.rate === 0);
			setzeGedrueckt(el.b10, uhr.rate === 10);
			setzeGedrueckt(el.b100, uhr.rate === 100);
			setzeGedrueckt(el.kErde, kamera.modus === "erde");
			setzeGedrueckt(el.kFolgen, kamera.modus === "folgen");
			setzeGedrueckt(el.kBlick, kamera.modus === "blick");
			setzeGedrueckt(el.kErdfest, kamera.rahmen === "erdfest");
			setzeGedrueckt(el.kRaumfest, kamera.rahmen === "raumfest");
			if (el.kFolgen.disabled === issGueltig) el.kFolgen.disabled = !issGueltig;

			// Alter der Bahndaten nach Simulationszeit (Spec 4.2: jd - Epoche in Tagen):
			// massgeblich ist, wie weit SGP4 fuer das gezeigte Bild extrapoliert.
			var alterTage = (b.ms - epocheMs) / 86400000;
			if (isFinite(alterTage)) {
				setzeText(el.bahn, "orbit data from " + new Date(epocheMs).toISOString().slice(0, 10) + ", " + alterText(alterTage));
			} else {
				setzeText(el.bahn, "orbit data unknown");
			}

			// Warnungen: Tafel (Bahn) und trackerDebug (alle)
			var tafel = [], alle;
			if (!satrec || !b.iss.gueltig) tafel.push("orbit data unusable");
			if (isFinite(alterTage) && alterTage >= WARN_ALTER_TAGE) {
				tafel.push("orbit data is " + Math.floor(alterTage) + " days old; position may be off by tens of kilometres");   // Spec-Wortlaut (Task 12c)
			}
			if (vorschauFehlt && erde && erde.modus === "ersatz") tafel.push("textures failed to load");
			// Task 19 (M10): grosse Tagkarte gescheitert, nur die 1024er-Vorschau blieb
			if (tagReduziert && erde && erde.modus === "vorschau") tafel.push("reduced texture quality");
			if (aufloesungReduziert) tafel.push("reduced resolution");   // Task 19 (M5)
			alle = tafel.slice();
			if (sterneFehlen) alle.push("star catalog unavailable");
			var schluessel = alle.join("|");
			if (schluessel !== warnSchluessel) {
				warnSchluessel = schluessel;
				debug.warnungen = alle;
				setzeText(el.warnung, tafel.join(" · "));
				el.warnung.hidden = tafel.length === 0;
			}
		}

		// ---- Task 10/12a/12b: Stationsmodell je Bild - Stationssystem, Licht, Sichtbarkeit.
		// Das Modell ist opak und sichtbar naeher als MODELL_AB_KM, nie hinter der
		// Erde. Marker/Modell-Uebergang (Task 12b):
		//   - markerZiel = smoothstep(MARKER_AUS_KM, MARKER_EIN_KM, Ist-Distanz): voll ab
		//     20 km, aus unter 5 km (Modell dort 4-17 px). Beim Flug Erde -> Folgen
		//     bleibt der Marker bis ~1,18 s voll (Kamera-Smoothstep), das Modell
		//     steht dann schon; beim Rueckflug ist das Modell nach ~60 ms subpixel.
		//   - markerAlpha folgt dem Ziel hoechstens mit 1/MARKER_BLENDE_AUS_S je
		//     Sekunde nach unten (Ueberblendung ueber dem Modell) bzw. mit
		//     1/MARKER_BLENDE_EIN_S nach oben (Einblendung des Markers, Task 12c).
		//   - Das Modell wird auch jenseits MODELL_AB_KM gezeichnet, solange der
		//     Marker noch blendet (Rueckflug: sonst kurz nichts zu sehen).
		//   - Die Positionslicht-Sprites (iss.js) gibt es nur unter MARKER_EIN_KM:
		//     weiter weg lagen beide 4-px-Sprites uebereinander als weisser Punkt
		//     und fuellten das Loch der 12a-Rampe (Pruefbefund A5).
		// Sonnen- und Erdrichtung gehen im Stationssystem an den Zeichner; die
		// Erdrichtung ist dort (0, 0, -1), hier der Klarheit halber mitgerechnet.
		// Task 12c: Ergebnis- und Lichtobjekt samt Richtungsarrays einmal angelegt
		// und je Bild ueberschrieben (gelesen wird nur im selben Bild; trackerDebug
		// kopiert Zahlen bzw. haelt das Array, das der Pruefstand als Wert liest).
		var markerAlpha = 1;
		var stationErgebnis = { sichtbar: false, markerAlpha: 1, licht: null, imSchatten: null, erdschein: null, solarWinkel: null, alpha: null, sonneStation: null };
		var stationLicht = { stationssystem: null, sonneRichtungStation: [0, 0, 1], erdRichtungStation: [0, 0, -1], imSchatten: 0,
		                     erdscheinStaerke: 0, solarWinkel: 0, dpr: 1, viewportPx: [1, 1], zeitSek: 0, lichter: false };
		var erdRichtungEci = [0, 0, -1];
		function stationsBild(iss, sonne, dt, ms) {
			var s = stationErgebnis, L = stationLicht;
			s.sichtbar = false; s.markerAlpha = 1; s.licht = null; s.imSchatten = null; s.erdschein = null;
			s.solarWinkel = null; s.alpha = null; s.sonneStation = null;
			if (!issZeichner || !iss.gueltig) { markerAlpha = 1; return s; }
			var sys = window.Kamera.bahnsystem(iss);                   // {seite, vorn, oben}, Task 12c
			var so = sonne.richtung, oben = sys.oben;
			var sonneStation = insStationssystem(so, sys, L.sonneRichtungStation);
			var distKm = kamera.distanzKm();
			var markerZiel = isFinite(distKm) ? smoothstep(MARKER_AUS_KM, MARKER_EIN_KM, distKm) : 1;
			var schritt = Math.max(0, dt) / (markerZiel > markerAlpha ? MARKER_BLENDE_EIN_S : MARKER_BLENDE_AUS_S);
			markerAlpha += Math.max(-schritt, Math.min(schritt, markerZiel - markerAlpha));
			s.imSchatten = erdschatten(iss.positionR, so);
			s.erdschein = ERDSCHEIN_GRUND + (1 - ERDSCHEIN_GRUND) * Math.max(dot3(oben, so), 0);
			// Fluegelnormale (0, sin w, cos w) im Stationssystem zeigt zur Sonne (iss.js dreht so)
			s.solarWinkel = Math.atan2(sonneStation[1], sonneStation[2]);
			s.sonneStation = sonneStation;
			s.markerAlpha = markerAlpha;
			// Auch waehrend der Marker noch blendet zeichnen: beim Flug zurueck zur
			// Erde ist das Modell sonst nach ~0,1 s (200 km) weg, der Marker aber erst
			// nach 1,2 s da. Jenseits 200 km ist es ein Subpixel unter dem Marker.
			s.sichtbar = isFinite(distKm) && (distKm < MODELL_AB_KM || markerAlpha < 1) && !kamera.stationVerdeckt(iss.positionR);
			s.alpha = s.sichtbar ? 1 : 0;                          // Modell opak (Pruefstand: 1 = gezeichnet)
			erdRichtungEci[0] = -oben[0]; erdRichtungEci[1] = -oben[1]; erdRichtungEci[2] = -oben[2];
			L.stationssystem = sys;
			insStationssystem(erdRichtungEci, sys, L.erdRichtungStation);
			L.imSchatten = s.imSchatten;
			L.erdscheinStaerke = s.erdschein;
			L.solarWinkel = s.solarWinkel;
			L.dpr = dpr;
			L.viewportPx[0] = canvas.width; L.viewportPx[1] = canvas.height;
			L.zeitSek = ms / 1000;
			L.lichter = distKm < MARKER_EIN_KM;                    // Task 12b: Sprites nur unter 20 km
			s.licht = L;
			return s;
		}

		// ---- Task 11: Labels je Bild. Reihenfolge = Rang bei gleicher Prioritaet
		// (Spec 5.7: ISS, Mond, Sonne, Planeten). radiusPx haelt das Objekt frei:
		// Marker 14 px, Mondscheibe nach Abstand und Sichtfeld, Sonnenkern, Planet.
		// Bei sichtbarem Modell rueckt das ISS-Label um dessen Bildradius nach oben.
		// Task 19 (I1): der Bildradius des Modells ist fuer die Labels auf
		// MODELL_LABEL_ANTEIL der kurzen Bildkante gedeckelt - ungedeckelt (bei
		// 0,08 km und 720p 655 px) war der Kreis ein Hindernis fuer alle Labels und
		// unter ~0,12 km verschwanden sie samt ISS-Label. Die Labels duerfen in der
		// Nahaufnahme also auf dem Modell liegen; das ISS-Label steht ueber dem
		// gedeckelten Kreis. Die Doppeltipp-Trefferzone (tippZiel) bleibt ungedeckelt.
		function labelListe(b, kp, cssB, cssH) {
			var liste = [], f = b.m.welt.proj[5], i;                 // f = 1 / tan(fov/2)
			if (b.iss.gueltig) {
				var r = MARKER_RADIUS_PX, oben = false;
				if (b.modellSichtbar) {
					r = Math.max(MARKER_RADIUS_PX, Math.min(modellRadiusPx(kamera.distanzKm(), f, cssH), MODELL_LABEL_ANTEIL * Math.min(cssB, cssH)));
					oben = true;
				}
				liste.push({ id: "iss", text: issText(b.iss), position: b.iss.positionR, prioritaet: 1, radiusPx: r, oben: oben, klick: folgen });
			}
			if (b.mond) {
				var mp = b.mond.position, dKm = Math.hypot(mp[0] - kp[0], mp[1] - kp[1], mp[2] - kp[2]) * R_KM;
				liste.push({ id: "moon", text: mondText(b.mond), position: mp, prioritaet: 2,
				             radiusPx: Math.max(4, MOND_RADIUS_KM / dKm * f * cssH / 2), klick: klickHimmel("moon") });
			}
			if (b.sonne) {
				liste.push({ id: "sun", text: "Sun · " + (b.sonne.abstandAE * LICHTMINUTEN_JE_AE).toFixed(1) + " light-min",
				             richtung: b.sonne.richtung, prioritaet: 2, radiusPx: SONNE_LABEL_RADIUS_PX, klick: klickHimmel("sun") });
			}
			for (i = 0; i < b.planeten.length; i++) {
				var p = b.planeten[i];
				if (p.verdeckt) continue;                              // kein Punkt -> kein Label
				var n = p.name.toLowerCase();
				// Task 16: halbe Scheibe frei halten, bei Saturn den Ring
				var rp = (p.groessePx || PLANET_MIN_PX) / 2 * (p.name === "Saturn" ? SATURN_RING_FAKTOR : 1);
				liste.push({ id: n, text: p.name + " · " + Math.round(p.abstandAE * LICHTMINUTEN_JE_AE) + " light-min",
				             richtung: p.richtung, prioritaet: 3, radiusPx: rp, klick: klickHimmel(n) });
			}
			return liste;
		}
		// Ziel fuer den Doppeltipp: Station im Bild (CSS-Pixel), wenn Marker oder
		// Modell zu sehen sind; Trefferkreis 24 px oder der Bildradius des Modells.
		function tippZiel(b, cssB, cssH) {
			var m = b.m.welt;
			tipp.view = m.view; tipp.proj = m.proj; tipp.pos = m.pos; tipp.breite = cssB; tipp.hoehe = cssH; tipp.gmst = b.gmst;
			tipp.markerPx = null; tipp.trefferPx = TIPP_RADIUS_PX;
			if (!b.iss.gueltig || !window.Labels) return;
			var zuSehen = b.modellSichtbar || (b.markerAlpha > 0 && !kamera.stationVerdeckt(b.iss.positionR));
			// kamerarelativ projizieren (Task 12b): in double genau auch bei 50 m Abstand
			var p = b.iss.positionR, kp = m.pos;
			var pm = window.Labels.projiziere(m.viewProjRel, [p[0] - kp[0], p[1] - kp[1], p[2] - kp[2]], cssB, cssH);
			if (!zuSehen || !pm.vorne) return;
			tipp.markerPx = [pm.x, pm.y];
			if (b.modellSichtbar) tipp.trefferPx = Math.max(TIPP_RADIUS_PX, modellRadiusPx(kamera.distanzKm(), m.proj[5], cssH));
		}

		// ---- Task 16: Koerper-Liste fuer himmel.js (Sonne + 5 Planeten), Objekte
		// einmal angelegt und je Bild ueberschrieben (keine Allokation je Bild ausser
		// den Vektoren aus phasenLicht). hell: Sonne = sonneSicht (Blende am Erdrand),
		// Planet 1 oder 0 (verdeckt). Der Pruefstand sieht name/groessePx/anteil.
		var koerper = [], koerperDebug = [], phasen = [];
		for (var ki = 0; ki < 6; ki++) {
			koerper.push({ art: 0, name: "", richtung: [1, 0, 0], groessePx: PLANET_MIN_PX, hell: 0, licht: null });
			koerperDebug.push({ name: "", groessePx: 0, anteil: 1, hell: 0, sichtbar: false });
		}
		debug.himmel.koerper = koerperDebug;
		// phasenLicht nur, wenn Sonne oder Planeten neu gerechnet wurden (alle 10 s
		// bzw. 60 s Simulationszeit): die Objekte werden dann ersetzt, Identitaet reicht.
		var phasenSonne = null, phasenPlaneten = null;
		function koerperBild(sonne, sonneSicht, planeten) {
			var s = koerper[0], sd = koerperDebug[0], i;
			s.art = 0; s.name = "Sun"; s.richtung = sonne.richtung; s.groessePx = SONNE_KERN_PX; s.hell = sonneSicht; s.licht = null;
			sd.name = "Sun"; sd.groessePx = SONNE_KERN_PX; sd.anteil = 1; sd.hell = sonneSicht; sd.sichtbar = sonneSicht > 0;
			if (sonne !== phasenSonne || planeten !== phasenPlaneten) {
				phasenSonne = sonne; phasenPlaneten = planeten;
				for (i = 0; i < 5; i++) phasen[i] = planeten[i] ? window.Himmel.phasenLicht(planeten[i], sonne) : null;
			}
			for (i = 0; i < 5; i++) {
				var p = planeten[i], k = koerper[i + 1], kd = koerperDebug[i + 1], ph = phasen[i];
				if (!p || !ph) { k.hell = 0; kd.name = ""; kd.sichtbar = false; continue; }
				k.art = KOERPER_ART[p.name] || 0; k.name = p.name; k.richtung = p.richtung;
				k.groessePx = p.groessePx; k.hell = p.verdeckt ? 0 : 1; k.licht = ph.lichtWelt;
				kd.name = p.name; kd.groessePx = p.groessePx; kd.anteil = ph.anteil; kd.hell = k.hell; kd.sichtbar = !p.verdeckt;
			}
			return koerper;
		}

		// ---- Schleife
		var letzteT = null, fpsBilder = 0, fpsZeit = 0;
		var sonne = null, sonneJd = null, mond = null, planeten = [], planetenJd = null, spurJd = null, spurEchtMs = 0, jdVorher = null;
		var letzterFehler = null;
		var nachbarAlpha = 1;                                    // Task 12b: Faktor der Nachbarrunden (1 Erde, NACHBAR_ALPHA Folgen)
		var pauseMs = null;                                      // Task 12c: gehaltene Simulationszeit in der Pause (ms), sonst null

		// Task 19 (M1): verborgener Tab. Im Zeitraffer haelt die Uhr an (zeit.js
		// anhalten: die Simulationszeit steht, Rate und Anzeige bleiben) und laeuft
		// beim Zurueckkommen vom selben Punkt weiter; das erste Bild danach bekommt
		// dt 0 (letzteT = null), die Wartezeit fliesst nirgends ein. Live (Rate 1)
		// folgt ohnehin Date.now, die Pause haelt ohnehin - dort tut anhalten nichts.
		// Der Deckel in Uhr.schritt (Rate x 1 s je Schritt) faengt den Rest ab, z. B.
		// eine gedrosselte, aber sichtbare Einbettung.
		document.addEventListener("visibilitychange", function () {
			if (document.hidden) uhr.anhalten();
			else { uhr.fortsetzen(); letzteT = null; }
		});

		function bild(t) {
			if (!laeuft) return;
			try {
				// dt aus den rAF-Zeitstempeln; die Uhr bekommt es ungedeckelt (sie deckelt
				// im Zeitraffer selbst, zeit.js), die Kamera hoechstens 0,1 s.
				var dtEchtMs = letzteT === null ? 0 : Math.max(0, t - letzteT);
				letzteT = t;
				uhr.schritt(dtEchtMs);
				var dt = Math.min(dtEchtMs / 1000, 0.1);

				var ms = uhr.jetztMs();
				// Pause (Befund Task 12c): jetztMs liest Date.now, schritt bekommt die
				// rAF-Abstaende - beide laufen um +-1 ms auseinander, die Simulationszeit
				// zitterte in der Pause um die Haltezeit. tJetzt der Spur wechselte dabei
				// das Vorzeichen, und das erste Bahnsegment vor der Station sprang
				// zwischen 2,0 und 1,5 px (Flackern in der Folgen-Ansicht). In der Pause
				// gilt deshalb die gehaltene Zeit, bis sie um mehr als PAUSE_SPRUNG_MS
				// abweicht (Sprung: Now, Pruefstand).
				if (uhr.rate === 0) {
					if (pauseMs === null || Math.abs(ms - pauseMs) > PAUSE_SPRUNG_MS) pauseMs = ms;
					ms = pauseMs;
				} else pauseMs = null;
				var jd = window.Zeit.jd(ms), gmst = window.Zeit.gmst(jd);
				if (sonneJd === null || Math.abs(jd - sonneJd) * 86400 >= SONNE_ALLE_S) {
					sonne = window.Himmel.sonne(jd);
					mond = window.Himmel.mond(jd);
					sonneJd = jd;
				}
				if (planetenJd === null || Math.abs(jd - planetenJd) * 86400 >= PLANETEN_ALLE_S) {
					planeten = window.Himmel.planeten(jd);
					planetenJd = jd;
				}
				himmelsDaten.sonne = sonne; himmelsDaten.mond = mond; himmelsDaten.planeten = planeten;
				// Sichtbarkeit der Planeten einmal je Bild (Grenzmagnitude kann sich aendern):
				// verdeckt = true blendet den Punkt in himmel.js aus und unterdrueckt das Label.
				var kompaktAn = !!(kompakt && kompakt.matches);
				for (var pi = 0; pi < planeten.length; pi++) {
					planeten[pi].verdeckt = !planetSichtbar(planeten[pi], grenzMag);
					planeten[pi].groessePx = planetGroessePx(planeten[pi].magnitude, kompaktAn);   // Task 16
				}

				var iss = berechneIss(satrec, jd, gmst);
				issGueltig = iss.gueltig;
				kamera.schritt(dt, iss.gueltig ? { gueltig: true, positionR: iss.positionR, geschwindigkeitRproS: iss.geschwindigkeitRproS } : null, gmst);
				// Task 8/12a: Spuren nach echter Zeit (rAF-Zeitstempel = performance.now)
				// oder bei einem Zeitsprung gegenueber dem vorigen Bild
				var sprung = jdVorher !== null && Math.abs(jd - jdVorher) * 86400 > SPUR_SPRUNG_S;
				jdVorher = jd;
				// Das feine Fenster zaehlt nur, wenn man nah genug ist, es zu sehen (Folgen
				// oder unter SPUR_FEIN_AB_KM); in der Erde-Ansicht bliebe es bei x100 sonst
				// bei 6 statt 2-3 Rechnungen je 5 s (Fix-Runde 1).
				var feinNoetig = spurJd !== null && (kamera.modus === "folgen" || kamera.distanzKm() < SPUR_FEIN_AB_KM) &&
				                 Math.abs(jd - spurJd) * 86400 > SPUR_FEIN_S;
				if (spur && satrec && (spurJd === null || t - spurEchtMs >= SPUR_ALLE_MS_ECHT || sprung || feinNoetig)) {
					spur.aktualisiere(satrec, jd);
					spurJd = jd;
					spurEchtMs = t;
				}

				// Task 15b: Detailkacheln nach Fusspunkt der Station (rad) und Kameradistanz;
				// im Folgen-Modus immer (auch waehrend des Uebergangs aus der Ferne).
				// Laedt hoechstens eine Kachel je Aufruf, bewertet alle 2 s neu.
				// Task 19 (M4): beim ersten Bedarf erst das Array anlegen (asynchron;
				// geladen wird ab dem Bild, in dem es da ist).
				if (kachelnArt === "wartet" && iss.gueltig && (kamera.modus === "folgen" || kamera.distanzKm() < KACHELN_AB_KM)) kachelnBeiBedarf();
				if (kacheln && iss.gueltig) kacheln.aktualisiere(iss.lat / GRAD, iss.lon / GRAD, kamera.distanzKm(), t, kamera.modus === "folgen");

				passeGroesseAn();
				var m = kamera.matrizen(canvas.width / canvas.height);
				// Winkelradius der Sonnenblende aus der Projektion: tan = px / (h/2) / f
				var haloWinkel = Math.atan(SONNE_BLENDE_PX * dpr / (canvas.height / 2) / m.himmel.proj[5]);
				var station = stationsBild(iss, sonne, dt, ms);           // Task 10/12a
				var sonneSicht = sonneSichtbarkeit(m.welt.pos, sonne.richtung, haloWinkel);
				// Task 12b: Nachbarrunden der Bahn im Folgen-Modus daempfen, Faktor
				// laeuft ueber NACHBAR_BLENDE_S (= Uebergangsdauer der Kamera); Task 12c:
				// ebenso naeher als NACHBAR_AB_KM an der Station (Erde-Ansicht bei 1,2 R)
				var nachbarZiel = kamera.modus === "folgen" || kamera.distanzKm() < NACHBAR_AB_KM ? NACHBAR_ALPHA : 1;
				var nachbarSchritt = dt / NACHBAR_BLENDE_S * (1 - NACHBAR_ALPHA);
				nachbarAlpha += Math.max(-nachbarSchritt, Math.min(nachbarSchritt, nachbarZiel - nachbarAlpha));
				var b = {
					ms: ms, jd: jd, gmst: gmst, m: m, iss: iss,
					sonne: sonne, mond: mond, planeten: planeten,
					sonneSicht: sonneSicht,
					koerper: koerperBild(sonne, sonneSicht, planeten),      // Task 16
					modellSichtbar: station.sichtbar,
					markerAlpha: station.markerAlpha,
					nachbarAlpha: nachbarAlpha,
					issLicht: station.licht
				};
				zeichneBild(b);
				hud(b);

				// Task 11: Labels (CSS-Pixel; #labels deckt wie der Canvas das ganze Fenster)
				kameraPos = m.welt.pos;
				var cssB = cssGroesse[0], cssH = cssGroesse[1];
				tippZiel(b, cssB, cssH);
				if (labelEbene && schalter.labels) {
					messeSperren(t);
					labelEbene.setze(labelListe(b, m.welt.pos, cssB, cssH));
					// Task 12c: Positionen kamerarelativ (viewProjRel, kameraPos in double) -
					// die absolute float32-viewProj liess das ISS-Label unter 0,2 km springen
					var lr = labelEbene.aktualisiere({
						viewProj: m.welt.viewProj, viewProjRel: m.welt.viewProjRel,
						viewRot: m.himmel.viewRot, proj: m.himmel.proj, kameraPos: m.welt.pos,
						breite: cssB, hoehe: cssH, sperren: sperren, zeitMs: t
					});
					debug.labels = { anzahl: lr.sichtbar, kollisionen: lr.kollisionen, liste: lr.liste, entfallen: lr.entfallen };
				} else if (debug.labels.anzahl !== 0 || debug.labels.kollisionen !== 0) {
					debug.labels = { anzahl: 0, kollisionen: 0, liste: [], entfallen: [] };
				}

				fpsBilder++; fpsZeit += dtEchtMs;
				if (fpsZeit >= 500) { debug.fps = Math.round(fpsBilder * 1000 / fpsZeit); fpsBilder = 0; fpsZeit = 0; }

				debug.bilder++;
				debug.groesse = [canvas.width, canvas.height];
				debug.dpr = dpr;                                         // Task 19 (M5): wirksame DPR (nach einem OOM-Rueckfall kleiner)
				debug.zeit.jd = jd; debug.zeit.utc = window.Zeit.formatUTC(ms);
				debug.zeit.rate = uhr.rate; debug.zeit.versatzMs = uhr.versatzMs; debug.zeit.istLive = uhr.istLive();
				debug.iss.gueltig = iss.gueltig;
				debug.iss.lat = iss.gueltig ? iss.lat : null;
				debug.iss.lon = iss.gueltig ? iss.lon : null;
				debug.iss.hoehe = iss.gueltig ? iss.hoehe : null;
				debug.iss.v = iss.gueltig ? iss.v : null;
				var dist = kamera.distanzKm();
				debug.kamera.modus = kamera.modus; debug.kamera.rahmen = kamera.rahmen;
				debug.kamera.distanzKm = isFinite(dist) ? dist : null;
				debug.modellSichtbar = b.modellSichtbar;
				debug.iss.imSchatten = station.imSchatten; debug.iss.erdschein = station.erdschein;
				debug.iss.solarWinkel = station.solarWinkel; debug.iss.alpha = station.alpha;
				debug.iss.sonneStation = station.sonneStation; debug.iss.markerAlpha = station.markerAlpha;   // Task 12a
				debug.texturen = erde ? erde.modus : null;
				if (klang) { debug.klang.zustand = klang.zustand(); debug.klang.lautstaerke = Math.round(klang.lautstaerke() * 1000) / 1000; debug.klang.wunsch = klang.wartet(); }
				// Task 15b: Kachelstand nur bei Aenderung neu (status() allokiert)
				if (kacheln && kacheln.version !== kachelnVersion) {
					kachelnVersion = kacheln.version;
					var ks = kacheln.status();
					ks.an = true;
					ks.angelegt = true;                              // Task 19 (M4)
					debug.kacheln = ks;
				}
				if (himmel) { debug.himmel.sonneSichtbar = himmel.sonneSichtbar; debug.himmel.planeten = himmel.planetenSichtbar; }
				if (spur) {
					debug.spur.punkte = spur.punkte; debug.spur.berechnungen = spur.berechnungen; debug.spur.nachbarAlpha = nachbarAlpha;
					debug.spur.markerPx = spur.markerPx ? [spur.markerPx[0] / dpr, spur.markerPx[1] / dpr] : null;
				}
			} catch (e) {
				// Einmal melden, nicht jedes Bild; die Schleife laeuft weiter.
				var text = e && e.message ? e.message : String(e);
				if (text !== letzterFehler) { letzterFehler = text; console.error("ISS Tracker frame: " + text); }
			}
			requestAnimationFrame(bild);
		}
		requestAnimationFrame(bild);
	}

	// Task 12c (A4): Ausnahmen nach dem Geraetestart (Laden, Aufbau) sind keine
	// fehlende WebGPU-Unterstuetzung - den echten Grund zeigen. Ohne WebGPU bzw.
	// bei gescheitertem requestDevice meldet gpu.js selbst (starte liefert null).
	main().catch(function (e) {
		console.error("ISS Tracker start failed: " + meldung(e));
		zeigeHinweis("Start failed: " + meldung(e));
	});
})();
