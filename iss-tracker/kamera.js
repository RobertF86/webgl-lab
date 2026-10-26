/*
 * ISS Tracker - Kamera: Modi, Uebergaenge, Eingabe, Matrizen je Ebene
 *
 * Drei Modi:
 *   erde    Orbit um den Erdmittelpunkt (Azimut, Hoehe, Distanz in R).
 *           Rahmen 'erdfest' (Kamera dreht mit der Erde: Position = Rz(gmst)
 *           * P(az, hoehe, dist)) oder 'raumfest' (ECI).
 *   folgen  Kamera im Bahnsystem der Station: oben = radial, vorn = Flug-
 *           richtung, seite = vorn x oben; (Azimut, Hoehe, Distanz in km),
 *           Blick auf die Station, Horizont waagerecht.
 *   blick   Position bleibt, nur Gier/Nick (Richtung in ECI) und Sichtfeld.
 *
 * Zustand: die oeffentlichen Felder erde/folgen/blick/fov sind Sollwerte
 * (Eingabe und Anwendung schreiben sie), die Istwerte laufen mit Zeitkonstante
 * 150 ms hinterher und liefern die Matrizen. Ein Moduswechsel blendet Position
 * und Blickziel 1,2 s mit Smoothstep im Raum ueber; war der alte Modus
 * 'folgen', laeuft der eingefrorene Versatz im Bahnsystem der Station mit.
 *
 * Koordinaten: Welt = ECI in Erdradien R (+Z Nordpol, +X Fruehlingspunkt),
 * ISS-Ebene in Metern um die Stationsmitte, Himmel nur Drehung.
 * Matrizen: Float32Array(16), spaltenweise, aus GPU.mat4 (gpu.js zuerst laden).
 * Die Welt-Ebene zeichnet kamerarelativ (Task 12b): welt.viewRel/viewProjRel
 * haben die Kamera im Ursprung, die Zeichner ziehen welt.pos in double ab.
 *
 * Kamera.neu(null) registriert keine Ereignisse - so laeuft der Test in Node.
 * Kamera.bahnsystem(iss) (Task 12c) ist das Stationssystem, das auch tracker.js
 * fuer das Modell nutzt. Das Startbild (ueber der Station, Anfahrt 5 -> 3,2 R,
 * hochkant weiter bis die Erde in die Bildbreite passt: Kamera.startDistanz, Task 19)
 * kommt beim ersten gueltigen Stationszustand, aber nicht mehr, wenn der Nutzer
 * vorher gezogen, gezoomt oder eine Pfeiltaste gedrueckt hat.
 */
