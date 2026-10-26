/*
 * FRIDAYVFX Box Stack - Starrkoerpersimulation
 *
 * Dreidimensionale Starrkoerper: Quader und Kugeln auf einem Boden.
 *
 *   Kollision   Trennachsen-Test (SAT) ueber 15 Achsen fuer Quader-Quader; bei
 *               einer Flaechenachse wird die gegenueberliegende Flaeche gegen
 *               die Referenzflaeche beschnitten (Sutherland-Hodgman), das gibt
 *               bis zu vier Kontaktpunkte je Paar. Erst diese Mannigfaltigkeit
 *               macht Stapel stabil - ein einzelner Punkt je Paar kippt jeden
 *               Turm.
 *   Aufloesung  Sequentielle Impulse (Catto): aufsummierte Normal- und
 *               Reibimpulse, Coulomb-Kegel, Warmstart aus dem vorigen Schritt,
 *               Baumgarte-Korrektur mit Spielraum gegen Zittern.
 *   Ruhe        Koerper, die eine Weile stillstehen, schlafen ein und kosten
 *               nichts mehr; ein Stoss weckt sie.
 *
 * Kein WebGL, kein DOM - laesst sich in Node pruefen (tests/rbd_test.js).
 */
(function (global) {
	"use strict";

	// ------------------------------------------------------------ Vektoren
	function add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
	function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
	function skal(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
	function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
	function kreuz(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
	function laenge(a) { return Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]); }
	function norm(a) { var l = laenge(a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

	// Drehmatrix (zeilenweise, 9 Werte) aus einem Quaternion [x, y, z, w]
	function matrixAus(q) {
		var x = q[0], y = q[1], z = q[2], w = q[3];
		var xx = x*x, yy = y*y, zz = z*z, xy = x*y, xz = x*z, yz = y*z, wx = w*x, wy = w*y, wz = w*z;
		return [1-2*(yy+zz), 2*(xy-wz),   2*(xz+wy),
		        2*(xy+wz),   1-2*(xx+zz), 2*(yz-wx),
		        2*(xz-wy),   2*(yz+wx),   1-2*(xx+yy)];
	}
	function matVek(R, v) {
		return [R[0]*v[0] + R[1]*v[1] + R[2]*v[2],
		        R[3]*v[0] + R[4]*v[1] + R[5]*v[2],
		        R[6]*v[0] + R[7]*v[1] + R[8]*v[2]];
	}
	function matTVek(R, v) {
		return [R[0]*v[0] + R[3]*v[1] + R[6]*v[2],
		        R[1]*v[0] + R[4]*v[1] + R[7]*v[2],
		        R[2]*v[0] + R[5]*v[1] + R[8]*v[2]];
	}
	function spalte(R, i) { return [R[i], R[3+i], R[6+i]]; }
	var NULL_I = [0, 0, 0, 0, 0, 0, 0, 0, 0];

	function quatNorm(q) {
		var l = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]) || 1;
		q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
		return q;
	}
	// q += dt/2 * (w, 0) * q
	function quatSchritt(q, w, dt) {
		var x = q[0], y = q[1], z = q[2], s = q[3];
		var wx = w[0], wy = w[1], wz = w[2];
		q[0] += 0.5*dt*( wx*s + wy*z - wz*y);
		q[1] += 0.5*dt*( wy*s + wz*x - wx*z);
		q[2] += 0.5*dt*( wz*s + wx*y - wy*x);
		q[3] += 0.5*dt*(-wx*x - wy*y - wz*z);
		return quatNorm(q);
	}
	function quatAusAchse(achse, winkel) {
		var a = norm(achse), s = Math.sin(winkel / 2);
		return [a[0]*s, a[1]*s, a[2]*s, Math.cos(winkel / 2)];
	}

	// ------------------------------------------------------------ Koerper
	var naechsteId = 1;
	function Koerper(o) {
		this.id = naechsteId++;
		this.typ = o.typ || "box";
		this.p = o.p.slice();
		this.q = quatNorm((o.q || [0, 0, 0, 1]).slice());
		this.v = [0, 0, 0]; this.w = [0, 0, 0];
		this.vb = [0, 0, 0]; this.wb = [0, 0, 0];   // Korrekturgeschwindigkeit, je Schritt neu
		this.halb = o.halb ? o.halb.slice() : [0.5, 0.5, 0.5];
		this.r = o.r || 0.5;
		this.mu = o.mu === undefined ? 0.5 : o.mu;
		this.e = o.e === undefined ? 0.1 : o.e;
		this.farbe = o.farbe || 0;
		var m = o.masse === undefined ? 1 : o.masse;
		this.masse = m;
		this.invM = m > 0 ? 1 / m : 0;
		if (this.typ === "box") {
			var hx = this.halb[0], hy = this.halb[1], hz = this.halb[2];
			// volle Kantenlaengen: I = m/12 * (b^2 + c^2)
			var Ix = m / 3 * (hy*hy + hz*hz), Iy = m / 3 * (hx*hx + hz*hz), Iz = m / 3 * (hx*hx + hy*hy);
			this.invIlokal = m > 0 ? [1/Ix, 1/Iy, 1/Iz] : [0, 0, 0];
		} else {
			var I = 2 / 5 * m * this.r * this.r;
			this.invIlokal = m > 0 ? [1/I, 1/I, 1/I] : [0, 0, 0];
		}
		this.schlaeft = false; this.ruhe = 0;
		this.treffer = 0;                       // staerkster Aufprall, fuer die Anzeige
		this.aktualisiere();
	}
	Koerper.prototype.aktualisiere = function () {
		this.R = matrixAus(this.q);
		// Traegheit in Weltkoordinaten: R * diag(invI) * R^T
		var R = this.R, d = this.invIlokal, I = new Array(9);
		for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) {
			I[r*3+c] = R[r*3]*d[0]*R[c*3] + R[r*3+1]*d[1]*R[c*3+1] + R[r*3+2]*d[2]*R[c*3+2];
		}
		this.invI = I;
		// Huellquader
		if (this.typ === "box") {
			var ex = Math.abs(R[0])*this.halb[0] + Math.abs(R[1])*this.halb[1] + Math.abs(R[2])*this.halb[2];
			var ey = Math.abs(R[3])*this.halb[0] + Math.abs(R[4])*this.halb[1] + Math.abs(R[5])*this.halb[2];
			var ez = Math.abs(R[6])*this.halb[0] + Math.abs(R[7])*this.halb[1] + Math.abs(R[8])*this.halb[2];
			this.min = [this.p[0]-ex, this.p[1]-ey, this.p[2]-ez];
			this.max = [this.p[0]+ex, this.p[1]+ey, this.p[2]+ez];
		} else {
			var rr = this.r;
			this.min = [this.p[0]-rr, this.p[1]-rr, this.p[2]-rr];
			this.max = [this.p[0]+rr, this.p[1]+rr, this.p[2]+rr];
		}
	};
	Koerper.prototype.wecke = function () { this.schlaeft = false; this.ruhe = 0; };
	Koerper.prototype.impuls = function (P, punkt) {
		if (this.invM === 0) return;
		this.wecke();
		this.v = add(this.v, skal(P, this.invM));
		var r = sub(punkt, this.p);
		this.w = add(this.w, matVek(this.invI, kreuz(r, P)));
	};

	// --------------------------------------------------- Kollision Quader
	/*
	 * Liefert die Kontaktpunkte zweier Quader oder null. Normale zeigt von A
	 * nach B; die Tiefe ist positiv bei Durchdringung.
	 */
	function quaderQuader(A, B) {
		var d = sub(B.p, A.p);
		var ax = [spalte(A.R, 0), spalte(A.R, 1), spalte(A.R, 2)];
		var bx = [spalte(B.R, 0), spalte(B.R, 1), spalte(B.R, 2)];
		var beste = Infinity, besteAchse = null, besteNr = -1, i, j;

		function pruefe(L, nr, istKante) {
			var l = laenge(L);
			if (l < 1e-6) return true;
			L = skal(L, 1 / l);
			var ra = A.halb[0]*Math.abs(dot(ax[0], L)) + A.halb[1]*Math.abs(dot(ax[1], L)) + A.halb[2]*Math.abs(dot(ax[2], L));
			var rb = B.halb[0]*Math.abs(dot(bx[0], L)) + B.halb[1]*Math.abs(dot(bx[1], L)) + B.halb[2]*Math.abs(dot(bx[2], L));
			var abstand = Math.abs(dot(d, L));
			var tiefe = ra + rb - abstand;
			if (tiefe < 0) return false;
			// Flaechen leicht bevorzugen: Kantenkontakte wechseln sonst bei
			// nahezu gleicher Tiefe hin und her und der Stapel zittert
			var gewichtet = istKante ? tiefe * 1.05 + 0.001 : tiefe;
			if (gewichtet < beste) {
				beste = gewichtet; besteAchse = dot(d, L) < 0 ? skal(L, -1) : L; besteNr = nr;
				besteTiefe = tiefe;
			}
			return true;
		}
		var besteTiefe = 0;
		for (i = 0; i < 3; i++) if (!pruefe(ax[i], i, false)) return null;
		for (i = 0; i < 3; i++) if (!pruefe(bx[i], 3 + i, false)) return null;
		for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) {
			if (!pruefe(kreuz(ax[i], bx[j]), 6 + i*3 + j, true)) return null;
		}
		if (!besteAchse) return null;
		var n = besteAchse, kontakte = [];

		if (besteNr < 6) {
			// Flaechenfall: Referenz ist der Quader, dem die Achse gehoert
			var ref = besteNr < 3 ? A : B, inc = besteNr < 3 ? B : A;
			var nRef = besteNr < 3 ? n : skal(n, -1);     // von ref zu inc
			var rAch = besteNr < 3 ? ax : bx, iAch = besteNr < 3 ? bx : ax;
			// Referenzflaeche: Achse mit groesster Uebereinstimmung
			var rIdx = 0, rBest = -1, k;
			for (k = 0; k < 3; k++) { var dk = Math.abs(dot(rAch[k], nRef)); if (dk > rBest) { rBest = dk; rIdx = k; } }
			var rN = dot(rAch[rIdx], nRef) > 0 ? rAch[rIdx] : skal(rAch[rIdx], -1);
			var rMitte = add(ref.p, skal(rN, ref.halb[rIdx]));
			var u = rAch[(rIdx+1)%3], hu = ref.halb[(rIdx+1)%3];
			var vv = rAch[(rIdx+2)%3], hv = ref.halb[(rIdx+2)%3];
			// Einfallende Flaeche: die Achse mit dem groessten BETRAG des
			// Skalarprodukts, dann so gedreht, dass sie zur Referenz zeigt.
			// Das rohe Vorzeichen zu vergleichen war der Fehler: bei einem
			// aufrechten Stapel (Skalarprodukt +1) fiel die Wahl auf eine
			// Seitenflaeche statt auf die Unterseite, und jeder Turm kippte.
			var iIdx = 0, iBest = -1;
			for (k = 0; k < 3; k++) { var ek = Math.abs(dot(iAch[k], nRef)); if (ek > iBest) { iBest = ek; iIdx = k; } }
			var iN = dot(iAch[iIdx], nRef) > 0 ? skal(iAch[iIdx], -1) : iAch[iIdx];
			// Ausrichtung wie oben, aber fuer die Vorzeichenwahl der Seitenachsen
			var iMitte = add(inc.p, skal(iN, inc.halb[iIdx]));
			var iu = iAch[(iIdx+1)%3], ihu = inc.halb[(iIdx+1)%3];
			var iv = iAch[(iIdx+2)%3], ihv = inc.halb[(iIdx+2)%3];
			var poly = [
				add(add(iMitte, skal(iu,  ihu)), skal(iv,  ihv)),
				add(add(iMitte, skal(iu,  ihu)), skal(iv, -ihv)),
				add(add(iMitte, skal(iu, -ihu)), skal(iv, -ihv)),
				add(add(iMitte, skal(iu, -ihu)), skal(iv,  ihv))
			];
			// Gegen die vier Seitenebenen der Referenzflaeche beschneiden
			[[u, hu], [skal(u, -1), hu], [vv, hv], [skal(vv, -1), hv]].forEach(function (ebene) {
				var s = ebene[0], grenze = dot(s, ref.p) + ebene[1], aus = [], m = poly.length;
				for (var q = 0; q < m; q++) {
					var P = poly[q], Q = poly[(q+1)%m];
					var dp = dot(s, P) - grenze, dq = dot(s, Q) - grenze;
					if (dp <= 0) aus.push(P);
					if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
						var t = dp / (dp - dq);
						aus.push(add(P, skal(sub(Q, P), t)));
					}
				}
				poly = aus;
			});
			var ebeneD = dot(rN, rMitte);
			poly.forEach(function (P) {
				var tiefe = ebeneD - dot(rN, P);
				if (tiefe < -0.002) return;
				kontakte.push({ p: add(P, skal(rN, tiefe / 2)), tiefe: Math.max(0, tiefe) });
			});
			if (kontakte.length > 4) {
				kontakte.sort(function (a, b) { return b.tiefe - a.tiefe; });
				kontakte.length = 4;
			}
		} else {
			// Kantenfall: die beiden stuetzenden Kanten, ihre naechsten Punkte
			var ia = ((besteNr - 6) / 3) | 0, jb = (besteNr - 6) % 3;
			var pa = A.p.slice(), pb = B.p.slice();
			for (k = 0; k < 3; k++) {
				if (k !== ia) pa = add(pa, skal(ax[k], A.halb[k] * (dot(ax[k], n) > 0 ? 1 : -1)));
				if (k !== jb) pb = add(pb, skal(bx[k], B.halb[k] * (dot(bx[k], n) > 0 ? -1 : 1)));
			}
			var ea = ax[ia], eb = bx[jb];
			var r = sub(pa, pb), aa = dot(ea, ea), bb = dot(eb, eb), ab = dot(ea, eb);
			var ar = dot(ea, r), br = dot(eb, r), det = aa*bb - ab*ab;
			var s = det > 1e-9 ? (ab*br - bb*ar) / det : 0, t = det > 1e-9 ? (aa*br - ab*ar) / det : 0;
			s = Math.max(-A.halb[ia], Math.min(A.halb[ia], s));
			t = Math.max(-B.halb[jb], Math.min(B.halb[jb], t));
			var qa = add(pa, skal(ea, s)), qb = add(pb, skal(eb, t));
			kontakte.push({ p: skal(add(qa, qb), 0.5), tiefe: besteTiefe });
		}
		if (!kontakte.length) return null;
		return { n: n, punkte: kontakte };
	}

	// Kugel gegen Quader: naechster Punkt des Quaders zur Kugelmitte
	function quaderKugel(Q, K) {
		var lokal = matTVek(Q.R, sub(K.p, Q.p));
		var ge = [Math.max(-Q.halb[0], Math.min(Q.halb[0], lokal[0])),
		          Math.max(-Q.halb[1], Math.min(Q.halb[1], lokal[1])),
		          Math.max(-Q.halb[2], Math.min(Q.halb[2], lokal[2]))];
		var naechst = add(Q.p, matVek(Q.R, ge));
		var d = sub(K.p, naechst), dist = laenge(d);
		if (dist > K.r) return null;
		var n = dist > 1e-6 ? skal(d, 1 / dist) : [0, 1, 0];
		return { n: n, punkte: [{ p: naechst, tiefe: K.r - dist }] };
	}

	function kugelKugel(A, B) {
		var d = sub(B.p, A.p), dist = laenge(d);
		if (dist > A.r + B.r) return null;
		var n = dist > 1e-6 ? skal(d, 1 / dist) : [0, 1, 0];
		return { n: n, punkte: [{ p: add(A.p, skal(n, A.r - (A.r + B.r - dist) / 2)), tiefe: A.r + B.r - dist }] };
	}

	// Boden y = 0: alle Ecken unter Null sind Kontakte
	function bodenQuader(Q) {
		var punkte = [], R = Q.R, h = Q.halb;
		for (var i = 0; i < 8; i++) {
			var l = [(i & 1 ? 1 : -1) * h[0], (i & 2 ? 1 : -1) * h[1], (i & 4 ? 1 : -1) * h[2]];
			var w = add(Q.p, matVek(R, l));
			if (w[1] < 0) punkte.push({ p: [w[0], w[1] / 2, w[2]], tiefe: -w[1] });
		}
		if (!punkte.length) return null;
		if (punkte.length > 4) { punkte.sort(function (a, b) { return b.tiefe - a.tiefe; }); punkte.length = 4; }
		return { n: [0, 1, 0], punkte: punkte };
	}
	function bodenKugel(K) {
		var t = K.r - K.p[1];
		if (t < 0) return null;
		return { n: [0, 1, 0], punkte: [{ p: [K.p[0], (K.p[1] - K.r) / 2, K.p[2]], tiefe: t }] };
	}

	// ---------------------------------------------------------------- Welt
	function Welt(o) {
		o = o || {};
		this.g = o.g === undefined ? 9.81 : o.g;
		this.iterationen = o.iterationen || 10;
		// Vier Unterschritte je 60-Hz-Schritt, also 240 Teilschritte je Sekunde.
		// Gemessen: bei 120/s driftet ein Achter-Turm 40 mm in sechs Sekunden und
		// schlaeft nie ein, bei 240/s bleibt er bei 12 mm und schlaeft. Mehr
		// Iterationen oder eine andere Kontaktreihenfolge aenderten daran nichts.
		this.unterschritte = o.unterschritte || 4;
		// Kontakte von unten nach oben loesen - schaltbar, weil es sich in der
		// Messung nicht bewaehrt hat (sortiert 19 mm Drift, unsortiert 12 mm).
		this.ordne = o.ordne === undefined ? false : o.ordne;
		this.koerper = [];
		this.boden = new Koerper({ typ: "boden", p: [0, 0, 0], masse: 0 });
		this.boden.mu = o.bodenMu === undefined ? 0.6 : o.bodenMu;
		this.boden.e = 0.05;
		this.kontakte = [];
		this.alteKontakte = [];
		this.zeit = 0;
		this.anzWach = 0;
		this.msSchritt = 0;
		this.beiAufprall = null;                 // Rueckruf(koerper, staerke)
	}

	Welt.prototype.boxHinzu = function (o) { o.typ = "box"; var k = new Koerper(o); this.koerper.push(k); return k; };
	Welt.prototype.kugelHinzu = function (o) { o.typ = "kugel"; var k = new Koerper(o); this.koerper.push(k); return k; };
	Welt.prototype.entferne = function (k) { var i = this.koerper.indexOf(k); if (i >= 0) this.koerper.splice(i, 1); };
	Welt.prototype.leere = function () { this.koerper = []; this.kontakte = []; this.alteKontakte = []; };
	Welt.prototype.weckeAlle = function () { this.koerper.forEach(function (k) { k.wecke(); }); };

	Welt.prototype.schritt = function (dt) {
		var t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
		var h = dt / this.unterschritte;
		for (var s = 0; s < this.unterschritte; s++) this.unterschritt(h);
		this.zeit += dt;
		var t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
		this.msSchritt = t1 - t0;
	};

	Welt.prototype.unterschritt = function (dt) {
		var K = this.koerper, i, j, k, n = K.length;

		// 1. Schwerkraft, Ausrichtung, Huellquader
		for (i = 0; i < n; i++) {
			var b = K[i];
			b.vb[0] = b.vb[1] = b.vb[2] = 0; b.wb[0] = b.wb[1] = b.wb[2] = 0;
			if (b.invM === 0 || b.schlaeft) { b.aktualisiere(); continue; }
			b.v[1] -= this.g * dt;
			b.aktualisiere();
		}

		// 2. Grobe Phase: nach x sortieren und ueberstreichen
		var reihe = K.slice().sort(function (a, b2) { return a.min[0] - b2.min[0]; });
		var paare = [];
		for (i = 0; i < n; i++) {
			var a = reihe[i];
			for (j = i + 1; j < n; j++) {
				var c = reihe[j];
				if (c.min[0] > a.max[0]) break;
				if (a.invM === 0 && c.invM === 0) continue;
				if (a.schlaeft && c.schlaeft) continue;
				if (a.min[1] > c.max[1] || c.min[1] > a.max[1]) continue;
				if (a.min[2] > c.max[2] || c.min[2] > a.max[2]) continue;
				// Feste Reihenfolge nach Kennung. Aus der x-Sortierung heraus kippte
				// sie bei Boxen mit gleichem x - einem Turm - von Schritt zu Schritt,
				// die Normale drehte sich um und der Warmstart fand nie sein Gegenstueck.
				paare.push(a.id < c.id ? [a, c] : [c, a]);
			}
		}

		// 3. Feine Phase
		var kontakte = [], self = this;
		function nimm(A, B, erg) {
			if (!erg) return;
			// Ein Schlafender wird geweckt, wenn ihn etwas Bewegtes beruehrt
			var vA = laenge(A.v) + laenge(A.w) * 0.3, vB = laenge(B.v) + laenge(B.w) * 0.3;
			if (A.schlaeft && !B.schlaeft && vB > 0.25) A.wecke();
			if (B.schlaeft && !A.schlaeft && vA > 0.25) B.wecke();
			if (A.schlaeft && B.schlaeft) return;
			erg.punkte.forEach(function (pt) {
				kontakte.push({ a: A, b: B, n: erg.n, p: pt.p, tiefe: pt.tiefe, jn: 0, jt1: 0, jt2: 0, jb: 0 });
			});
		}
		for (i = 0; i < paare.length; i++) {
			var A = paare[i][0], B = paare[i][1];
			if (A.typ === "box" && B.typ === "box") nimm(A, B, quaderQuader(A, B));
			else if (A.typ === "box" && B.typ === "kugel") nimm(A, B, quaderKugel(A, B));
			else if (A.typ === "kugel" && B.typ === "box") nimm(B, A, quaderKugel(B, A));
			else nimm(A, B, kugelKugel(A, B));
		}
		for (i = 0; i < n; i++) {
			var kb = K[i];
			if (kb.invM === 0 || kb.schlaeft) continue;
			if (kb.min[1] > 0) continue;
			nimm(this.boden, kb, kb.typ === "box" ? bodenQuader(kb) : bodenKugel(kb));
		}

		if (this.ordne) kontakte.sort(function (x, y) { return x.p[1] - y.p[1]; });

		// 4. Vorbereiten: Massen, Tangenten, Bias, Warmstart
		var alt = this.alteKontakte, m;
		for (i = 0; i < kontakte.length; i++) {
			var c2 = kontakte[i], a2 = c2.a, b2 = c2.b, nn = c2.n;
			c2.ra = sub(c2.p, a2.p); c2.rb = sub(c2.p, b2.p);
			var ran = kreuz(c2.ra, nn), rbn = kreuz(c2.rb, nn);
			var kn = iM(a2) + iM(b2)
			       + dot(nn, kreuz(matVek(iI(a2), ran), c2.ra))
			       + dot(nn, kreuz(matVek(iI(b2), rbn), c2.rb));
			c2.mN = kn > 0 ? 1 / kn : 0;
			// Tangenten fest aus der Normalen, nicht aus der Gleitrichtung: die
			// warmgestarteten Reibimpulse gelten fuer die Richtungen des vorigen
			// Schritts. Wechseln die Richtungen mit der Bewegung, zeigen die
			// Impulse ins Leere - und ruhende Stapel kriechen.
			var dv = sub(add(b2.v, kreuz(b2.w, c2.rb)), add(a2.v, kreuz(a2.w, c2.ra)));
			var vn = dot(dv, nn);
			var t1 = norm(Math.abs(nn[0]) < 0.9 ? kreuz(nn, [1, 0, 0]) : kreuz(nn, [0, 0, 1]));
			var t2 = kreuz(nn, t1);
			c2.t1 = t1; c2.t2 = t2;
			[t1, t2].forEach(function (t, idx) {
				var rat = kreuz(c2.ra, t), rbt = kreuz(c2.rb, t);
				var kt = iM(a2) + iM(b2)
				       + dot(t, kreuz(matVek(iI(a2), rat), c2.ra))
				       + dot(t, kreuz(matVek(iI(b2), rbt), c2.rb));
				if (idx === 0) c2.mT1 = kt > 0 ? 1 / kt : 0; else c2.mT2 = kt > 0 ? 1 / kt : 0;
			});
			c2.mu = Math.sqrt(a2.mu * b2.mu);
			c2.e = Math.max(a2.e, b2.e);
			// Baumgarte: Durchdringung ueber dem Spielraum wird herausgeschoben
			c2.bias = (0.25 / dt) * Math.max(0, c2.tiefe - 0.003);
			// Restitution nur bei nennenswertem Aufprall
			c2.ziel = vn < -0.8 ? -c2.e * vn : 0;
			if (vn < -1.0) {
				var st = -vn;
				if (st > a2.treffer) a2.treffer = st;
				if (st > b2.treffer) b2.treffer = st;
				if (self.beiAufprall) self.beiAufprall(b2.invM ? b2 : a2, st);
			}
			// Warmstart: passenden Kontakt aus dem vorigen Schritt suchen
			for (m = 0; m < alt.length; m++) {
				var o2 = alt[m];
				if (o2.a !== a2 || o2.b !== b2) continue;
				var dd = sub(o2.p, c2.p);
				if (dot(dd, dd) < 0.0004) {
					c2.jn = o2.jn; c2.jt1 = o2.jt1; c2.jt2 = o2.jt2;
					o2.a = null;                 // nicht doppelt vergeben
					break;
				}
			}
			var P = add(add(skal(nn, c2.jn), skal(t1, c2.jt1)), skal(t2, c2.jt2));
			wende(a2, b2, c2, P);
		}

		/*
		 * Schlafende Koerper wirken im Loeser als statisch. Vorher bekamen sie
		 * weiter Impulse, wurden aber weder bewegt noch genullt - sie sammelten
		 * Geschwindigkeit an, gegen die ihre Nachbarn ewig anzitterten.
		 */
		function iM(k) { return k.schlaeft ? 0 : k.invM; }
		function iI(k) { return k.schlaeft ? NULL_I : k.invI; }
		/*
		 * Split-Impulse: die Durchdringung wird ueber eigene Bias-Geschwindigkeiten
		 * herausgeschoben, die nur die Lage aendern und danach verworfen werden.
		 * Steckte die Korrektur in der echten Geschwindigkeit, pumpte sie in einem
		 * hohen Turm bei jedem Schritt Energie nach - er zitterte und schlief nie.
		 */
		function wendeBias(A, B, c, P) {
			if (iM(A)) { A.vb = sub(A.vb, skal(P, A.invM)); A.wb = sub(A.wb, matVek(A.invI, kreuz(c.ra, P))); }
			if (iM(B)) { B.vb = add(B.vb, skal(P, B.invM)); B.wb = add(B.wb, matVek(B.invI, kreuz(c.rb, P))); }
		}
		function wende(A, B, c, P) {
			if (iM(A)) {
				A.v = sub(A.v, skal(P, A.invM));
				A.w = sub(A.w, matVek(A.invI, kreuz(c.ra, P)));
			}
			if (iM(B)) {
				B.v = add(B.v, skal(P, B.invM));
				B.w = add(B.w, matVek(B.invI, kreuz(c.rb, P)));
			}
		}

		// 5. Sequentielle Impulse
		for (k = 0; k < this.iterationen; k++) {
			for (i = 0; i < kontakte.length; i++) {
				var c3 = kontakte[i], A3 = c3.a, B3 = c3.b, n3 = c3.n;
				var dv3 = sub(add(B3.v, kreuz(B3.w, c3.rb)), add(A3.v, kreuz(A3.w, c3.ra)));
				var vn3 = dot(dv3, n3);
				var lam = c3.mN * (c3.ziel - vn3);
				var neu = Math.max(0, c3.jn + lam);
				lam = neu - c3.jn; c3.jn = neu;
				if (lam !== 0) wende(A3, B3, c3, skal(n3, lam));
				// Lagekorrektur getrennt, auf den Bias-Geschwindigkeiten
				if (c3.bias > 0) {
					var dvb = sub(add(B3.vb, kreuz(B3.wb, c3.rb)), add(A3.vb, kreuz(A3.wb, c3.ra)));
					var lb = c3.mN * (c3.bias - dot(dvb, n3));
					var nb = Math.max(0, c3.jb + lb);
					lb = nb - c3.jb; c3.jb = nb;
					if (lb !== 0) wendeBias(A3, B3, c3, skal(n3, lb));
				}
				// Reibung, zwei Richtungen
				dv3 = sub(add(B3.v, kreuz(B3.w, c3.rb)), add(A3.v, kreuz(A3.w, c3.ra)));
				var grenze = c3.mu * c3.jn;
				var l1 = -c3.mT1 * dot(dv3, c3.t1);
				var n1 = Math.max(-grenze, Math.min(grenze, c3.jt1 + l1));
				l1 = n1 - c3.jt1; c3.jt1 = n1;
				if (l1 !== 0) wende(A3, B3, c3, skal(c3.t1, l1));
				dv3 = sub(add(B3.v, kreuz(B3.w, c3.rb)), add(A3.v, kreuz(A3.w, c3.ra)));
				var l2 = -c3.mT2 * dot(dv3, c3.t2);
				var n2 = Math.max(-grenze, Math.min(grenze, c3.jt2 + l2));
				l2 = n2 - c3.jt2; c3.jt2 = n2;
				if (l2 !== 0) wende(A3, B3, c3, skal(c3.t2, l2));
			}
		}

		// 6. Bewegung und Daempfung
		for (i = 0; i < n; i++) {
			var b4 = K[i];
			if (b4.invM === 0 || b4.schlaeft) continue;
			b4.p = add(b4.p, skal(add(b4.v, b4.vb), dt));
			quatSchritt(b4.q, add(b4.w, b4.wb), dt);
			b4.v = skal(b4.v, 1 - 0.004 * dt * 60);
			b4.w = skal(b4.w, 1 - 0.010 * dt * 60);
			var energie = dot(b4.v, b4.v) + 0.5 * dot(b4.w, b4.w);
			if (energie < 0.0009) { b4.ruhe += dt; } else { b4.ruhe = 0; }
			b4.treffer *= Math.exp(-4 * dt);
		}

		/*
		 * 7. Schlafen, inselweise. Ein Koerper allein darf nicht einschlafen,
		 * solange etwas, das ihn beruehrt, noch in Bewegung ist - sonst wird
		 * das unterste Glied eines Turms zur unbewegten Wand, gegen die der
		 * Rest ewig anzittert. Zusammenhaengende Koerper (Union-Find ueber die
		 * Kontakte) schlafen gemeinsam ein oder gar nicht.
		 */
		var index = {}, eltern = [];
		for (i = 0; i < n; i++) { index[K[i].id] = i; eltern.push(i); }
		function wurzel(x) { while (eltern[x] !== x) { eltern[x] = eltern[eltern[x]]; x = eltern[x]; } return x; }
		for (i = 0; i < kontakte.length; i++) {
			var ka = kontakte[i].a, kb = kontakte[i].b;
			if (ka.invM === 0 || kb.invM === 0) continue;
			var ra2 = wurzel(index[ka.id]), rb2 = wurzel(index[kb.id]);
			if (ra2 !== rb2) eltern[ra2] = rb2;
		}
		var inselRuhe = {};
		for (i = 0; i < n; i++) {
			if (K[i].invM === 0) continue;
			var wz = wurzel(i);
			var ruhig = K[i].schlaeft || K[i].ruhe > 0.45;
			inselRuhe[wz] = (inselRuhe[wz] === undefined ? true : inselRuhe[wz]) && ruhig;
		}
		var wach = 0;
		for (i = 0; i < n; i++) {
			var b5 = K[i];
			if (b5.invM === 0) continue;
			if (!b5.schlaeft && inselRuhe[wurzel(i)]) { b5.schlaeft = true; b5.v = [0, 0, 0]; b5.w = [0, 0, 0]; }
			if (!b5.schlaeft) wach++;
		}
		this.anzWach = wach;
		this.kontakte = kontakte;
		this.alteKontakte = kontakte;
	};

	global.RBD = { Welt: Welt, Koerper: Koerper, quatAusAchse: quatAusAchse, matrixAus: matrixAus,
	               quaderQuader: quaderQuader };
})(typeof window !== "undefined" ? window : globalThis);
