/*
 * FRIDAYVFX Pinball - Physik
 *
 * Zweidimensional in der Ebene des Spielfelds. Das ist keine Vereinfachung,
 * sondern die Sache selbst: Die Kugel verlaesst das Feld nicht, die Schwerkraft
 * wirkt als g*sin(Neigung) den Tisch hinunter.
 *
 * Drei Dinge unterscheiden diese Fassung von einer naiven:
 *
 * 1. ECHTE ZEITPUNKTE DES AUFPRALLS statt Prueffen nach dem Schritt.
 *    Die Kugel wird nur bis zum ersten Kontakt bewegt, dort aufgeloest, dann
 *    weiter mit der Restzeit. Eine Kugel mit 6 m/s legt pro Bild 10 cm zurueck -
 *    das ist mehr als jede Bandendicke. Ohne Zeitpunktsuche geht sie hindurch.
 *
 * 2. DRALL. Die Kugel hat eine Winkelgeschwindigkeit, die ueber die Reibung am
 *    Kontaktpunkt entsteht und den naechsten Abprall veraendert. Genau das macht
 *    das Verhalten eines Flippers aus: eine angeschnittene Kugel laeuft anders
 *    weiter als eine gerade getroffene.
 *
 * 3. IMPULSE statt Spiegelung. Normal- und Tangentialimpuls werden getrennt
 *    berechnet, die Reibung durch den Coulomb-Kegel begrenzt. Dadurch bleiben
 *    mehrere gleichzeitige Kontakte stabil, statt von der Reihenfolge abzuhaengen.
 *
 * Alles in Metern und Sekunden. Ein echter Tisch ist 0,52 m breit, die Kugel
 * hat 27 mm Durchmesser und wiegt 80 g.
 */
