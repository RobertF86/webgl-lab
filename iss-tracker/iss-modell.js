/* Prozedurales Modell der Internationalen Raumstation.
 *
 * Stationssystem in Metern, Ursprung Stationsmitte: +X Steuerbord entlang des
 * Traegers, +Y Flugrichtung entlang der Module, +Z Zenit. Alle Flaechen flach
 * schattiert (eine Normale je Flaeche), Dreiecke gegen den Uhrzeigersinn von
 * der Normalenseite gesehen. Materialkennung je Ecke: 0 Metall, 1 Weiss,
 * 2 Solar, 3 Folie, 4 Fenster. Solarfluegel und Radiatoren sind einseitige
 * Platten (im Zeichner ohne Culling). Masse nach der Teiletabelle aus Task 9.
 * Je Ecke zusaetzlich 'quer' (Task 12b): fuer die Traegerstreben der Versatz
 * der Ecke von der Strebenachse (Betrag Kantenlaenge / sqrt 2), sonst 0. */
(function (window) {
	"use strict";

	// ---------- Vektoren ----------
	function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
	function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
	function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
	function punkt(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
	function kreuz(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
	function norm(a) { var l = Math.sqrt(punkt(a, a)); return [a[0] / l, a[1] / l, a[2] / l]; }

	var ACHSE = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
	// Rechtshaendiges Dreibein (u, v) zur Achse a: u x v = a
	var DREIBEIN = { x: [[0, 1, 0], [0, 0, 1]], y: [[0, 0, 1], [1, 0, 0]], z: [[1, 0, 0], [0, 1, 0]] };
	var UV_VIERECK = [[0, 0], [1, 0], [1, 1], [0, 1]];

	// ---------- Builder ----------
	// q (Task 12b): Querversatz der Ecke von der Achse ihrer Strebe (nur im
	// strebenModus, Traeger), sonst 0 - der Zeichner weitet damit duenne Streben
	// auf eine Mindestbreite in Bildpixeln auf, ohne die Normale zu aendern.
	function Builder() { this.p = []; this.n = []; this.t = []; this.m = []; this.q = []; this.i = []; this.teile = []; this.strebenModus = false; }
	Builder.prototype.ecke = function (p, n, uv, m, q) {
		this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); this.t.push(uv[0], uv[1]); this.m.push(m);
		if (q) this.q.push(q[0], q[1], q[2]); else this.q.push(0, 0, 0);
		return this.m.length - 1;
	};
	Builder.prototype.dreieck = function (a, b, c) { this.i.push(a, b, c); };
	// Ebenes, konvexes Viereck; Ecken e[0..3] gegen den Uhrzeigersinn von aussen.
	// Die flache Normale kommt aus dem Kreuzprodukt der Diagonalen, damit
	// Wicklung und Normale nie auseinanderlaufen koennen. q: optional je Ecke
	// der Querversatz (siehe Builder).
	Builder.prototype.viereck = function (e, uv, m, q) {
		var n = norm(kreuz(sub(e[2], e[0]), sub(e[3], e[1])));
		var s = this.ecke(e[0], n, uv[0], m, q && q[0]);
		this.ecke(e[1], n, uv[1], m, q && q[1]); this.ecke(e[2], n, uv[2], m, q && q[2]); this.ecke(e[3], n, uv[3], m, q && q[3]);
		this.i.push(s, s + 1, s + 2, s, s + 2, s + 3);
	};
	// Alles, was fn() erzeugt, wird ein Teil mit Start/Anzahl im Indexpuffer
	Builder.prototype.teil = function (name, material, fn) {
		var start = this.i.length;
		fn();
		this.teile.push({ name: name, material: material, start: start, anzahl: this.i.length - start });
	};
	Builder.prototype.fertig = function () {
		var P = new Float32Array(this.p);
		var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (var k = 0; k < P.length; k += 3) for (var a = 0; a < 3; a++) {
			if (P[k + a] < lo[a]) lo[a] = P[k + a];
			if (P[k + a] > hi[a]) hi[a] = P[k + a];
		}
		function spanne(a) { return P.length ? hi[a] - lo[a] : 0; }
		return {
			positionen: P,
			normalen: new Float32Array(this.n),
			uv: new Float32Array(this.t),
			material: new Uint8Array(this.m),
			quer: new Float32Array(this.q),                 // Task 12b: Querversatz zur Strebenachse je Ecke (0 = keine Strebe)
			indizes: new Uint32Array(this.i),
			teile: this.teile.slice(),
			masse: { breite: spanne(0), laenge: spanne(1), hoehe: spanne(2) }
		};
	};

	// ---------- Grundkoerper ----------
	// Kiste mit rechtshaendigem Orthonormalsystem e[0..2] und Halbmassen h[0..2].
	// Flaechen: [Normalachse, Vorzeichen, u-Achse, v-Achse] mit e[u] x e[v] = Vorzeichen * e[n]
	var KISTE_FLAECHEN = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]];
	// Im strebenModus (Traeger) bekommt jede Ecke ihren Querversatz zur Achse der
	// Kiste (die laengste Halbmasse): q = (p - c) ohne den Anteil entlang der Achse.
	function kiste(b, c, e, h, m) {
		var achse = h[0] >= h[1] && h[0] >= h[2] ? 0 : (h[1] >= h[2] ? 1 : 2);
		function quer(p) {
			if (!b.strebenModus) return null;
			var d = sub(p, c);
			return sub(d, mul(e[achse], punkt(d, e[achse])));
		}
		KISTE_FLAECHEN.forEach(function (f) {
			var mitte = add(c, mul(e[f[0]], f[1] * h[f[0]]));
			var du = mul(e[f[2]], h[f[2]]), dv = mul(e[f[3]], h[f[3]]);
			var ecken = [sub(sub(mitte, du), dv), sub(add(mitte, du), dv), add(add(mitte, du), dv), add(sub(mitte, du), dv)];
			b.viereck(ecken, UV_VIERECK, m, b.strebenModus ? ecken.map(quer) : null);
		});
	}

	// Achsenparalleler Quader: {mitte, groesse: [x, y, z], material}
	function quader(b, o) {
		var g = o.groesse;
		kiste(b, o.mitte, [ACHSE.x, ACHSE.y, ACHSE.z], [g[0] / 2, g[1] / 2, g[2] / 2], o.material || 0);
	}

	// Schraege Strebe von A nach B mit quadratischem Querschnitt; eine Seite
	// liegt quer zu seite (z.B. der Normalen der Traegerwand, auf der sie liegt).
	function strebe(b, A, B, dicke, seite, m) {
		var d = sub(B, A), L = Math.sqrt(punkt(d, d)), e1 = mul(d, 1 / L);
		var e2 = norm(sub(seite, mul(e1, punkt(seite, e1))));
		kiste(b, mul(add(A, B), 0.5), [e1, e2, kreuz(e1, e2)], [L / 2, dicke / 2, dicke / 2], m);
	}

	// Punkt auf dem Kreis um die Achse: Winkel w, Radius r, Achsposition t
	function kreispunkt(mitte, achse, w, r, t) {
		var d = DREIBEIN[achse], u = d[0], v = d[1], a = ACHSE[achse], c = Math.cos(w) * r, s = Math.sin(w) * r;
		return [mitte[0] + c * u[0] + s * v[0] + t * a[0], mitte[1] + c * u[1] + s * v[1] + t * a[1], mitte[2] + c * u[2] + s * v[2] + t * a[2]];
	}
	// Mantelband zwischen Achsposition tA (Radius rA) und tB > tA (Radius rB),
	// je Segment ein flaches Viereck (Zylinder- oder Kegelstumpfmantel)
	function mantel(b, mitte, achse, tA, rA, tB, rB, s, m) {
		for (var k = 0; k < s; k++) {
			var w0 = 2 * Math.PI * k / s, w1 = 2 * Math.PI * (k + 1) / s;
			b.viereck([kreispunkt(mitte, achse, w0, rA, tA), kreispunkt(mitte, achse, w1, rA, tA),
			           kreispunkt(mitte, achse, w1, rB, tB), kreispunkt(mitte, achse, w0, rB, tB)],
			          [[k / s, 0], [(k + 1) / s, 0], [(k + 1) / s, 1], [k / s, 1]], m);
		}
	}
	// Kreisscheibe als Faecher um die Mitte; richtung +1: Normale +Achse, -1: -Achse
	function deckel(b, mitte, achse, t, r, s, m, richtung) {
		var n = mul(ACHSE[achse], richtung);
		var c = b.ecke(kreispunkt(mitte, achse, 0, 0, t), n, [0.5, 0.5], m);
		for (var k = 0; k <= s; k++) {
			var w = 2 * Math.PI * k / s;
			b.ecke(kreispunkt(mitte, achse, w, r, t), n, [0.5 + 0.5 * Math.cos(w), 0.5 + 0.5 * Math.sin(w)], m);
		}
		for (k = 0; k < s; k++) {
			if (richtung > 0) b.dreieck(c, c + 1 + k, c + 2 + k);
			else b.dreieck(c, c + 2 + k, c + 1 + k);
		}
	}

	// Zylinder entlang einer Koordinatenachse:
	// {mitte, achse: 'x'|'y'|'z', radius, laenge, segmente, material, kappen}
	// Zusaetzlich: radiusMinus / radiusPlus (Kegelstumpf, Radius am Ende -/+Achse)
	// und kegel: {laenge, radius, seite: +1|-1} (Kegelkappe ausserhalb der laenge am
	// +Achsen-Ende, bei seite -1 am -Achsen-Ende, statt der flachen Kappe dort).
	function zylinder(b, o) {
		var s = o.segmente || 32, m = o.material || 0, h = o.laenge / 2;
		var r0 = o.radiusMinus != null ? o.radiusMinus : o.radius;
		var r1 = o.radiusPlus != null ? o.radiusPlus : o.radius;
		var kegelSeite = o.kegel ? (o.kegel.seite < 0 ? -1 : 1) : 0;
		mantel(b, o.mitte, o.achse, -h, r0, h, r1, s, m);
		if (kegelSeite < 0) {
			var tSpitze = -h - o.kegel.laenge;
			mantel(b, o.mitte, o.achse, tSpitze, o.kegel.radius, -h, r0, s, m);
			deckel(b, o.mitte, o.achse, tSpitze, o.kegel.radius, s, m, -1);
		} else if (o.kappen) {
			deckel(b, o.mitte, o.achse, -h, r0, s, m, -1);
		}
		if (kegelSeite > 0) {
			mantel(b, o.mitte, o.achse, h, r1, h + o.kegel.laenge, o.kegel.radius, s, m);
			deckel(b, o.mitte, o.achse, h + o.kegel.laenge, o.kegel.radius, s, m, 1);
		} else if (o.kappen) {
			deckel(b, o.mitte, o.achse, h, r1, s, m, 1);
		}
	}

	// Rechteckige Platte: {mitte, normal: 'x'|'y'|'z' (auch '-x' usw.), breite, hoehe, material, uvWiederholung}
	// Breite/Hoehe liegen bei normal z entlang x/y, bei normal x entlang y/z, bei normal y entlang x/z.
	// UV laeuft ueber die Platte von 0 bis uvWiederholung.
	var PLATTE_ACHSEN = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] };
	function platte(b, o) {
		var vz = o.normal.charAt(0) === "-" ? -1 : 1, ax = o.normal.replace(/^[+-]/, "");
		var T = PLATTE_ACHSEN[ax], c = o.mitte, r = o.uvWiederholung || 1;
		var du = mul(ACHSE[T[0]], o.breite / 2), dv = mul(ACHSE[T[1]], o.hoehe / 2);
		var e = [sub(sub(c, du), dv), sub(add(c, du), dv), add(add(c, du), dv), add(sub(c, du), dv)];
		var uv = [[0, 0], [r, 0], [r, r], [0, r]];
		// Umlaufsinn so waehlen, dass die Flaeche zur gewuenschten Normalen zeigt
		if (punkt(kreuz(sub(e[1], e[0]), sub(e[3], e[0])), mul(ACHSE[ax], vz)) < 0) {
			e = [e[0], e[3], e[2], e[1]]; uv = [uv[0], uv[3], uv[2], uv[1]];
		}
		b.viereck(e, uv, o.material || 0);
	}

	// ---------- Integrierter Traeger (ITS) ----------
	// 12 Segmente ueber 109 m, Querschnitt 4,6 x 4,6 m um (y 0, z 5,5): je Segment
	// vier Laengsstreben an den Aussenkanten, Rahmen an den Feldgrenzen und in jedem
	// Feld (~4 m) ein Diagonalkreuz auf allen vier Wanden.
	var TRAEGER = { laenge: 109, z: 5.5, quer: 4.6, segmente: 12, feld: 4, laengs: 0.25, rahmen: 0.2, diagonale: 0.15 };
	var SEG_LAENGE = TRAEGER.laenge / TRAEGER.segmente;
	var FELDER = Math.max(1, Math.round(SEG_LAENGE / TRAEGER.feld));
	var FELD_LAENGE = SEG_LAENGE / FELDER;
	var KANTE = TRAEGER.quer / 2 - TRAEGER.laengs / 2;   // Abstand der Strebenmitten von der Traegerachse
	var TRAEGER_OBEN = TRAEGER.z + TRAEGER.quer / 2;
	// x der Feldgrenze k (0 .. SEGMENTE * FELDER)
	function knoten(k) { return -TRAEGER.laenge / 2 + k * FELD_LAENGE; }

	function traeger(b) {
		var T = TRAEGER, zc = T.z, e = KANTE, x0 = -T.laenge / 2, x1 = T.laenge / 2;
		// Ecken des Querschnitts (y, z - zc), reihum; Wand j liegt zwischen Ecke j und j+1
		var ecken = [[-e, -e], [e, -e], [e, e], [-e, e]];
		// Rahmen aus vier Querstreben; an den Traegerenden nach innen versetzt,
		// damit die Spannweite genau 109 m bleibt
		function rahmen(x) {
			x = Math.max(x0 + T.rahmen / 2, Math.min(x1 - T.rahmen / 2, x));
			quader(b, { mitte: [x, 0, zc - e], groesse: [T.rahmen, 2 * e, T.rahmen], material: 0 });
			quader(b, { mitte: [x, 0, zc + e], groesse: [T.rahmen, 2 * e, T.rahmen], material: 0 });
			quader(b, { mitte: [x, -e, zc], groesse: [T.rahmen, T.rahmen, 2 * e], material: 0 });
			quader(b, { mitte: [x, e, zc], groesse: [T.rahmen, T.rahmen, 2 * e], material: 0 });
		}
		// Diagonalen enden 0,1 m vor der Feldgrenze in der Laengsstrebe, damit ihre
		// schraegen Stirnflaechen nicht ueber die Traegerenden hinausragen
		var rand = 0.1;
		for (var s = 0; s < T.segmente; s++) {
			var xa = x0 + s * SEG_LAENGE, xb = xa + SEG_LAENGE;
			ecken.forEach(function (k) {
				quader(b, { mitte: [(xa + xb) / 2, k[0], zc + k[1]], groesse: [SEG_LAENGE, T.laengs, T.laengs], material: 0 });
			});
			for (var f = 0; f < FELDER; f++) {
				var fa = xa + f * FELD_LAENGE + rand, fb = xa + (f + 1) * FELD_LAENGE - rand;
				rahmen(xa + f * FELD_LAENGE);
				for (var j = 0; j < 4; j++) {
					var k1 = ecken[j], k2 = ecken[(j + 1) % 4];
					var wand = norm([0, k1[0] + k2[0], k1[1] + k2[1]]);
					strebe(b, [fa, k1[0], zc + k1[1]], [fb, k2[0], zc + k2[1]], T.diagonale, wand, 0);
					strebe(b, [fa, k2[0], zc + k2[1]], [fb, k1[0], zc + k1[1]], T.diagonale, wand, 0);
				}
			}
		}
		rahmen(x1);
	}

	// ---------- Station ----------
	var SEG = 160;   // Segmente der Module: bei flacher Schattierung bestimmt allein die Segmentzahl, wie rund sie wirken

	function baue() {
		var b = new Builder();
		function modul(name, material, o) {
			b.teil(name, material, function () {
				o.material = material; if (!o.segmente) o.segmente = SEG;
				zylinder(b, o);
			});
		}

		b.teil("Traeger (ITS)", 0, function () { b.strebenModus = true; traeger(b); b.strebenModus = false; });
		b.teil("Z1", 0, function () { quader(b, { mitte: [0, 0, 2.8], groesse: [3, 3, 3], material: 0 }); });

		// Russisches Segment und US-Segment entlang y (Flugrichtung)
		modul("Zvezda", 1, { mitte: [0, -24.5, 0], achse: "y", radius: 2.1, laenge: 13, kappen: true });
		modul("Zarya", 3, { mitte: [0, -11.8, 0], achse: "y", radius: 2.05, laenge: 12.6, kappen: true });
		// Unity 5,6 statt 5,5 m (Mitte unveraendert), damit sie buendig an Zarya (y -5,5) anschliesst
		modul("Unity", 1, { mitte: [0, -2.7, 0], achse: "y", radius: 2.3, laenge: 5.6, kappen: true });
		modul("Destiny", 1, { mitte: [0, 4.25, 0], achse: "y", radius: 2.15, laenge: 8.5, kappen: true });
		modul("Harmony", 1, { mitte: [0, 12.1, 0], achse: "y", radius: 2.2, laenge: 7.2, kappen: true });
		// Seitliche Module entlang x: Aussenende wie in der Tabelle (Mitte +- Laenge/2), innen bis
		// zur Achse des Elternmoduls (x = 0) verlaengert, damit sie wirklich andocken; die innere
		// Kappe liegt verdeckt im Elternmodul
		function seitenmodul(name, tabellenMitte, tabellenLaenge, radius) {
			var aussen = tabellenMitte[0] + (tabellenMitte[0] < 0 ? -1 : 1) * tabellenLaenge / 2;
			modul(name, 1, { mitte: [aussen / 2, tabellenMitte[1], tabellenMitte[2]], achse: "x", radius: radius, laenge: Math.abs(aussen), kappen: true });
		}
		seitenmodul("Columbus", [5.7, 12.1, 0], 6.9, 2.25);      // an Harmony, x 0..9,15
		seitenmodul("Kibo", [-7.8, 12.1, 0], 11.2, 2.2);         // an Harmony, x -13,4..0
		seitenmodul("Tranquility", [-5.7, -2.7, 0], 6.7, 2.25);  // an Unity, x -9,05..0
		// Cupola: sechseckiger Stumpf wie die sechs Seitenfenster, breit am Anschluss (+z), schmal zur Erde
		modul("Cupola", 4, { mitte: [-8.5, -2.7, -2.6], achse: "z", radius: 1.5, radiusMinus: 0.8, laenge: 1.5, segmente: 6, kappen: true });
		// Kapseln an den Docks
		// Dragon dockt wie die echte Kapsel mit dem Kegel (schmales Ende r 0,8) an Harmony
		// (y 15,7) an; der zylindrische Trunk (r 2,0, L 8) zeigt nach +y
		var dragonKegel = 1.8, dragonMitte = 15.7 + dragonKegel + 8 / 2;
		modul("Dragon", 3, { mitte: [0, dragonMitte, 0], achse: "y", radius: 2.0, laenge: 8, kappen: true,
		                     kegel: { laenge: dragonKegel, radius: 0.8, seite: -1 } });
		modul("Sojus", 0, { mitte: [0, -34.5, 0], achse: "y", radius: 1.35, laenge: 7, kappen: true });

		// Solarfluegel: an x = +-35 (4er-Segmente) und +-47 (6er), je einer nach +y und -y;
		// die Wurzel sitzt an der Traegerwand (|y| 2,3), Mitte also bei |y| 2,3 + 17 = 19,3
		var wurzel = TRAEGER.quer / 2, fluegelLaenge = 34;
		[-47, -35, 35, 47].forEach(function (x) {
			var seg = (x < 0 ? "P" : "S") + (Math.abs(x) < 40 ? "4" : "6");
			[1, -1].forEach(function (vz) {
				b.teil("Solarfluegel " + seg + (vz > 0 ? " +y" : " -y"), 2, function () {
					platte(b, { mitte: [x, vz * (wurzel + fluegelLaenge / 2), TRAEGER.z], normal: "z", breite: 11.6, hoehe: fluegelLaenge, material: 2, uvWiederholung: 1 });
				});
			});
		});

		// Radiatoren: haengen unter dem Traeger nach -z, Normale von der Stationsmitte weg
		[-19, -15, -11, 11, 15, 19].forEach(function (x, k) {
			var name = "Radiator " + (x < 0 ? "P1-" + (3 - k) : "S1-" + (k - 2));
			b.teil(name, 1, function () {
				platte(b, { mitte: [x, 0, TRAEGER.z - 1.7 - 11.5], normal: x < 0 ? "-x" : "x", breite: 3.4, hoehe: 23, material: 1 });
			});
		});

		// Kleinteile: Boxen auf den Rahmen an Feldgrenzen (ausserhalb der Fluegelbereiche,
		// damit die gedrehten Fluegel sie nicht schneiden), Antennen auf Traeger und Modulen
		var auflage = TRAEGER_OBEN - 0.05;
		var seitlich = KANTE + TRAEGER.rahmen / 2 - 0.025;
		var boxen = [
			{ mitte: [knoten(7), 0, auflage + 0.6], groesse: [2.0, 1.6, 1.2] },
			{ mitte: [knoten(17), 0, auflage + 0.6], groesse: [2.0, 1.6, 1.2] },
			{ mitte: [knoten(9), 0, auflage + 0.5], groesse: [1.4, 1.4, 1.0] },
			{ mitte: [knoten(15), 0, auflage + 0.5], groesse: [1.4, 1.4, 1.0] },
			{ mitte: [knoten(6), -(seitlich + 0.6), TRAEGER.z], groesse: [1.8, 1.2, 1.6] },
			{ mitte: [knoten(18), seitlich + 0.6, TRAEGER.z], groesse: [1.8, 1.2, 1.6] }
		];
		boxen.forEach(function (o, k) {
			b.teil("Box " + (k + 1), 0, function () { quader(b, { mitte: o.mitte, groesse: o.groesse, material: 0 }); });
		});
		var antennen = [
			{ mitte: [knoten(10), KANTE, TRAEGER_OBEN - 0.02 + 0.9], laenge: 1.8 },   // auf der oberen Laengsstrebe
			{ mitte: [knoten(14), -KANTE, TRAEGER_OBEN - 0.02 + 0.9], laenge: 1.8 },
			{ mitte: [0, -27, 2.08 + 0.75], laenge: 1.5 },                            // auf Zvezda
			{ mitte: [-10.5, 12.1, 2.18 + 0.6], laenge: 1.2 }                         // auf Kibo
		];
		antennen.forEach(function (o, k) {
			b.teil("Antenne " + (k + 1), 0, function () {
				zylinder(b, { mitte: o.mitte, achse: "z", radius: 0.1, laenge: o.laenge, segmente: 12, material: 0, kappen: true });
			});
		});

		return b.fertig();
	}

	window.IssModell = {
		builder: function () { return new Builder(); },
		quader: quader,
		zylinder: zylinder,
		platte: platte,
		baue: baue
	};
})(window);
