(function (window) {
	"use strict";
	// Sonne, Mond, Planeten und Praezession fuer den ISS-Tracker.
	// Intern wird in Grad gerechnet; nach aussen gehen ra/dek in Bogenmass,
	// Richtungen als Einheitsvektoren im Aequatorsystem (+X Fruehlingspunkt,
	// +Z Nordpol). Ausnahme: sonne().lambda ist in Grad (ekliptikale Laenge).
	var GRAD_ZU_RAD = Math.PI / 180, ZWEI_PI = Math.PI * 2, ERDRADIUS_KM = 6378.137;
	function rad(g) { return g * GRAD_ZU_RAD; }
	function norm(g) { g = g % 360; if (g < 0) g += 360; return g >= 360 ? 0 : g; }   // Grad nach [0,360); -1e-15 + 360 rundet sonst auf 360

	// Mittlere Schiefe der Ekliptik, Meeus 22.2 (gekuerzt); T in Jahrhunderten, Ergebnis rad
	function schiefe(T) { return rad(23.439291 - 0.0130042 * T); }
	// Ekliptikale Laenge/Breite (rad) -> Einheitsvektor im Aequatorsystem (Drehung um +X um eps)
	function ausEkliptik(l, b, eps) {
		var x = Math.cos(b) * Math.cos(l), y = Math.cos(b) * Math.sin(l), z = Math.sin(b);
		return [x, y * Math.cos(eps) - z * Math.sin(eps), y * Math.sin(eps) + z * Math.cos(eps)];
	}
	// Vektor -> Rektaszension in [0,2pi) und Deklination (rad); Vektor muss nicht normiert sein
	function raDek(v) {
		var n = Math.hypot(v[0], v[1], v[2]);
		var ra = Math.atan2(v[1], v[0]); if (ra < 0) ra += ZWEI_PI; if (ra >= ZWEI_PI) ra = 0;   // winziges negatives ra rundet sonst auf 2pi
		return { ra: ra, dek: Math.asin(v[2] / n) };
	}

	// Sonne nach Meeus Kap. 25 (geometrisch, ohne Nutation/Aberration), mittleres Aequinoktium des Datums
	function sonne(jd) {
		var T = window.Zeit.T(jd);
		var L0 = norm(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
		var M = norm(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
		var e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
		var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(rad(M))
			+ (0.019993 - 0.000101 * T) * Math.sin(rad(2 * M)) + 0.000289 * Math.sin(rad(3 * M));
		var lambda = norm(L0 + C), nu = M + C;                                   // Grad
		var R = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(rad(nu)));        // AE
		var r = ausEkliptik(rad(lambda), 0, schiefe(T)), rd = raDek(r);
		return { richtung: r, abstandAE: R, ra: rd.ra, dek: rd.dek, lambda: lambda };
	}

	// Mond: Kurzverfahren des Astronomical Almanac (Genauigkeit etwa 0,3 Grad)
	function mond(jd) {
		var T = window.Zeit.T(jd);
		var l = 218.32 + 481267.881 * T
			+ 6.29 * Math.sin(rad(135.0 + 477198.87 * T)) - 1.27 * Math.sin(rad(259.3 - 413335.36 * T))
			+ 0.66 * Math.sin(rad(235.7 + 890534.22 * T)) + 0.21 * Math.sin(rad(269.9 + 954397.74 * T))
			- 0.19 * Math.sin(rad(357.5 + 35999.05 * T)) - 0.11 * Math.sin(rad(186.5 + 966404.03 * T));
		var b = 5.13 * Math.sin(rad(93.3 + 483202.02 * T)) + 0.28 * Math.sin(rad(228.2 + 960400.89 * T))
			- 0.28 * Math.sin(rad(318.3 + 6003.15 * T)) - 0.17 * Math.sin(rad(217.6 - 407332.21 * T));
		var par = 0.9508 + 0.0518 * Math.cos(rad(135.0 + 477198.87 * T)) + 0.0095 * Math.cos(rad(259.3 - 413335.36 * T))
			+ 0.0078 * Math.cos(rad(235.7 + 890534.22 * T)) + 0.0028 * Math.cos(rad(269.9 + 954397.74 * T));
		var abstandKm = ERDRADIUS_KM / Math.sin(rad(par));                     // Horizontalparallaxe -> Abstand
		var r = ausEkliptik(rad(norm(l)), rad(b), schiefe(T)), rd = raDek(r);
		var s = sonne(jd), cosPhi = r[0] * s.richtung[0] + r[1] * s.richtung[1] + r[2] * s.richtung[2];   // Elongation
		var elong = Math.acos(Math.max(-1, Math.min(1, cosPhi)));
		var beleuchtung = (1 - Math.cos(elong)) / 2;                    // Phasenwinkel ~ 180 - Elongation (Mond nah)
		var dLambda = norm(l - s.lambda);                               // Mond ekliptikal vor der Sonne = zunehmend
		var k = abstandKm / ERDRADIUS_KM;
		return { position: [r[0] * k, r[1] * k, r[2] * k], richtung: r,
			abstandKm: abstandKm, ra: rd.ra, dek: rd.dek, phase: dLambda / 360, zunehmend: dLambda < 180, beleuchtung: beleuchtung };
	}

	// Planeten: JPL-Naeherungselemente (Standish, 1800-2050), Werte bei J2000 und Raten je Jahrhundert;
	// a in AE, Winkel in Grad. "Earth" ist das Erde-Mond-Baryzentrum.
	var ELEMENTE = [ // name, a, da, e, de, I, dI, L, dL, varpi, dvarpi, Omega, dOmega
		["Mercury", 0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
		["Venus",   0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
		["Earth",   1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0.0, 0.0],
		["Mars",    1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
		["Jupiter", 5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
		["Saturn",  9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794]
	];
	// Heliozentrische ekliptikale Koordinaten (J2000) in AE
	function heliozentrisch(el, T) {
		var a = el[1] + el[2] * T, e = el[3] + el[4] * T, I = rad(el[5] + el[6] * T), L = el[7] + el[8] * T,
			vp = el[9] + el[10] * T, Om = rad(el[11] + el[12] * T);
		var om = rad(vp) - Om, M = rad(norm(L - vp)); if (M > Math.PI) M -= ZWEI_PI;   // Perihelargument, mittlere Anomalie
		// Kepler-Gleichung M = E - e sin E per Newton
		var E = M + e * Math.sin(M);
		for (var i = 0; i < 10; i++) {
			var dE = (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E)); E += dE;
			if (Math.abs(dE) < 1e-9) break;
		}
		var xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);   // in der Bahnebene
		var cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I), co = Math.cos(om), so = Math.sin(om);
		return [(co * cO - so * sO * cI) * xp + (-so * cO - co * sO * cI) * yp,
			(co * sO + so * cO * cI) * xp + (-so * sO + co * cO * cI) * yp,
			(so * sI) * xp + (co * sI) * yp];
	}
	// Absolute Helligkeit H (Magnitude bei 1 AE von Sonne und Erde), ohne Phasenterm
	var H_MAG = { Mercury: -0.613, Venus: -4.384, Mars: -1.601, Jupiter: -9.395, Saturn: -8.914 };
	// Geozentrische Planetenrichtungen in der Reihenfolge Mercury, Venus, Mars, Jupiter, Saturn,
	// im Aequatorsystem des Datums (wie Sonne, Mond und praezedierte Sterne)
	function planeten(jd) {
		var T = window.Zeit.T(jd), erde = heliozentrisch(ELEMENTE[2], T), s = sonne(jd), P = praezession(T), aus = [];
		var eps0 = schiefe(0), ce = Math.cos(eps0), se = Math.sin(eps0);        // J2000-Schiefe: die Elemente sind J2000
		ELEMENTE.forEach(function (el) {
			if (el[0] === "Earth") return;
			var p = heliozentrisch(el, T), g = [p[0] - erde[0], p[1] - erde[1], p[2] - erde[2]], d = Math.hypot(g[0], g[1], g[2]);
			// Ekliptik J2000 -> Aequator J2000
			var q = [g[0] / d, (g[1] * ce - g[2] * se) / d, (g[1] * se + g[2] * ce) / d];
			// Aequator J2000 -> Aequator des Datums (r = P q), danach nachnormieren (P ist Float32)
			var r = [P[0] * q[0] + P[1] * q[1] + P[2] * q[2], P[3] * q[0] + P[4] * q[1] + P[5] * q[2], P[6] * q[0] + P[7] * q[1] + P[8] * q[2]];
			var n = Math.hypot(r[0], r[1], r[2]); r = [r[0] / n, r[1] / n, r[2] / n];
			var cosE = r[0] * s.richtung[0] + r[1] * s.richtung[1] + r[2] * s.richtung[2];
			var rh = Math.hypot(p[0], p[1], p[2]);
			var magnitude = H_MAG[el[0]] + 5 * Math.log10(rh * d);                // ohne Phasenterm
			aus.push({ name: el[0], richtung: r, abstandAE: d,
				elongationGrad: Math.acos(Math.max(-1, Math.min(1, cosE))) / GRAD_ZU_RAD,
				magnitude: magnitude, helligkeit: Math.max(0.2, Math.min(1, (6 - magnitude) / 10)) });
		});
		return aus;
	}

	// Task 16: Lichtrichtung eines Planeten fuer die Scheiben-Sprites (reine
	// Funktion). Beide Koerper geozentrisch in AE: Sonne bei RS * dS, Planet bei
	// Delta * dP; l zeigt vom Planeten zur Sonne. Sprite-Rahmen des Planeten
	// (rechtshaendig, x rechts, y oben, z zum Betrachter): vorne = -dP,
	// rechts = normalize(dP x oben0) mit oben0 = +Z (Ersatz +X, wenn dP fast
	// parallel zu Z), oben = rechts x dP. Der Brief schrieb rechts = oben0 x dP;
	// das ist der Spiegelrahmen (rechts zeigte nach links), hier berichtigt.
	// anteil = (1 + licht.z) / 2: beleuchteter Anteil der Scheibe (1 Opposition
	// bzw. Vollphase, 0 untere Konjunktion). lichtWelt = l im Aequatorsystem, fuer
	// den Shader, der den Rahmen selbst im Blickraum aufbaut (Kamera-Roll inklusive).
	function kreuz(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
	function skalar(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
	function einheit(v) { var n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
	function phasenLicht(planet, sonne) {
		var dP = planet.richtung, dS = sonne.richtung, D = planet.abstandAE, RS = sonne.abstandAE;
		var l = einheit([dS[0] * RS - dP[0] * D, dS[1] * RS - dP[1] * D, dS[2] * RS - dP[2] * D]);
		var oben0 = Math.abs(dP[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1];
		var rechts = einheit(kreuz(dP, oben0)), oben = kreuz(rechts, dP);
		var licht = [skalar(l, rechts), skalar(l, oben), -skalar(l, dP)];
		return { licht: licht, anteil: (1 + licht[2]) / 2, lichtWelt: l };
	}

	// Praezession J2000 -> Datum (Meeus 21.2/21.3) als 3x3-Matrix auf Aequatorvektoren,
	// zeilenweise abgelegt: r' = M r, also r'[i] = M[3i] r[0] + M[3i+1] r[1] + M[3i+2] r[2]
	function praezession(T) {
		var zeta = rad((2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) / 3600),
			z = rad((2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) / 3600),
			th = rad((2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) / 3600);
		var cz = Math.cos(zeta), sz = Math.sin(zeta), cZ = Math.cos(z), sZ = Math.sin(z), ct = Math.cos(th), st = Math.sin(th);
		return new Float32Array([
			cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
			cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
			cz * st,                -sz * st,                ct]);
	}

	window.Himmel = { schiefe: schiefe, ausEkliptik: ausEkliptik, raDek: raDek, sonne: sonne, mond: mond,
		planeten: planeten, praezession: praezession, phasenLicht: phasenLicht };
})(window);