(function (window) {
	"use strict";

	var R_M = 6378137;                                  // Erdradius in Metern (= 1 R); distanzKm nutzt R_M / 1000
	var GRAD = Math.PI / 180;
	var TAU_GLAETTUNG = 0.15, TAU_REIBUNG = 0.4;        // Sekunden
	var SCHWUNG_MAX = 6;                                // rad/s; ein Wisch traegt hoechstens 6 * 0.4 = 2,4 rad weit
	var DAUER_UEBERGANG = 1.2, DAUER_ANFAHRT = 2;       // Sekunden
	var FOV_QUER = 50 * GRAD, FOV_HOCH = 60 * GRAD;
	var HOEHE_MAX = 89 * GRAD;
	var ERDE_DIST = [1.2, 12], FOLGEN_DIST = [0.05, 5000], FOV_BEREICH = [5 * GRAD, 70 * GRAD];
	var ANFAHRT_VON = 5, ANFAHRT_NACH = 3.2;
	// Task 19 (M9) - Look-Entscheidung, Stellschraube: hochkant (Seitenverhaeltnis
	// < 1, FOV 60 Grad senkrecht) ist die halbe Bildbreite schmaler als die Erde
	// aus 3,2 R (bei 375 x 812: 14,9 Grad gegen 18,2 Grad Winkelradius), die
	// Scheibe war links und rechts angeschnitten. Die Startdistanz waechst dann,
	// bis die Kugel mit dem Radius ANFAHRT_RAND (in R) genau in die halbe Breite
	// passt: d = ANFAHRT_RAND / sin(atan(aspekt * tan(FOV/2))), mindestens
	// ANFAHRT_NACH. ANFAHRT_RAND 1,03 = Atmosphaerenhuelle (erde.js AUSSEN_RADIUS):
	// mit 1,0 (3,88 R) beruehrte die Scheibe den Bildrand und der Saum war
	// abgeschnitten (t19-start-hochkant). 375 x 812 -> 4,0 R; 370 x 461 und quer
	// bleiben bei 3,2 R. (Die Vorgabe "max(1, 1,25/aspekt) x 3,2" ergaebe bei
	// 375 x 812 8,7 R statt ~3,9 R - daher die geometrische Form.)
	var ANFAHRT_RAND = 1.03;
	// Nah-/Fernebene der Welt-Projektion in R (Task 12b): 1e-4 R = 0,64 km lag
	// ueber der kleinsten Folgen-Distanz (50 m), die Bahn wurde rund um die
	// Station weggeclippt. 1e-5 R = 64 m; Reversed-Z in float32 verkraftet das.
	// Die Welt-Ebene zeichnet kamerarelativ (welt.viewRel/viewProjRel, Kamera im
	// Ursprung), damit float32 nahe der Kamera nicht auf 0,76 m (ulp bei 1 R) rundet.
	var NAH_WELT = 1e-5, FERN_WELT = 80;
	// Startwerte (Soll = Ist beim Anlegen): Erde az/hoehe rad, dist R; Folgen
	// az/hoehe rad, dist km ("schraeg von hinten", 0,8 km); Blick gier/nick rad.
	var START = { erde: { az: 0, hoehe: 0.3, dist: 3.2 }, folgen: { az: 0.45, hoehe: 0.3, dist: 0.8 }, blick: { gier: 0, nick: 0 } };
	function kopie(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }

	// ---------------------------------------------------------- Vektoren (Arrays, double)
	function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
	function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
	function laenge(v) { return Math.hypot(v[0], v[1], v[2]); }
	function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
	function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
	function skal(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
	function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
	function norm(v, ersatz) {
		var l = laenge(v);
		return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : (ersatz || [0, 0, 1]);
	}
	function endlich3(v) { return v && v.length >= 3 && isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2]); }
	function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
	function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
	// ist += (soll - ist) * (1 - exp(-dt/tau)); bei riesigem dt wird der Faktor 1.
	function glaette(ist, soll, dt) { return ist + (soll - ist) * (1 - Math.exp(-dt / TAU_GLAETTUNG)); }
	// Nicht endliche Sollwerte (Fehler der Anwendung) fallen auf den Istwert zurueck.
	function sauber(soll, ist, min, max) { return isFinite(soll) ? clamp(soll, min, max) : ist; }

	// Startdistanz der Anfahrt (R) nach Seitenverhaeltnis (Task 19, M9, s. ANFAHRT_RAND).
	function startDistanz(aspekt) {
		if (!(aspekt > 0) || aspekt >= 1) return ANFAHRT_NACH;
		var halbeBreite = Math.atan(aspekt * Math.tan(FOV_HOCH / 2));
		return clamp(Math.max(ANFAHRT_NACH, ANFAHRT_RAND / Math.sin(halbeBreite)), ERDE_DIST[0], ERDE_DIST[1]);
	}

	// ---------------------------------------------------------- Lagen (pos, ziel, oben in R, ECI)
	// Bahnsystem der Station aus Position (R) und Geschwindigkeit (R/s):
	// { oben (radial), vorn (Geschwindigkeit ohne Radialanteil), seite = vorn x oben }
	// als ECI-Einheitsvektoren. Zugleich das Stationssystem des Modells (+X
	// Steuerbord = seite, +Y Flugrichtung = vorn, +Z Zenit = oben); tracker.js
	// nutzt es ueber Kamera.bahnsystem (Task 12c, vorher eine eigene Kopie).
	function bahnsystem(iss) {
		var oben = norm(iss.positionR, [1, 0, 0]);
		var v = endlich3(iss.geschwindigkeitRproS) ? iss.geschwindigkeitRproS : [0, 0, 0];
		var vorn = norm(sub(v, skal(oben, dot(v, oben))), null);
		if (!vorn) {
			// Geschwindigkeit fehlt oder zeigt radial: irgendeine Richtung quer zu 'oben'
			vorn = norm(cross([0, 0, 1], oben), null) || norm(cross([0, 1, 0], oben));
		}
		return { oben: oben, vorn: vorn, seite: cross(vorn, oben) };
	}
	// Kameraversatz in Metern im Bahnsystem.
	function versatzFolgen(sys, p) {
		var ch = Math.cos(p.hoehe), sh = Math.sin(p.hoehe);
		var r = add(add(skal(sys.vorn, -ch * Math.cos(p.az)), skal(sys.seite, ch * Math.sin(p.az))), skal(sys.oben, sh));
		return skal(r, p.dist * 1000);
	}
	function lageErde(p, rahmen, gmst) {
		var ch = Math.cos(p.hoehe), sh = Math.sin(p.hoehe);
		// az ist im erdfesten Rahmen ein Laengengrad: ECI = Rz(gmst) * erdfest
		var az = rahmen === "erdfest" ? p.az + gmst : p.az;
		var ca = Math.cos(az), sa = Math.sin(az);
		return {
			pos: [p.dist * ch * ca, p.dist * ch * sa, p.dist * sh],
			ziel: [0, 0, 0],
			oben: [-sh * ca, -sh * sa, ch]                  // 'Norden oben', senkrecht zur Blickrichtung
		};
	}
	function lageFolgen(p, iss) {
		var sys = bahnsystem(iss);
		var versatz = versatzFolgen(sys, p);
		return {
			pos: add(iss.positionR, skal(versatz, 1 / R_M)),
			ziel: iss.positionR.slice(),
			oben: sys.oben
		};
	}
	// Blickrichtung d(gier, nick) in ECI; 'oben' ist die Ableitung nach nick -
	// sie bleibt am Pol definiert (Blick auf +Z: oben zeigt nach hinten).
	function lageBlick(p, pos) {
		var cn = Math.cos(p.nick), sn = Math.sin(p.nick), cg = Math.cos(p.gier), sg = Math.sin(p.gier);
		var d = [cn * cg, cn * sg, sn];
		return { pos: pos.slice(), ziel: add(pos, d), oben: [-sn * cg, -sn * sg, cn] };
	}

	// ---------------------------------------------------------- Kamera
	function neu(canvas) {
		var M = window.GPU.mat4;

		var kamera = {
			modus: "erde",                                     // nur lesen; setzen ueber setzeModus
			rahmen: "erdfest",                                 // nur lesen; setzen ueber setzeRahmen
			fov: FOV_QUER,                                     // Sollwert (rad); in 'blick' frei, sonst 50/60 Grad
			erde:   kopie(START.erde),                         // Sollwerte: rad, rad, R
			folgen: kopie(START.folgen),                       // Sollwerte: rad, rad, km
			blick:  kopie(START.blick),                        // Sollwerte: rad
			onTaste: null,                                     // function (name) - 'folgen'|'erde'|'jetzt'|'pause'
			onDoppeltipp: null                                 // function (x, y) - CSS-Pixel im Canvas
		};
		var ist = { fov: FOV_QUER, erde: kopie(START.erde), folgen: kopie(START.folgen), blick: kopie(START.blick) };
		var schwung = { a: 0, b: 0 };                          // Winkelgeschwindigkeit rad/s (az|gier, hoehe|nick)
		var iss = null, issGueltig = false;                    // letzter brauchbarer Stationszustand
		var gmst = 0, aspekt = 16 / 9;
		var startGesetzt = false, anfahrt = null;              // Startbild: Anfahrt {t, nach}
		// Task 12c: hat der Nutzer vor der ersten gueltigen Station gezogen, gezoomt
		// oder eine Pfeiltaste gedrueckt, ueberschreibt das Startbild das nicht.
		var nutzerEingriff = false;
		var uebergang = null;                                  // {t, start}
		var blickPos = [3.2, 0, 0];                            // eingefrorene Position im Blick-Modus
		var lage = null;                                       // {pos, ziel, oben} des letzten Schritts
		var zeigerAktiv = false;                               // Finger/Maus haelt die Kamera

		function standardFov() { return aspekt < 1 ? FOV_HOCH : FOV_QUER; }

		// Endlage des aktuellen Modus mit den Istwerten.
		function zielLage() {
			if (kamera.modus === "folgen" && iss) return lageFolgen(ist.folgen, iss);
			if (kamera.modus === "blick") return lageBlick(ist.blick, blickPos);
			return lageErde(ist.erde, kamera.rahmen, gmst);
		}
		// Startlage eines Uebergangs: fest im Raum, oder mitlaufend im Bahnsystem.
		function startLage(s) {
			if (s.art === "folgen" && iss) return lageFolgen(s, iss);
			return s;
		}
		function berechneLage() {
			var ende = zielLage();
			if (!uebergang) { lage = ende; return; }
			var t = smoothstep(uebergang.t / DAUER_UEBERGANG);
			var start = startLage(uebergang.start);
			lage = {
				pos: mix(start.pos, ende.pos, t),
				ziel: mix(start.ziel, ende.ziel, t),
				oben: norm(mix(start.oben, ende.oben, t), ende.oben)
			};
			if (uebergang.t >= DAUER_UEBERGANG) { uebergang = null; lage = ende; }
		}
		function starteUebergang(alterModus) {
			if (!lage) berechneLage();
			var s = { art: "fest", pos: lage.pos.slice(), ziel: lage.ziel.slice(), oben: lage.oben.slice() };
			if (alterModus === "folgen" && iss) {
				s.art = "folgen";
				s.az = ist.folgen.az; s.hoehe = ist.folgen.hoehe; s.dist = ist.folgen.dist;
			}
			uebergang = { t: 0, start: s };
		}
		// Blickrichtung der aktuellen Lage als Gier/Nick uebernehmen.
		function richtungUebernehmen(d) {
			d = norm(d, [1, 0, 0]);
			kamera.blick.gier = Math.atan2(d[1], d[0]);
			kamera.blick.nick = Math.asin(clamp(d[2], -1, 1));
			ist.blick.gier = kamera.blick.gier; ist.blick.nick = kamera.blick.nick;
		}

		function setzeModus(m) {
			if (m !== "erde" && m !== "folgen" && m !== "blick") return;
			if (m === kamera.modus) return;
			var alt = kamera.modus;
			if (!lage) berechneLage();
			if (m === "blick") {
				blickPos = lage.pos.slice();
				richtungUebernehmen(sub(lage.ziel, lage.pos));     // weiterschauen, wo man gerade hinsah
			}
			if (alt === "blick") { kamera.fov = standardFov(); }
			kamera.modus = m;
			schwung.a = 0; schwung.b = 0;
			starteUebergang(alt);
		}
		function setzeRahmen(r) {
			if (r !== "erdfest" && r !== "raumfest") return;
			if (r === kamera.rahmen) return;
			// az so umrechnen, dass die Kamera stehen bleibt: erdfest = raumfest - gmst
			var delta = r === "erdfest" ? -gmst : gmst;
			kamera.erde.az += delta; ist.erde.az += delta;
			kamera.rahmen = r;
		}
		function zentriere(richtung) {
			if (!endlich3(richtung)) return;
			var alt = kamera.modus;
			if (!lage) berechneLage();
			if (alt !== "blick") { blickPos = lage.pos.slice(); kamera.modus = "blick"; }
			richtungUebernehmen(richtung);
			schwung.a = 0; schwung.b = 0;
			starteUebergang(alt);                                  // 1,2 s Schwenk im Raum
		}
		function zurueckZurErde() { setzeModus("erde"); }

		function schritt(dtSek, issNeu, g) {
			var dt = isFinite(dtSek) && dtSek > 0 ? dtSek : 0;
			if (isFinite(g)) gmst = g;
			issGueltig = !!(issNeu && issNeu.gueltig && endlich3(issNeu.positionR) && laenge(issNeu.positionR) > 0.5);
			if (issGueltig) {
				var v = endlich3(issNeu.geschwindigkeitRproS) ? issNeu.geschwindigkeitRproS : [0, 0, 0];
				iss = { positionR: [issNeu.positionR[0], issNeu.positionR[1], issNeu.positionR[2]], geschwindigkeitRproS: [v[0], v[1], v[2]] };
			}
			// Startbild: ueber der Station, leicht gekippt, Anfahrt von 5 R auf 3,2 R
			// (hochkant weiter, Task 19: startDistanz) - nur einmal und nicht ueber
			// eine fruehere Eingabe des Nutzers hinweg. Das Seitenverhaeltnis kommt
			// aus dem Canvas: matrizen() laeuft im ersten Bild erst nach schritt().
			if (!startGesetzt && issGueltig) {
				startGesetzt = true;
				if (!nutzerEingriff) {
					var p = iss.positionR, lonEci = Math.atan2(p[1], p[0]), lat = Math.asin(clamp(p[2] / laenge(p), -1, 1));
					var a = canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : aspekt;
					var nach = startDistanz(a);
					kamera.erde.az = kamera.rahmen === "erdfest" ? lonEci - gmst : lonEci;
					kamera.erde.hoehe = clamp(lat, -60 * GRAD, 60 * GRAD);
					kamera.erde.dist = nach;
					ist.erde.az = kamera.erde.az; ist.erde.hoehe = kamera.erde.hoehe; ist.erde.dist = ANFAHRT_VON;
					anfahrt = { t: 0, nach: nach };
				}
			}
			if (kamera.modus !== "blick") kamera.fov = standardFov();

			// Schwung: nach dem Loslassen laeuft die Drehung mit Reibung aus.
			// Weg = Integral der abklingenden Geschwindigkeit ueber den Schritt
			// (v tau (1 - exp(-dt/tau))), damit ein grosses dt nicht ueberschiesst.
			if (!zeigerAktiv && (schwung.a !== 0 || schwung.b !== 0)) {
				var z = kamera.modus === "blick" ? kamera.blick : (kamera.modus === "folgen" ? kamera.folgen : kamera.erde);
				var f = Math.exp(-dt / TAU_REIBUNG), weg = TAU_REIBUNG * (1 - f);
				if (kamera.modus === "blick") { z.gier += schwung.a * weg; z.nick += schwung.b * weg; }
				else { z.az += schwung.a * weg; z.hoehe += schwung.b * weg; }
				schwung.a *= f; schwung.b *= f;
				if (Math.abs(schwung.a) < 1e-4) schwung.a = 0;
				if (Math.abs(schwung.b) < 1e-4) schwung.b = 0;
			}

			// Sollwerte begrenzen, Istwerte nachziehen
			var e = kamera.erde, fo = kamera.folgen, b = kamera.blick;
			e.az = sauber(e.az, ist.erde.az, -Infinity, Infinity);
			e.hoehe = sauber(e.hoehe, ist.erde.hoehe, -HOEHE_MAX, HOEHE_MAX);
			e.dist = sauber(e.dist, ist.erde.dist, ERDE_DIST[0], ERDE_DIST[1]);
			fo.az = sauber(fo.az, ist.folgen.az, -Infinity, Infinity);
			fo.hoehe = sauber(fo.hoehe, ist.folgen.hoehe, -HOEHE_MAX, HOEHE_MAX);
			fo.dist = sauber(fo.dist, ist.folgen.dist, FOLGEN_DIST[0], FOLGEN_DIST[1]);
			b.gier = sauber(b.gier, ist.blick.gier, -Infinity, Infinity);
			b.nick = sauber(b.nick, ist.blick.nick, -Math.PI / 2, Math.PI / 2);
			kamera.fov = sauber(kamera.fov, ist.fov, FOV_BEREICH[0], FOV_BEREICH[1]);

			ist.erde.az = glaette(ist.erde.az, e.az, dt);
			ist.erde.hoehe = glaette(ist.erde.hoehe, e.hoehe, dt);
			ist.erde.dist = glaette(ist.erde.dist, e.dist, dt);
			ist.folgen.az = glaette(ist.folgen.az, fo.az, dt);
			ist.folgen.hoehe = glaette(ist.folgen.hoehe, fo.hoehe, dt);
			ist.folgen.dist = glaette(ist.folgen.dist, fo.dist, dt);
			ist.blick.gier = glaette(ist.blick.gier, b.gier, dt);
			ist.blick.nick = glaette(ist.blick.nick, b.nick, dt);
			ist.fov = glaette(ist.fov, kamera.fov, dt);

			if (anfahrt) {
				anfahrt.t += dt;
				ist.erde.dist = ANFAHRT_VON + (anfahrt.nach - ANFAHRT_VON) * smoothstep(anfahrt.t / DAUER_ANFAHRT);
				if (anfahrt.t >= DAUER_ANFAHRT) { ist.erde.dist = anfahrt.nach; anfahrt = null; }
			}
			if (uebergang) uebergang.t += dt;
			berechneLage();
		}

		// welt: view/proj/viewProj wie bisher (absolut, fuer CPU-Projektionen wie
		// Labels), dazu viewRel/viewProjRel (Task 12b): dieselbe Drehung ohne
		// Verschiebung - die Zeichner uebergeben Positionen relativ zu welt.pos
		// (auf der CPU in double abgezogen) und projizieren mit viewProjRel.
		// Es gilt viewProjRel * (p - pos) = viewProj * p.
		function matrizen(a) {
			if (isFinite(a) && a > 0) aspekt = a;
			if (!lage) berechneLage();
			var view = M.blick(lage.pos, lage.ziel, lage.oben);
			var proj = M.perspektivReversedZ(ist.fov, aspekt, NAH_WELT, FERN_WELT);
			var issR = iss ? iss.positionR : [0, 0, 0];
			var posM = skal(sub(lage.pos, issR), R_M), zielM = skal(sub(lage.ziel, issR), R_M);
			var issView = M.blick(posM, zielM, lage.oben);
			var issProj = M.perspektivReversedZ(ist.fov, aspekt, 0.5, 200000);
			var viewRel = new Float32Array(view);
			viewRel[12] = 0; viewRel[13] = 0; viewRel[14] = 0;
			return {
				welt:   { view: view, proj: proj, viewProj: M.mul(proj, view), pos: lage.pos.slice(),
				          viewRel: viewRel, viewProjRel: M.mul(proj, viewRel) },
				iss:    { view: issView, proj: issProj, viewProj: M.mul(issProj, issView), pos: posM },
				himmel: { viewRot: new Float32Array(viewRel), proj: M.perspektivReversedZ(ist.fov, aspekt, 0.5, 4) }
			};
		}
		function distanzKm() {
			if (!iss) return Infinity;
			if (!lage) berechneLage();
			return laenge(sub(lage.pos, iss.positionR)) * R_M / 1000;
		}
		// Strecke Kamera -> Station gegen die Erdkugel (Radius 1): verdeckt, wenn
		// der dem Ursprung naechste Punkt der Strecke echt dazwischen liegt und
		// naeher als 1 ist.
		function stationVerdeckt(p) {
			if (!endlich3(p)) return false;
			if (!lage) berechneLage();
			var a = lage.pos, d = sub(p, a), l2 = dot(d, d);
			if (l2 < 1e-24) return false;
			var t = -dot(a, d) / l2;
			if (t <= 0 || t >= 1) return false;
			return laenge(add(a, skal(d, t))) < 1;
		}
		function debug() {
			if (!lage) berechneLage();
			return {
				modus: kamera.modus, rahmen: kamera.rahmen, fovGrad: ist.fov / GRAD,
				erde: { az: ist.erde.az, hoehe: ist.erde.hoehe, dist: ist.erde.dist },
				folgen: { az: ist.folgen.az, hoehe: ist.folgen.hoehe, dist: ist.folgen.dist },
				blick: { gier: ist.blick.gier, nick: ist.blick.nick },
				uebergang: uebergang ? uebergang.t : null,
				anfahrt: anfahrt ? anfahrt.t : null,
				pos: lage.pos.slice(),
				distanzKm: distanzKm(),
				issGueltig: issGueltig
			};
		}

		// ---------------------------------------------------------- Eingabe
		// Ziehen nimmt die Szene mit (wie Google Earth): Erde/Folgen az -= dx,
		// hoehe += dy. Im Blick-Modus dreht die Richtung: dx nach rechts bewegt
		// den Himmel nach rechts, also die Blickrichtung nach links = gier +
		// (gier zaehlt gegen den Uhrzeigersinn um +Z, ein Rechtssystem mit
		// rechts = d x oben).
		function drehe(dx, dy, dtMs) {
			var dA, dB;
			nutzerEingriff = true;
			if (kamera.modus === "blick") {
				var k = 0.003 * ist.fov / 0.87;
				dA = dx * k; dB = dy * k;
				kamera.blick.gier += dA; kamera.blick.nick += dB;
			} else {
				var z = kamera.modus === "folgen" ? kamera.folgen : kamera.erde;
				dA = -dx * 0.005; dB = dy * 0.005;
				z.az += dA; z.hoehe += dB;
			}
			if (dtMs > 0) {
				var dtS = Math.min(dtMs, 100) / 1000, w = 0.5;
				schwung.a = clamp(schwung.a * w + (dA / dtS) * (1 - w), -SCHWUNG_MAX, SCHWUNG_MAX);
				schwung.b = clamp(schwung.b * w + (dB / dtS) * (1 - w), -SCHWUNG_MAX, SCHWUNG_MAX);
			}
		}
		function zoome(faktor) {
			anfahrt = null; nutzerEingriff = true;
			if (kamera.modus === "blick") kamera.fov = clamp(kamera.fov * faktor, FOV_BEREICH[0], FOV_BEREICH[1]);
			else if (kamera.modus === "folgen") kamera.folgen.dist = clamp(kamera.folgen.dist * faktor, FOLGEN_DIST[0], FOLGEN_DIST[1]);
			else kamera.erde.dist = clamp(kamera.erde.dist * faktor, ERDE_DIST[0], ERDE_DIST[1]);
		}
		function zoomwert() {
			return kamera.modus === "blick" ? kamera.fov : (kamera.modus === "folgen" ? kamera.folgen.dist : kamera.erde.dist);
		}
		function setzeZoom(wert) {
			anfahrt = null; nutzerEingriff = true;
			if (kamera.modus === "blick") kamera.fov = clamp(wert, FOV_BEREICH[0], FOV_BEREICH[1]);
			else if (kamera.modus === "folgen") kamera.folgen.dist = clamp(wert, FOLGEN_DIST[0], FOLGEN_DIST[1]);
			else kamera.erde.dist = clamp(wert, ERDE_DIST[0], ERDE_DIST[1]);
		}

		if (canvas) {
			var zeiger = new Map();                             // pointerId -> {x, y, t, x0, y0, t0, weg}
			var pinch = null;                                   // {abstand0, wert0}
			var letzterTipp = null;                             // {t, x, y}
			if (canvas.style) canvas.style.touchAction = "none";

			function ortImCanvas(e) {
				var r = canvas.getBoundingClientRect();
				return [e.clientX - r.left, e.clientY - r.top];
			}
			function abstandZeiger() {
				var it = zeiger.values(), a = it.next().value, b = it.next().value;
				return Math.hypot(a.x - b.x, a.y - b.y);
			}

			canvas.addEventListener("pointerdown", function (e) {
				if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
				if (zeiger.size >= 2) return;
				try { canvas.setPointerCapture(e.pointerId); } catch (ex) { /* Pointer schon weg */ }
				zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, weg: 0 });
				zeigerAktiv = true;
				schwung.a = 0; schwung.b = 0;
				pinch = zeiger.size === 2 ? { abstand0: Math.max(1, abstandZeiger()), wert0: zoomwert() } : null;
				e.preventDefault();
			});
			canvas.addEventListener("pointermove", function (e) {
				var z = zeiger.get(e.pointerId);
				if (!z) return;
				var dx = e.clientX - z.x, dy = e.clientY - z.y;
				z.weg += Math.abs(dx) + Math.abs(dy);
				z.x = e.clientX; z.y = e.clientY;
				if (zeiger.size === 1) {
					drehe(dx, dy, e.timeStamp - z.t);
				} else if (pinch) {
					// zwei Zeiger: Abstand -> Zoomfaktor (auseinander = naeher)
					setzeZoom(pinch.wert0 * pinch.abstand0 / Math.max(1, abstandZeiger()));
				}
				z.t = e.timeStamp;
				e.preventDefault();
			});
			function zeigerWeg(e) {
				var z = zeiger.get(e.pointerId);
				if (!z) return;
				zeiger.delete(e.pointerId);
				try { canvas.releasePointerCapture(e.pointerId); } catch (ex) { /* schon frei */ }
				if (zeiger.size === 0) {
					zeigerAktiv = false;
					if (e.timeStamp - z.t > 80) { schwung.a = 0; schwung.b = 0; }   // vor dem Loslassen angehalten
					// Tipp: kurz und ohne Weg; zweiter Tipp innerhalb 300 ms -> Doppeltipp
					if (e.type === "pointerup" && z.weg < 10 && e.timeStamp - z.t0 < 300) {
						var o = ortImCanvas(e);
						if (letzterTipp && e.timeStamp - letzterTipp.t < 300 && Math.hypot(o[0] - letzterTipp.x, o[1] - letzterTipp.y) < 30) {
							letzterTipp = null;
							if (typeof kamera.onDoppeltipp === "function") kamera.onDoppeltipp(o[0], o[1]);
						} else {
							letzterTipp = { t: e.timeStamp, x: o[0], y: o[1] };
						}
					}
				} else {
					pinch = null;                                   // ein Finger bleibt: weiter drehen, ohne Sprung
					schwung.a = 0; schwung.b = 0;
				}
			}
			canvas.addEventListener("pointerup", zeigerWeg);
			canvas.addEventListener("pointercancel", zeigerWeg);
			canvas.addEventListener("dblclick", function (e) { e.preventDefault(); });   // Doppeltipp kommt ueber pointerup
			canvas.addEventListener("wheel", function (e) {
				e.preventDefault();
				var dy = e.deltaY * (e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1));
				zoome(Math.exp(clamp(dy, -400, 400) * 0.001));
			}, { passive: false });

			window.addEventListener("keydown", function (e) {
				if (e.ctrlKey || e.metaKey || e.altKey) return;
				var ziel = e.target, tag = ziel && ziel.tagName ? ziel.tagName.toLowerCase() : "";
				if (tag === "input" || tag === "textarea" || tag === "select" || (ziel && ziel.isContentEditable)) return;
				var s = 0.05, sb = 0.05 * ist.fov / 0.87, blick = kamera.modus === "blick";
				var z = blick ? kamera.blick : (kamera.modus === "folgen" ? kamera.folgen : kamera.erde);
				var name = null;
				switch (e.key) {
					case "ArrowLeft":  if (blick) z.gier += sb; else z.az -= s; break;
					case "ArrowRight": if (blick) z.gier -= sb; else z.az += s; break;
					case "ArrowUp":    if (blick) z.nick += sb; else z.hoehe += s; break;
					case "ArrowDown":  if (blick) z.nick -= sb; else z.hoehe -= s; break;
					case "+": case "=": case "Add":      zoome(1 / 1.15); break;
					case "-": case "Subtract":           zoome(1.15); break;
					case "f": case "F": name = "folgen"; break;
					case "e": case "E": name = "erde"; break;
					case "j": case "J": name = "jetzt"; break;
					case " ": if (tag === "button") return; name = "pause"; break;
					default: return;
				}
				e.preventDefault();
				if (!name) nutzerEingriff = true;                  // Pfeile, +/-: Kamera von Hand bewegt
				if (name && typeof kamera.onTaste === "function") kamera.onTaste(name);
			});
		}

		kamera.setzeModus = setzeModus;
		kamera.setzeRahmen = setzeRahmen;
		kamera.zentriere = zentriere;
		kamera.zurueckZurErde = zurueckZurErde;
		kamera.schritt = schritt;
		kamera.matrizen = matrizen;
		kamera.distanzKm = distanzKm;
		kamera.stationVerdeckt = stationVerdeckt;
		kamera.debug = debug;
		berechneLage();
		return kamera;
	}

	window.Kamera = { neu: neu, bahnsystem: bahnsystem, startDistanz: startDistanz };   // bahnsystem: Task 12c (tracker.js, Stationssystem); startDistanz: Task 19
})(window);