(function (global) {
	"use strict";

	var EPS = 1e-7;

	// Traegheitsmoment einer Vollkugel: I = 2/5 * m * r^2
	// Fuer die Impulsrechnung wird nur r^2/I gebraucht = 5/(2m)
	function Physik(opt) {
		this.r      = opt.kugelR;
		this.m      = opt.kugelM;
		this.invM   = 1 / opt.kugelM;
		this.invI   = 5 / (2 * opt.kugelM * opt.kugelR * opt.kugelR);
		this.g      = opt.g;
		this.rollmu = opt.rollmu;      // Rollwiderstand
		this.luft   = opt.luft;        // geschwindigkeitsabhaengige Daempfung

		this.p  = [0, 0];
		this.v  = [0, 0];
		this.w  = 0;                   // Drall um die Flaechennormale
		this.aktiv = false;

		this.segmente = [];
		this.scheiben = [];
		this.flipper  = [];
		this.stoss = [0, 0];           // Beschleunigung durch Ruetteln
		// Rueckruf(art, staerke, x, y, objekt, gefeuert) bei jedem Kontakt mit
		// Impuls; `gefeuert` sagt, ob ein Kicker (Sling, Bumper) seinen
		// Zusatzstoss wirklich gegeben hat (Spielgefuehl Paket 2a).
		this.beiTreffer = null;
		// Simulationszeit und Sperren der Kicker: [objekt, gesperrt bis]
		this.zeit = 0;
		this.kickSperren = [];
		// Altes Kontaktverhalten (vor Spielgefuehl Paket 1), nur zum Vergleich
		// per ?alt=1: Austrittswurzel als Treffer, Zusatzstoss bei jeder
		// Beruehrung, kein Ausschluss von Treffern ohne Impuls.
		this.kontaktAlt = !!opt.kontaktAlt;
	}

	Physik.prototype.setzeKugel = function (x, y) {
		this.p[0] = x; this.p[1] = y;
		this.v[0] = 0; this.v[1] = 0;
		this.w = 0;
		this.aktiv = true;
	};

	// ------------------------------------------------------ Zeitpunkt des Aufpralls
	// Kugel (Radius r) gegen Kapsel (Strecke a-b mit Radius R) entspricht einem
	// PUNKT gegen eine Kapsel mit Radius (r+R). Das macht beide Faelle - Wand und
	// Rundung an den Enden - zu einer einzigen Rechnung.
	//
	// Ein Treffer ist nur ANNAEHERUNG. Liegt die Kugel schon auf oder in der
	// Grenze und naehert sich, gilt t = 0; entfernt sie sich, ist das kein
	// Treffer. Frueher zaehlte auch die Austrittswurzel: eine Kugel auf der
	// Grenze, die sich entfernte, meldete t = 0 ohne Impuls und stand dann
	// acht Runden lang still, jeden Unterschritt - auf dem Flipper ging sie
	// erst beim Loslassen ab. `alt` (Physik.kontaktAlt, ?alt=1) rechnet fuer
	// den Vergleich noch so.
	function toiKapsel(px, py, vx, vy, ax, ay, bx, by, R, tmax, alt) {
		var dx = bx - ax, dy = by - ay;
		var laenge2 = dx * dx + dy * dy;
		var besteT = tmax, nx = 0, ny = 0, gefunden = false;

		if (laenge2 > EPS) {
			// Zylindrischer Teil: Abstand zur Geraden wird R
			var ux = dx, uy = dy;                       // Richtung, ungenormt
			var rx = px - ax, ry = py - ay;
			// Anteile senkrecht zur Achse
			var qx = rx * uy - ry * ux;                 // Kreuzprodukt (z-Komponente)
			var qv = vx * uy - vy * ux;
			if (Math.abs(qv) > EPS) {
				var ziel = R * Math.sqrt(laenge2), tk;
				if (alt) {
					// ALTER PFAD (nur ?alt=1): |q + t*qv| = ziel, die kleinere
					// nichtnegative Wurzel - auch die, bei der die Kugel austritt
					var t1 = (-ziel - qx) / qv, t2 = (ziel - qx) / qv;
					tk = Math.min(t1 < 0 ? Infinity : t1, t2 < 0 ? Infinity : t2);
				} else {
					// Nur die Wurzel auf der Seite der Kugel, und nur wenn |q|
					// abnimmt (qx und qv mit verschiedenem Vorzeichen). Schon auf
					// oder in der Grenze: sofort.
					var seite = qx >= 0 ? 1 : -1;
					tk = seite * qv < 0 ? Math.max(0, (seite * ziel - qx) / qv) : Infinity;
				}
				if (tk >= 0 && tk < besteT) {
					// Liegt der Beruehrpunkt innerhalb der Strecke?
					var cx = px + vx * tk, cy = py + vy * tk;
					var s = ((cx - ax) * dx + (cy - ay) * dy) / laenge2;
					if (s >= 0 && s <= 1) {
						var fx = cx - (ax + dx * s), fy = cy - (ay + dy * s);
						var fl = Math.hypot(fx, fy);
						if (fl > EPS) {
							besteT = tk; nx = fx / fl; ny = fy / fl; gefunden = true;
						}
					}
				}
			}
		}

		// Kappen an den Enden: Punkt gegen Kreis mit Radius R
		var enden = [[ax, ay], [bx, by]], i;
		for (i = 0; i < 2; i++) {
			var ex = px - enden[i][0], ey = py - enden[i][1];
			var A = vx * vx + vy * vy;
			if (A < EPS) continue;
			var B = 2 * (ex * vx + ey * vy);
			var C = ex * ex + ey * ey - R * R;
			var disk = B * B - 4 * A * C;
			if (disk < 0) continue;
			var wz = Math.sqrt(disk), te;
			if (alt) {
				// ALTER PFAD (nur ?alt=1): notfalls die zweite Wurzel - die
				// Austrittswurzel, auch wenn sich die Kugel entfernt
				te = (-B - wz) / (2 * A);
				if (te < 0) te = (-B + wz) / (2 * A);
				if (te < 0) continue;
			} else {
				if (B >= 0) continue;                   // entfernt sich vom Kappenmittelpunkt
				te = Math.max(0, (-B - wz) / (2 * A));  // schon auf/in der Grenze: sofort
			}
			if (te >= besteT) continue;
			var kx = px + vx * te - enden[i][0], ky = py + vy * te - enden[i][1];
			var kl = Math.hypot(kx, ky);
			if (kl < EPS) continue;
			besteT = te; nx = kx / kl; ny = ky / kl; gefunden = true;
		}

		return gefunden ? { t: besteT, nx: nx, ny: ny } : null;
	}

	// ------------------------------------------------------------- Impuls
	// Normal- und Tangentialanteil getrennt, Reibung durch den Coulomb-Kegel
	// begrenzt. vHindernis ist die Geschwindigkeit der getroffenen Flaeche -
	// bei Flippern der Punkt auf dem rotierenden Arm, sonst null.
	Physik.prototype.impuls = function (nx, ny, e, mu, vHind) {
		var r = this.r;
		// Beruehrpunkt liegt in Richtung -n auf der Kugeloberflaeche.
		// Geschwindigkeit dort: v + w x (-n*r)  ->  in 2D: v + w*r*( n.y, -n.x)
		var vcx = this.v[0] + this.w * r * ny;
		var vcy = this.v[1] - this.w * r * nx;
		if (vHind) { vcx -= vHind[0]; vcy -= vHind[1]; }

		var vn = vcx * nx + vcy * ny;
		if (vn > 0) return 0;                       // entfernt sich bereits

		var tx = -ny, ty = nx;
		var vt = vcx * tx + vcy * ty;

		// Normalimpuls
		var jn = -(1 + e) * vn / this.invM;

		// Tangentialimpuls: bremst den Schlupf, begrenzt durch mu*jn
		var nennerT = this.invM + r * r * this.invI;
		var jt = -vt / nennerT;
		var grenze = mu * jn;
		if (jt >  grenze) jt =  grenze;
		if (jt < -grenze) jt = -grenze;

		this.v[0] += (nx * jn + tx * jt) * this.invM;
		this.v[1] += (ny * jn + ty * jt) * this.invM;
		// Drehmoment aus dem Tangentialimpuls am Hebelarm r
		this.w += -r * jt * this.invI;

		return jn;
	};

	// ------------------------------------------------------------- Kicker
	/*
	 * Zusatzstoss eines Kickers (Sling, Bumper) nach dem Gummi-Impuls, in
	 * m/s entlang der Normalen. Die Stellschrauben stehen am Objekt (tisch.js):
	 *   extra     Spitzenwert des Stosses
	 *   schwelle  feuert nur, wenn die Annaeherung -vn VOR dem Stoss darueber
	 *             liegt (0 = jede Beruehrung mit Impuls); darunter bleibt es
	 *             beim reinen Gummi (e des Objekts)
	 *   profil    Stoss extra * (1 - x^2), x = Trefferort entlang a->b auf
	 *             -1..1. An den Endkappen (u ausserhalb 0..1, geklemmt) ist
	 *             er 0: die Pfosten sind passive Gummiringe.
	 *   sperre    nach einem Kick feuert dasselbe Objekt so viele Sekunden
	 *             nicht erneut - gegen Doppelkicks und Pingpong mit dem Flipper
	 * Rueckgabe: der Stoss, 0 = hat nicht gefeuert. Mit schwelle 0, ohne
	 * Profil und Sperre ist das genau das alte `extra` (?sling_alt=1).
	 */
	Physik.prototype.kickFuer = function (treffer, anflug, jetzt) {
		var o = treffer.objekt, kick = treffer.extra, i;
		if (!kick) return 0;
		if (o.schwelle > 0 && !(anflug > o.schwelle)) return 0;
		if (o.profil) {
			var x = 2 * treffer.u - 1;
			kick *= 1 - x * x;
			if (!(kick > 0)) return 0;
		}
		if (o.sperre > 0) {
			for (i = 0; i < this.kickSperren.length; i++) {
				if (this.kickSperren[i][0] !== o) continue;
				if (jetzt < this.kickSperren[i][1]) return 0;
				this.kickSperren[i][1] = jetzt + o.sperre;
				return kick;
			}
			this.kickSperren.push([o, jetzt + o.sperre]);
		}
		return kick;
	};

	// ------------------------------------------------------------- Schritt
	Physik.prototype.schritt = function (dt) {
		if (!this.aktiv) return;
		var start = this.zeit;
		this.zeit += dt;

		// Beschleunigungen
		this.v[1] -= this.g * dt;
		this.v[0] += this.stoss[0] * dt;
		this.v[1] += this.stoss[1] * dt;
		this.stoss[0] *= Math.exp(-16 * dt);
		this.stoss[1] *= Math.exp(-16 * dt);

		// Luftwiderstand, quadratisch
		var vb = Math.hypot(this.v[0], this.v[1]);
		if (vb > EPS) {
			var bremse = this.luft * vb * dt;
			var f = Math.max(0, 1 - bremse / vb);
			this.v[0] *= f; this.v[1] *= f;
		}

		// Rollwiderstand: bremst die Drehung sanft in Richtung Rollen
		this.w *= Math.exp(-this.rollmu * dt);

		// --- Bewegung bis zum ersten Aufprall, dann weiter mit der Restzeit
		var rest = dt, runden = 0, ohne = null;
		while (rest > EPS && runden < 8) {
			runden++;
			var treffer = this.naechsterTreffer(rest, ohne);
			if (!treffer) {
				this.p[0] += this.v[0] * rest;
				this.p[1] += this.v[1] * rest;
				break;
			}
			// Knapp vor den Kontakt fahren, damit kein Durchdringen entsteht
			var tv = Math.max(0, treffer.t - 1e-6);
			this.p[0] += this.v[0] * tv;
			this.p[1] += this.v[1] * tv;
			rest -= tv;

			// Annaeherung vor dem Stoss (Normalanteil; Kicker sind ortsfest)
			var anflug = -(this.v[0] * treffer.nx + this.v[1] * treffer.ny);
			var staerke = this.impuls(treffer.nx, treffer.ny, treffer.e, treffer.mu, treffer.vHind);
			// Zusatzstoss (Sling, Bumper) nur bei echtem Anprall. ALTER PFAD
			// (nur ?alt=1): bei jeder Beruehrung, auch wenn impuls() 0
			// lieferte, also beim Entfernen. Ob und wie stark er kommt, sagt
			// kickFuer (Schwelle, Profil, Sperre) - in beiden Pfaden.
			var gefeuert = false;
			if (treffer.extra && (this.kontaktAlt || staerke > 0)) {
				var kick = this.kickFuer(treffer, anflug, start + dt - rest);
				if (kick > 0) {
					this.v[0] += treffer.nx * kick;
					this.v[1] += treffer.ny * kick;
					gefeuert = true;
				}
			}
			if (!this.kontaktAlt && !(staerke > 0)) {
				// Sicherheitsnetz: ein Treffer ohne Impuls - etwa ein Flipper,
				// der schneller zurueckfaellt, als die Kugel ihm folgt - zaehlt
				// fuer den Rest des Unterschritts nicht mehr. Sonst meldet die
				// Suche ihn wieder bei t = 0 und die Runden vergehen ohne Bewegung.
				(ohne || (ohne = [])).push(treffer.objekt);
			}
			if (this.beiTreffer && staerke > 0) {
				this.beiTreffer(treffer.art, staerke, this.p[0], this.p[1], treffer.objekt, gefeuert);
			}
		}

		// --- Sicherheitsnetz: falls die Kugel doch einmal steckt, sanft loesen
		this.entwirren();
	};

	// `ohne`: Objekte, die in diesem Unterschritt nicht mehr zaehlen (oder null).
	// `u`: Trefferort entlang a->b (0..1, geklemmt; an den Kappen 0 bzw. 1),
	// fuer das Kickerprofil. Scheiben: 0.5, Flipper: 0.
	Physik.prototype.naechsterTreffer = function (tmax, ohne) {
		var bester = null, i, tr, alt = this.kontaktAlt;
		var px = this.p[0], py = this.p[1], vx = this.v[0], vy = this.v[1];
		if (Math.abs(vx) < EPS && Math.abs(vy) < EPS) return null;

		for (i = 0; i < this.segmente.length; i++) {
			var s = this.segmente[i];
			if (ohne && ohne.indexOf(s) >= 0) continue;
			tr = toiKapsel(px, py, vx, vy, s.a[0], s.a[1], s.b[0], s.b[1],
			               this.r + s.r, bester ? bester.t : tmax, alt);
			if (tr) bester = { t: tr.t, nx: tr.nx, ny: tr.ny, e: s.e, mu: s.mu,
			                   art: s.art, extra: s.extra || 0, objekt: s,
			                   u: streckenOrt(px + vx * tr.t, py + vy * tr.t, s.a[0], s.a[1], s.b[0], s.b[1]) };
		}
		for (i = 0; i < this.scheiben.length; i++) {
			var q = this.scheiben[i];
			if (ohne && ohne.indexOf(q) >= 0) continue;
			tr = toiKapsel(px, py, vx, vy, q.p[0], q.p[1], q.p[0], q.p[1],
			               this.r + q.r, bester ? bester.t : tmax, alt);
			if (tr) bester = { t: tr.t, nx: tr.nx, ny: tr.ny, e: q.e, mu: q.mu,
			                   art: q.art, extra: q.extra || 0, objekt: q, u: 0.5 };
		}
		for (i = 0; i < this.flipper.length; i++) {
			var f = this.flipper[i];
			if (ohne && ohne.indexOf(f) >= 0) continue;
			var ende = f.ende();
			tr = toiKapsel(px, py, vx, vy, f.p[0], f.p[1], ende[0], ende[1],
			               this.r + f.r, bester ? bester.t : tmax, alt);
			if (!tr) continue;
			// Geschwindigkeit des getroffenen Punkts auf dem rotierenden Arm
			var kx = px + vx * tr.t - tr.nx * this.r;
			var ky = py + vy * tr.t - tr.ny * this.r;
			var armX = kx - f.p[0], armY = ky - f.p[1];
			bester = { t: tr.t, nx: tr.nx, ny: tr.ny, e: f.e, mu: f.mu, art: "flipper",
			           extra: 0, objekt: f, u: 0, vHind: [-armY * f.wv, armX * f.wv] };
		}
		return bester;
	};

	// Falls die Kugel in einer Flaeche steckt - etwa weil ein Flipper sie
	// eingeklemmt hat - sanft herausschieben, ohne Energie hinzuzufuegen.
	Physik.prototype.entwirren = function () {
		var i, k, c, nx, ny, dist, tiefe;
		for (k = 0; k < 3; k++) {
			var bewegt = false;
			for (i = 0; i < this.segmente.length; i++) {
				var s = this.segmente[i];
				c = naechsterPunkt(this.p[0], this.p[1], s.a[0], s.a[1], s.b[0], s.b[1]);
				nx = this.p[0] - c[0]; ny = this.p[1] - c[1];
				dist = Math.hypot(nx, ny);
				tiefe = this.r + s.r - dist;
				if (tiefe <= 0 || dist < EPS) continue;
				this.p[0] += nx / dist * tiefe; this.p[1] += ny / dist * tiefe;
				bewegt = true;
			}
			for (i = 0; i < this.scheiben.length; i++) {
				var q = this.scheiben[i];
				nx = this.p[0] - q.p[0]; ny = this.p[1] - q.p[1];
				dist = Math.hypot(nx, ny);
				tiefe = this.r + q.r - dist;
				if (tiefe <= 0 || dist < EPS) continue;
				this.p[0] += nx / dist * tiefe; this.p[1] += ny / dist * tiefe;
				bewegt = true;
			}
			for (i = 0; i < this.flipper.length; i++) {
				var f = this.flipper[i], ende = f.ende();
				c = naechsterPunkt(this.p[0], this.p[1], f.p[0], f.p[1], ende[0], ende[1]);
				nx = this.p[0] - c[0]; ny = this.p[1] - c[1];
				dist = Math.hypot(nx, ny);
				tiefe = this.r + f.r - dist;
				if (tiefe <= 0 || dist < EPS) continue;
				this.p[0] += nx / dist * tiefe; this.p[1] += ny / dist * tiefe;
				// Ein hochfahrender Flipper darf die Kugel mitnehmen
				var armX = c[0] - f.p[0], armY = c[1] - f.p[1];
				var vp = [-armY * f.wv, armX * f.wv];
				var vn = (this.v[0] - vp[0]) * nx / dist + (this.v[1] - vp[1]) * ny / dist;
				if (vn < 0) this.impuls(nx / dist, ny / dist, f.e, f.mu, vp);
				bewegt = true;
			}
			if (!bewegt) break;
		}
	};

	// Projektion eines Punkts auf die Strecke a-b als Anteil 0..1 (geklemmt)
	function streckenOrt(px, py, ax, ay, bx, by) {
		var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
		if (l2 < EPS) return 0.5;
		var t = ((px - ax) * dx + (py - ay) * dy) / l2;
		return t < 0 ? 0 : (t > 1 ? 1 : t);
	}

	function naechsterPunkt(px, py, ax, ay, bx, by) {
		var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
		if (l2 < EPS) return [ax, ay];
		var t = ((px - ax) * dx + (py - ay) * dy) / l2;
		t = t < 0 ? 0 : (t > 1 ? 1 : t);
		return [ax + t * dx, ay + t * dy];
	}

	global.Physik = Physik;
	global.PhysikHilfen = { toiKapsel: toiKapsel, naechsterPunkt: naechsterPunkt, streckenOrt: streckenOrt };
})(typeof window !== "undefined" ? window : globalThis);
