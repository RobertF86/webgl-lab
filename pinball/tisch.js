/*
 * FRIDAYVFX Pinball - Tischbeschreibung
 *
 * Hier steht die Geometrie EINMAL. Physik, Spielfeldgrafik und Regelwerk lesen
 * dieselbe Beschreibung - sie koennen dadurch nicht auseinanderlaufen.
 *
 * Wichtig zur Aufteilung: rechts liegt ab schachtX die Abschussrinne. Die
 * bespielbare Flaeche reicht also von -W bis schachtX, ihre Mitte liegt bei
 * XM = -0.027 und nicht bei 0. Flipper, Slingshots und Gassen sind um XM
 * gespiegelt, so wie bei echten Geraeten auch - der Schrank ist symmetrisch,
 * das Spielfeld nicht.
 *
 * Masse in Metern, nach echtem Vorbild:
 *   Kugel 27 mm, Flipperspalt 1,4 Kugeldurchmesser, Auslaufgasse 32 mm,
 *   Rueckgasse 47 mm lichte Weite (im Knick ueber dem Flipper 36 mm).
 */
(function (global) {
	"use strict";

	/*
	 * Drahtfuehrungen (Look Stufe 1b, Task 8): die beiden Trenner zwischen
	 * Rueck- und Auslaufgasse sind
	 * keine 12-mm-Chromrohre, sondern Schleifen aus Federstahldraht wie an
	 * echten Geraeten - zwei parallele Draehte in Kugelmittenhoehe, oben als
	 * Haarnadel verbunden, unten mit Beinen in der Spielflaeche. Die Physik
	 * rechnet weiter mit der Kapsel (Radius r des Segments); die Aussenkanten
	 * des Drahtpaars liegen genau auf dieser Grenze, die Kugel beruehrt den
	 * Draht. Die Masse stehen hier, weil Renderer (pinball-gpu.js) und
	 * Feldbild (spielfeld.js, gebackener Schatten) dieselben Drahtachsen und
	 * Beinfuesse brauchen.
	 *
	 * DRAHT_R  Drahtradius 1.6 mm (3.2 mm = 1/8", realer Guide-Draht). Im
	 *          1920x1080-Startbild ist der Draht 5.6-8 px breit (1.75-2.54
	 *          px/mm quer, Trennerkopf bis Flipperende); 1.2 mm (2.4-mm-Draht,
	 *          3/32") waere eine Spur zarter - Bildpaar Fix-Runde 1
	 *          (tmp/pinball/t8-f1-ab-staerke3x.png), Entscheidung Robert.
	 * DRAHT_H  Achshoehe 12 mm, knapp unter der Kugelmitte (13.5 mm): die
	 *          Kugel liegt mit ihrem Aequator am Draht, nicht darueber
	 *          (Abstand Drahtachse-Kugelmitte 15.17 mm bei 15.1 mm Summe der
	 *          Radien: Beruehrung, 0.07 mm Luft = 0.1 px).
	 * Haarnadel: sie liegt am Trenner im Posten (Gummi-Torus) - im Bild
	 *          nicht zu sehen, gewollt: der Draht endet sichtbar am Gummi.
	 *          (Die frueheren Fuehrungen unter den Slings sind mit den echten
	 *          Gassen entfallen; ihre Rolle hat die Sling-Unterseite.)
	 */
	var DRAHT_R = 0.0016, DRAHT_H = 0.012;

	/*
	 * Slingshots (Spielgefuehl Paket 2a). Robert: "zu stark, und ein zu
	 * grosser Bereich, in dem sie ausloesen" - die Kugel soll sich auf dem
	 * gehaltenen Flipper in der Ecke Flipper/Sling-Pfosten fangen lassen
	 * (Cradle) und von dort gezielt abschiessen lassen. Die Logik steht in
	 * physik.js (kickFuer), die Werte hier:
	 *
	 * SLING_KICK      1.5 m/s   Spitzenstoss in der Mitte des Gummis (vorher
	 *                           2.9). Austritt Mitte: 1 m/s -> 2.08, 0.3 -> 1.67
	 * SLING_SCHWELLE  0.25 m/s  feuert nur, wenn die Kugel schneller anlaeuft
	 *                           (vorher 0 = jede Beruehrung); darunter ist der
	 *                           Sling reines Gummi (e 0.58). 0.20 aus dem
	 *                           Auftrag reicht nicht: eine Kugel, die von oben
	 *                           auf das Gummi faellt und in die Ecke rutscht,
	 *                           trifft es mit 0.20-0.30 m/s - mit 0.20 kamen
	 *                           links/rechts 60/68 % zur Ruhe, mit 0.25 83/85 %
	 *                           (physik_test Teil 14, Bericht Paket 2a; mit den
	 *                           Gassen C+ 97/93 %)
	 * SLING_PROFIL    an        Stoss * (1 - x^2) entlang des Gummis, an den
	 *                           Pfosten 0 (vorher ueberall voll)
	 * SLING_SPERRE    0.120 s   danach erst wieder ein Kick desselben Slings
	 *
	 * Zum Vergleich im Browser ueberschreibbar (slingAusAdresse):
	 * ?sling_kick=, ?sling_schwelle=, ?sling_profil=0|1, ?sling_sperre=<s>,
	 * ?sling_alt=1 setzt alle vier auf das alte Verhalten (2.9 / 0 / aus / 0).
	 * Die Pop-Bumper bleiben bei 3.2 m/s ohne Schwelle, Profil und Sperre.
	 */
	var SLING_KICK = 1.5, SLING_SCHWELLE = 0.25, SLING_PROFIL = true, SLING_SPERRE = 0.120;
	var SLING_START = { kick: SLING_KICK, schwelle: SLING_SCHWELLE, profil: SLING_PROFIL, sperre: SLING_SPERRE };
	var SLING_ALT = { kick: 2.9, schwelle: 0, profil: false, sperre: 0 };

	// Vollstaendige Sling-Einstellung: fehlende Werte vom Start, dazu
	// `abweichend` und der HUD-Text `kurz` ("sling <kick>/<schwelle>", bei
	// Bedarf mit Profil und Sperre)
	function slingEinstellung(e) {
		e = e || {};
		var s = {};
		Object.keys(SLING_START).forEach(function (k) { s[k] = e[k] === undefined ? SLING_START[k] : e[k]; });
		s.profil = !!s.profil;
		s.abweichend = s.kick !== SLING_KICK || s.schwelle !== SLING_SCHWELLE ||
		               s.profil !== SLING_PROFIL || s.sperre !== SLING_SPERRE;
		s.kurz = "sling " + s.kick + "/" + s.schwelle +
		         (s.profil !== SLING_PROFIL ? (s.profil ? " profil" : " flach") : "") +
		         (s.sperre !== SLING_SPERRE ? " sperre " + Math.round(s.sperre * 1000) + " ms" : "");
		return s;
	}

	// URL-Parameter (location.search) -> Sling-Einstellung. Unbrauchbare
	// Werte (keine Zahl, negativ) werden uebergangen.
	function slingAusAdresse(suche) {
		var q = new URLSearchParams(suche || ""), e = {};
		if (q.get("sling_alt") === "1") Object.keys(SLING_ALT).forEach(function (k) { e[k] = SLING_ALT[k]; });
		function zahl(name, k) {
			var t = q.get(name), x = t === null || t === "" ? NaN : Number(t);
			if (isFinite(x) && x >= 0) e[k] = x;
		}
		zahl("sling_kick", "kick");
		zahl("sling_schwelle", "schwelle");
		zahl("sling_sperre", "sperre");
		var p = q.get("sling_profil");
		if (p === "0" || p === "1") e.profil = p === "1";
		return slingEinstellung(e);
	}

	function baueTisch(o) {
		var W = o.W, L = o.L, R = o.kugelR, BR = o.bandeR, SCHACHT = o.schachtX;
		var SLE = slingEinstellung(o.sling);
		var XM = (-W + SCHACHT) / 2;            // Mitte der bespielbaren Flaeche
		var BOGEN_Y = L - 0.20;

		var segmente = [], scheiben = [], ziele = [], rollover = [], flipper = [];
		var draehte = [];

		// ------------------------------------------------------------ Helfer
		function seg(ax, ay, bx, by, opt) {
			opt = opt || {};
			var s = { a: [ax, ay], b: [bx, by],
			          r: opt.r === undefined ? BR : opt.r,
			          e: opt.e === undefined ? 0.42 : opt.e,
			          mu: opt.mu === undefined ? 0.14 : opt.mu,
			          art: opt.art || "wand", extra: opt.extra || 0,
			          // Kicker (physik.js, kickFuer): Schwelle, Profil, Sperre
			          schwelle: opt.schwelle || 0, profil: !!opt.profil, sperre: opt.sperre || 0,
			          hoehe: opt.hoehe || 0.030,
			          // nur fuer die Grafik: kein Chromrohr (die Physik liest es nicht)
			          unsichtbar: !!opt.unsichtbar,
			          // nur fuer die Grafik: Drahtschleife statt Rohr (Task 8); die
			          // Kollisionskapsel bleibt, die Draehte liegen an ihrem Rand
			          draht: !!opt.draht };
			segmente.push(s);
			return s;
		}
		/*
		 * Drahtschleife ueber einem Linienzug (vom unteren Ende mit den Beinen
		 * zum oberen mit der Haarnadel). Die Kollisionssegmente kommen wie
		 * bisher aus seg(); hier entsteht dazu EINMAL die Grafikbeschreibung:
		 *   achse  die Drahtachse in 2D - links hinauf (Versatz +rho, Gehrung an
		 *          Knicken), Halbkreis um den Endpunkt, rechts zurueck
		 *   beine  Fuesse der Beine: erst die beiden Enden der Schleife
		 *          (achse[0], achse[letzte]), dann je Knick ein Mittelbuegel
		 * rho = r - DRAHT_R: die Aussenkante des Drahts liegt auf der Kapsel.
		 */
		function drahtForm(punkte, r) {
			var n = punkte.length, rho = r - DRAHT_R, dir = [], q = [], i, k;
			for (i = 0; i < n - 1; i++) {
				var dx = punkte[i + 1][0] - punkte[i][0], dy = punkte[i + 1][1] - punkte[i][1];
				var l = Math.hypot(dx, dy) || 1;
				dir.push([dx / l, dy / l]); q.push([-dy / l, dx / l]);
			}
			function versatz(i, s) {
				var qi = i === 0 ? q[0] : i === n - 1 ? q[n - 2] : null;
				if (!qi) {                           // Gehrung: Winkelhalbierende, auf rho gestreckt
					var mx = q[i - 1][0] + q[i][0], my = q[i - 1][1] + q[i][1], ml = Math.hypot(mx, my) || 1;
					var c = (mx * q[i][0] + my * q[i][1]) / ml;
					qi = [mx / ml / c, my / ml / c];
				}
				return [punkte[i][0] + s * rho * qi[0], punkte[i][1] + s * rho * qi[1]];
			}
			var links = [], rechts = [], achse = [], beine = [];
			for (i = 0; i < n; i++) { links.push(versatz(i, 1)); rechts.push(versatz(i, -1)); }
			for (i = 0; i < n; i++) achse.push(links[i]);
			var pe = punkte[n - 1], de = dir[n - 2], qe = q[n - 2];
			for (k = 1; k < 10; k++) {              // Haarnadel, 180 Grad in 10 Schritten
				var w = Math.PI * k / 10;
				achse.push([pe[0] + rho * (Math.cos(w) * qe[0] + Math.sin(w) * de[0]),
				            pe[1] + rho * (Math.cos(w) * qe[1] + Math.sin(w) * de[1])]);
			}
			for (i = n - 1; i >= 0; i--) achse.push(rechts[i]);
			beine.push(links[0], rechts[0]);
			for (i = 1; i < n - 1; i++) beine.push(links[i], rechts[i]);
			draehte.push({ punkte: punkte, r: r, drahtR: DRAHT_R, h: DRAHT_H, achse: achse, beine: beine });
		}
		function drahtPaar(punkte, r) {
			drahtForm(punkte, r);
			drahtForm(punkte.map(function (p) { return [sp(p[0]), p[1]]; }), r);
		}
		// Spiegeln an der Spielfeldmitte, nicht an der Schrankmitte
		function sp(x) { return 2 * XM - x; }
		function segPaar(ax, ay, bx, by, opt) {
			seg(ax, ay, bx, by, opt);
			seg(sp(ax), ay, sp(bx), by, opt);
		}
		function bogen(cx, cy, r, a0, a1, n, opt) {
			for (var i = 0; i < n; i++) {
				var t0 = a0 + (a1 - a0) * i / n, t1 = a0 + (a1 - a0) * (i + 1) / n;
				seg(cx + r * Math.cos(t0), cy + r * Math.sin(t0),
				    cx + r * Math.cos(t1), cy + r * Math.sin(t1), opt);
			}
		}
		function scheibe(x, y, r, opt) {
			opt = opt || {};
			var s = { p: [x, y], r: r,
			          e: opt.e === undefined ? 0.5 : opt.e,
			          mu: opt.mu === undefined ? 0.08 : opt.mu,
			          art: opt.art || "post", extra: opt.extra || 0,
			          schwelle: opt.schwelle || 0, profil: !!opt.profil, sperre: opt.sperre || 0,
			          gummi: opt.gummi === undefined ? true : opt.gummi,
			          blitz: 0 };
			scheiben.push(s);
			return s;
		}

		// ======================================================= Aussenbanden
		// Links die Schrankwand, rechts die Trennwand zur Abschussrinne.
		seg(-W, 0.105, -W, BOGEN_Y);
		bogen(0, BOGEN_Y, W, Math.PI, 0, 32, { e: 0.46 });
		seg(SCHACHT, 0.105, SCHACHT, BOGEN_Y - 0.115);
		// Aussenwand der Abschussrinne
		seg(W, 0.050, W, BOGEN_Y - 0.010);
		// Einlaufbogen oben in die Rinne, damit die Kugel ins Feld faellt
		bogen(W - 0.028, BOGEN_Y - 0.010, 0.028, 0, Math.PI / 2, 6, { e: 0.40 });
		/*
		 * Anschlag unten in der Rinne. Ohne ihn fiel die Kugel in einer halben
		 * Sekunde durch den offenen Boden nach unten heraus - abschiessen war
		 * dadurch unmoeglich, weil beim Tastendruck laengst keine Kugel mehr da
		 * war. Hier liegt sie und wartet auf den Stoessel.
		 *
		 * `unsichtbar`: nur ein Physik-Anschlag, kein Chromrohr quer durch die
		 * Rinne - an echten Geraeten liegt die Kugel direkt am Stoessel, und die
		 * Plunger-Stange durchdrang das Rohr (Look Stufe 1, Task 5b).
		 */
		seg(SCHACHT, 0.042, W, 0.042, { e: 0.20, mu: 0.30, unsichtbar: true });

		// Auslauftrichter unten - alles laeuft zum Abfluss zusammen
		seg(-W, 0.105, XM - 0.078, -0.012, { e: 0.30, mu: 0.20 });
		seg(SCHACHT, 0.105, XM + 0.078, -0.012, { e: 0.30, mu: 0.20 });

		// ============================================================ Flipper
		var FL_L = 0.082, FL_R = 0.0105, FL_RUHE = -0.52, FL_VOLL = 0.36;
		function macheFlipper(px, py, ruhe, voll, seite) {
			return {
				p: [px, py], r: FL_R, e: 0.22, mu: 0.45,
				laenge: FL_L, ruhe: ruhe, voll: voll, seite: seite,
				w: ruhe, wv: 0, ziel: 0,
				ende: function () {
					return [this.p[0] + Math.cos(this.w) * FL_L,
					        this.p[1] + Math.sin(this.w) * FL_L];
				}
			};
		}
		var FL_X = 0.1005, FL_Y = 0.150;
		flipper.push(macheFlipper(XM - FL_X, FL_Y, FL_RUHE, FL_VOLL, -1));
		flipper.push(macheFlipper(XM + FL_X, FL_Y, Math.PI - FL_RUHE, Math.PI - FL_VOLL, 1));

		// ========================================================= Slingshots
		/*
		 * Gassen wie am echten Geraet (Vorbild Gottlieb Snow Derby, 1970):
		 * aussen die Auslaufgasse, sie laeuft AUSSEN am Flipper vorbei in den
		 * Abfluss; innen die Rueckgasse, ihre Muendung liegt UEBER dem
		 * Flipperdrehpunkt - die Kugel rollt auf die Oberseite des Flippers.
		 * (Vorher muendete die Rueckgasse unter und neben dem Drehpunkt: 0 von
		 * 200 Kugeln erreichten den Flipper, sie liefen alle ins Aus.)
		 *
		 * Dreieck mit dem Gummi a-b auf der zur Mitte zeigenden Seite. Die
		 * senkrechte Aussenseite b-c ist die innere Wand der Rueckgasse, die
		 * Unterseite c-a laeuft unter 45 Grad parallel zum Trennerknick und
		 * bildet mit ihm den Knick der Gasse (36 mm). Die Kappe a steht ueber
		 * der Flipperbasis: 33.6 mm ueber dem ruhenden Flipper (die Kugel rollt
		 * darunter durch), 19.1 mm ueber dem gehaltenen (Cradle-Ecke Paket 2a).
		 *
		 * Der Koerper steht bewusst weiter innen, als der Platz erlauben wuerde:
		 * so bekommt die Rueckgasse 47 mm statt 32 mm lichte Weite. Bei gleich
		 * breiten Gassen nahm im Ablauftest fast jede Kugel die Auslaufgasse -
		 * die Rueckgasse feuerte einmal in 57 Baellen und war totes Inventar.
		 * Die Hoehe der Spitze b (0.308) ist ein Kompromiss: hoeher faengt die
		 * Cradle mehr Kugeln, laesst aber mehr in die Auslaufgasse (gemessen:
		 * b 0.300 -> Cradle 81/82 %, b 0.330 -> Auslaufgasse 1.84 statt
		 * 1.44-1.60 Eintritte je Spielminute bei 0.308, +15-28 % - Bot des
		 * Gassen-Gutachtens; der Bot im ablauf_test kommt bei 0.308 auf 1.39).
		 * Vorher: a (XM-0.0810, 0.190), b (XM-0.1300, 0.290), c (XM-0.1250, 0.178).
		 */
		var SL = {
			a: [XM - 0.0800, 0.199],            // unten innen, Gummi beginnt
			b: [XM - 0.1280, 0.308],            // oben aussen, Gummi endet
			c: [XM - 0.1280, 0.247]             // unten aussen (Knick der Rueckgasse)
		};
		// Das Gummi: Stoss, Schwelle, Profil und Sperre aus SLING_* bzw. ?sling_*
		segPaar(SL.a[0], SL.a[1], SL.b[0], SL.b[1],
		        { art: "sling", e: 0.58, mu: 0.05, r: 0.009, extra: SLE.kick,
		          schwelle: SLE.schwelle, profil: SLE.profil, sperre: SLE.sperre });
		segPaar(SL.b[0], SL.b[1], SL.c[0], SL.c[1], { e: 0.35 });
		segPaar(SL.c[0], SL.c[1], SL.a[0], SL.a[1], { e: 0.35 });

		// =================================================== Gassen und Trenner
		// Trenner zwischen Rueckgasse (innen) und Auslaufgasse (aussen):
		// Drahtschleife mit Mittelbuegel am Knick (Task 8). Unter dem Knick
		// (y 0.2375) zieht er unter 45 Grad nach innen bis an die Flipperbasis
		// und endet 16 mm links und 16 mm ueber dem Drehpunkt, 6.1 mm neben der
		// Flipperkappe - dazwischen passt keine Kugel, ueber jeden Flipperwinkel.
		// Bei gehaltenem Flipper bleibt eine Kugel aus der Rueckgasse hier am
		// Drahtende liegen (Basis-Cradle wie am echten Geraet).
		// Vorher: (XM-0.173, 0.112), (XM-0.188, 0.190), (XM-0.188, 0.300).
		var TRENNER = [[XM - 0.1165, 0.166], [XM - 0.188, 0.2375], [XM - 0.188, 0.300]];   // unten -> oben
		segPaar(TRENNER[2][0], TRENNER[2][1], TRENNER[1][0], TRENNER[1][1], { r: 0.006, e: 0.35, draht: true });
		segPaar(TRENNER[1][0], TRENNER[1][1], TRENNER[0][0], TRENNER[0][1], { r: 0.006, e: 0.35, draht: true });
		drahtPaar(TRENNER, 0.006);
		// Posten oben am Trenner - hier entscheidet sich Rueckgasse oder Verlust
		scheibe(XM - 0.188, 0.306, 0.0095, { e: 0.62, mu: 0.05 });
		scheibe(sp(XM - 0.188), 0.306, 0.0095, { e: 0.62, mu: 0.05 });

		// Rollover-Schalter in den Gassen
		function rollPaar(x, y, r, art, id) {
			rollover.push({ x: x, y: y, r: r, art: art, id: id + "L", seite: -1, an: 0 });
			rollover.push({ x: sp(x), y: y, r: r, art: art, id: id + "R", seite: 1, an: 0 });
		}
		// im senkrechten Teil der Gassen, zwischen Knick und Posten (vorher y 0.150)
		rollPaar(XM - 0.1585, 0.272, 0.020, "rueckgasse", "gasse");
		rollPaar(XM - 0.210, 0.272, 0.020, "auslauf", "auslauf");

		// ==================================================== Kopfbahnen V F X
		// Drei Bahnen in der oberen Rundung, durch zwei kurze Waende getrennt.
		var BAHN_R = 0.148;
		["V", "F", "X"].forEach(function (b, k) {
			var w = Math.PI * (0.74 - k * 0.24);
			rollover.push({ x: Math.cos(w) * BAHN_R, y: BOGEN_Y + Math.sin(w) * BAHN_R,
			                r: 0.021, art: "bahn", id: "bahn" + b, buchstabe: b, an: 0 });
		});
		[0.62, 0.38].forEach(function (t) {
			var w = Math.PI * t;
			seg(Math.cos(w) * 0.104, BOGEN_Y + Math.sin(w) * 0.104,
			    Math.cos(w) * 0.196, BOGEN_Y + Math.sin(w) * 0.196, { r: 0.005, e: 0.40 });
		});

		// ======================================================= Pop-Bumper
		// Unveraendert (Paket 2a betrifft nur die Slings): voller Stoss bei
		// jeder Beruehrung mit Impuls - Schwelle, Profil und Sperre sind hier
		// ausdruecklich aus, ein spaeteres Bumper-Paket aendert nur Zahlen.
		var BUMPER = { art: "bumper", e: 0.52, extra: 3.2, gummi: false, schwelle: 0, profil: false, sperre: 0 };
		scheibe(XM - 0.082, 0.762, 0.029, BUMPER);
		scheibe(XM + 0.082, 0.798, 0.029, BUMPER);
		scheibe(XM + 0.000, 0.658, 0.029, BUMPER);
		// Posten der Bumpergruppe
		scheibe(XM - 0.086, 0.632, 0.0095);
		scheibe(XM + 0.086, 0.632, 0.0095);
		scheibe(XM + 0.000, 0.905, 0.0095);

		// ====================================================== Fallziele
		/*
		 * Zwei Baenke. Dicht dahinter laeuft eine durchgehende Rueckwand, die an
		 * beiden Enden an die Bande anschliesst.
		 *
		 * Das ist keine Zierde: ohne sie steht die Bank frei im Feld, und sobald
		 * die Ziele gefallen sind, oeffnet sich dahinter eine Tasche, aus der die
		 * Kugel nicht mehr herausfindet. Der Ablauftest hat genau das gefunden -
		 * sechs von 25 Baellen blieben liegen. Mit der Rueckwand ist der Raum
		 * hinter der Bank fuer die Kugel nie erreichbar, und ein gefallenes Ziel
		 * hinterlaesst nur eine 1 mm flache Stufe.
		 */
		function zielBank(x, y0, y1, anzahl, nx, gruppe, farbe) {
			var halb = 0.017;
			for (var k = 0; k < anzahl; k++) {
				var y = y0 + (y1 - y0) * (anzahl === 1 ? 0.5 : k / (anzahl - 1));
				ziele.push({ x: x, y: y, nx: nx, ny: 0, halb: halb,
				             gruppe: gruppe, nr: k, farbe: farbe, unten: false,
				             sinken: 0, an: 0 });
			}
			var rand = nx < 0 ? SCHACHT : -W;
			var hinten = x - nx * 0.014;
			seg(rand, y0 - halb - 0.055, hinten, y0 - halb - 0.020, { e: 0.35 });
			seg(hinten, y0 - halb - 0.020, hinten, y1 + halb + 0.020, { e: 0.35 });
			seg(hinten, y1 + halb + 0.020, rand, y1 + halb + 0.055, { e: 0.35 });
		}
		zielBank(-W + 0.045, 0.440, 0.600, 4,  1, "links",  "#C8202B");
		zielBank(SCHACHT - 0.045, 0.400, 0.520, 3, -1, "rechts", "#E8721A");

		// ==================================================== Stehziele
		// Zwei einzelne Ziele neben der Bumpergruppe, sie fallen nicht. Sie
		// stehen dicht an der Bande: frei im Feld liess der Ablauftest die Kugel
		// auch hinter ihnen durch, und ein Ziel, das man von hinten trifft,
		// gibt es an keinem echten Geraet.
		ziele.push({ x: -W + 0.026, y: 0.745, nx: 1, ny: 0.25, halb: 0.016,
		             gruppe: "steh", nr: 0, farbe: "#F2B705", fest: true,
		             unten: false, sinken: 0, an: 0 });
		ziele.push({ x: SCHACHT - 0.026, y: 0.775, nx: -1, ny: 0.25, halb: 0.016,
		             gruppe: "steh", nr: 1, farbe: "#F2B705", fest: true,
		             unten: false, sinken: 0, an: 0 });

		/*
		 * Fuehrung vom Bogen zurueck ins Feld. Sie beginnt AN der Bande und der
		 * Keil dahinter wird unten verschlossen - sonst ist er eine Falle: die
		 * Kugel rollt von unten hinein und klemmt sich in der Spitze fest.
		 *
		 * Die alte Fuehrung endete 19,6 mm vor dem Posten der Bumpergruppe -
		 * die Kugel braucht 27 - und lag mit 6,9 mm vor dem Stehziel, das damit
		 * unerreichbar war. Beides fand erst der Spieler.
		 */
		seg(-W, 0.860, XM - 0.178, 0.775, { e: 0.40 });
		seg(XM - 0.178, 0.775, -W, 0.775, { e: 0.35 });

		// ---------------------------------------------------------------------
		// Jedes Ziel bekommt sein eigenes Segment. Es steht NICHT in `segmente`:
		// gefallene Ziele muessen aus der Kollisionsliste verschwinden, und die
		// stellt der Aufrufer aus beiden Listen zusammen.
		ziele.forEach(function (z) {
			var l = Math.hypot(z.nx, z.ny);
			z.nx /= l; z.ny /= l;
			z.seg = { a: [z.x - z.ny * z.halb, z.y + z.nx * z.halb],
			          b: [z.x + z.ny * z.halb, z.y - z.nx * z.halb],
			          r: 0.006, e: 0.30, mu: 0.30, art: "ziel", extra: 0,
			          hoehe: 0.026, objekt: z };
		});

		return {
			XM: XM, W: W, L: L, bogenY: BOGEN_Y, schachtX: SCHACHT,
			segmente: segmente, scheiben: scheiben, flipper: flipper,
			ziele: ziele, rollover: rollover, slingshot: SL, draehte: draehte,
			sling: SLE,
			masse: { flipperL: FL_L, flipperR: FL_R, flipperX: FL_X, flipperY: FL_Y,
			         ruhe: FL_RUHE, voll: FL_VOLL, bahnR: BAHN_R, bandeR: BR,
			         drahtR: DRAHT_R, drahtH: DRAHT_H }
		};
	}

	global.baueTisch = baueTisch;
	global.slingAusAdresse = slingAusAdresse;
	global.slingEinstellung = slingEinstellung;
})(typeof window !== "undefined" ? window : globalThis);
