/*
 * FRIDAYVFX Pinball - Spielfeldgrafik und Backglas
 *
 * Angelehnt an die Siebdruck-Sprache klassischer Tische (Bally, spaete 70er):
 * flache Farbflaechen ohne Verlaeufe, harte Kanten, ein grosses V zur Mitte,
 * Blitze als Strahlen nach aussen, Sternexplosionen hinter den Bumpern. Nur die
 * Palette ist eine andere - Tiefblau und das FridayVFX-Gruen statt Rot-Weiss-
 * Blau, damit der Tisch zur Seite gehoert und nicht zu 1978.
 *
 * Alle Orte kommen aus der Tischbeschreibung (tisch.js). Nichts wird hier ein
 * zweites Mal festgelegt - sonst wandern Bild und Spielgeraet auseinander,
 * sobald jemand einen Bumper verschiebt.
 *
 * Zurueck kommt das Bild UND die Lampenliste. Jede Lampe kennt ihr Objekt oder
 * ihre Nummer, damit das Regelwerk sie ansteuern kann.
 *
 * Zeichenreihenfolge wie im Siebdruck: erst der Grund, dann die Baender, dann
 * die Strahlen, zuletzt Scheiben und Einsaetze. Vertauscht man sie, laufen die
 * Baender quer durch die Bumper.
 */
(function (global) {
	"use strict";

	var FARBE = {
		grund:      "#252937",              // das Blau der uebrigen Seite
		grundTief:  "#1B1E29",
		grundMitte: "#252937",
		grundHell:  "#333A50",
		rot:        "#C8202B",
		rotDunkel:  "#8E141C",
		orange:     "#E8721A",
		gelb:       "#F2B705",
		gruen:      "#81E458",
		gruenTief:  "#3C8A2A",
		weiss:      "#EEF2F4",
		linie:      "#050A14"
	};

	/*
	 * ------------------------------------------------ Schatten-Stellschrauben
	 * (Pinball-Look Stufe 1, Task 1 "Grounding")
	 *
	 * SCHATTEN_RICHTUNG  Versatz eines Schattens auf dem Feld je Meter Hoehe,
	 *                    in Tischkoordinaten (x quer, y zum Kopfende). Aus dem
	 *                    Fuehrungslicht L = normalize(-0.25, 0.90, 0.36) in
	 *                    fsNetz (pinball-gpu.js): -L.x/L.y = 0.28 nach rechts,
	 *                    L.z/L.y = 0.40 zum Kopfende - Welt +z zeigt zum
	 *                    Spieler, Tisch +y von ihm weg (raum.js, welt()). Die
	 *                    6.5 Grad Neigung sind nicht eingerechnet, mit ihr
	 *                    waeren es [0.27, 0.27]; der Unterschied liegt im
	 *                    verkuerzten, vom Teil selbst verdeckten Teil des
	 *                    Schattens.
	 * HALBSCHATTEN       Der Schattenrand wird je Meter Hoehe um 0.15 m weicher
	 *                    (Radius r + 0.15 h): Kuppellicht und Softbox sind
	 *                    grosse Flaechen, kein Punktlicht.
	 * KERN, RING         Deckung im Kern des Schlagschattens und im AO-Ring am
	 *                    Fuss. Dunkel, aber nie schwarz. Nachkalibriert in
	 *                    Task 2 (Pruefung von Task 1, Ziel Delta 25-35 in der
	 *                    sichtbaren Kontaktzone): eine Deckung a im Feldbild
	 *                    wird im Bild zu Grund * (1 - a)^2.2 (Textur in sRGB,
	 *                    pow 2.2 im Shader, ACES dort fast linear) - bei
	 *                    Grund 42 (Lampen aus) misst der Posten mit KERN
	 *                    0.45 / RING 0.35 Delta 15, mit 0.55 / 0.42 Delta 18,
	 *                    mit 0.70 / 0.75 Delta 20 (min 2.5 mm neben dem Gummi;
	 *                    Ring dort bereits am Mittelstopp). Mehr wuerde den
	 *                    Kern schwarz machen; die Fuge (RING) darf dunkler
	 *                    sein als der weiche Schlagschatten (KERN).
	 *                    Stopps des Schlagschattens 0.40 -> 0.85 KERN,
	 *                    0.75 -> 0.45 KERN.
	 * RING_BREITE        AO-Ring: absolut 4 mm ueber den sichtbaren Fuss
	 *                    hinaus (vorher 1.3 r - bei kleinen Teilen zu schmal,
	 *                    beim Bumper ein gedruckter Ring auf der Sternscheibe).
	 *                    Stopps 0 -> RING, 0.5 -> 0.55 RING, 1 -> 0.
	 * SAUM, SAUM_KANTE   Banden: ein Saum nur auf der lichtabgewandten Seite.
	 *                    Das Rohr wird um seine Mittenhoehe in Lichtrichtung
	 *                    versetzt und SAUM_KANTE breiter gezogen - so steht
	 *                    der Schatten von selbst nur dort, wo das Licht nicht
	 *                    hinkommt. 0.30 / 2 mm massen Delta 9-10; 0.40 / 4 mm
	 *                    Delta 14, 0.65 / 4 mm Delta 18-19 am Trenner links
	 *                    (Grund 42). Von der Kamera aus verdeckt der Rohr-
	 *                    koerper die ersten ~4 mm neben dem Fuss, sichtbar ist
	 *                    nur der auslaufende Rand des Saums; 6 mm Breite
	 *                    aenderte die Messung nicht (Task 2).
	 * WAND_*             Schrankwaende: Verlauf 25 mm ins Feld. Links faellt
	 *                    der Schatten der 93 mm hohen Wand (0.28 * 93 = 26 mm),
	 *                    rechts und am Kopfende bleibt nur Verdeckung.
	 * HOEHE_*            Hoehen der Teile ueber dem Feld, aus den Netzen in
	 *                    pinball-gpu.js (Posten 33 mm, Bumperfuss 7.5 -> 8 mm,
	 *                    Kappe bis 49 mm, Fallziel 25 mm, Sling-Platte ab
	 *                    26.5 mm), Radien ebenso.
	 * R_POSTEN_SICHT     Posten: Ring und Schlagschatten am sichtbaren
	 *                    Gummi-Aussenradius (Torus 7.5 + 4 = 11.5 mm), nicht
	 *                    am Physikradius 9.5 - dort lag der Ring unter dem
	 *                    Gummi (Task-1-Pruefung).
	 * R_ZIEL_QUER        Fallziel quer: halbe Plattendicke 3 mm + 3 mm. Mit
	 *                    5 mm fehlte die Fusslinie im Bild (Delta 13-17).
	 * ZIEL_*             Ring der Ziele 0.70 weich (0.45 mass Delta 23, 0.70
	 *                    Delta 25 auf der Blende, Grund 44); dazu eine
	 *                    Schlitzlinie 2 mm, alpha 0.55, an der Vorderkante der
	 *                    Platte - die Fuge, in der das Ziel versinkt.
	 * BUMPER_*           Koerper- und Kappenschatten 0.30 (vorher 0.20),
	 *                    AO-Ring 6 mm ueber den Fuss hinaus (29 -> 35 mm).
	 * ABRIEB_*           Helle Abriebstriche: 30 statt 120, halbe Deckung, nur
	 *                    unten - ueber das ganze Feld verteilt lasen sie sich
	 *                    als Rauschen (Look-Review 17.10.2026).
	 */
	var SCHATTEN_RICHTUNG = [0.28, 0.40];
	var HALBSCHATTEN = 0.15;
	var KERN = 0.70, RING = 0.75, RING_BREITE = 0.004;
	var SAUM = 0.65, SAUM_KANTE = 0.004, SAUM_STUFEN = 6;
	var WAND_BREITE = 0.025, WAND_LINKS = 0.42, WAND_RECHTS = 0.30, WAND_KOPF = 0.35;
	var KOPF_WAND_Y = 0.060;                     // ueber L: SCHRANK_Y1 in pinball-gpu.js
	var HOEHE_POSTEN = 33, HOEHE_BUMPER_FUSS = 8, HOEHE_BUMPER = 48;
	var HOEHE_ZIEL = 25, HOEHE_SLING = 29;      // mm
	var R_POSTEN_SICHT = 11.5;                   // mm
	var R_BUMPER_KOERPER = 19.5, R_SLING_PFOSTEN = 4.5, R_ZIEL_QUER = 6;   // mm
	var ZIEL_RING = 0.70, ZIEL_SCHLITZ = 0.55, ZIEL_SCHLITZ_MM = 2;
	var BUMPER_KOERPER_DECKUNG = 0.30, BUMPER_RING_MM = 6;
	var SLING_GUMMI_R = 0.0045, SLING_GUMMI_H = 0.0155;   // Gummi um die Sling-Pfosten, Mitte 15.5 mm
	/*
	 * Drahtfuehrungen (Task 8): kein Rohrsaum, sondern je Draht ein duenner
	 * Strich auf seiner Achse (tisch.js, T.draehte: Radius und Hoehe stehen
	 * dort), in Lichtrichtung um die Drahthoehe versetzt, dazu ein weicher
	 * Punkt je Beinfuss. Der Strich liegt im Bild links ~20 px neben dem
	 * Draht (der Draht steht 14.5 px ueber seinem Fusspunkt, dazu 3.4 / 4.8 mm
	 * Lichtversatz), rechts unter dem Drahtpaar - das Licht kommt von links.
	 * DRAHT_SAUM     Deckung relativ zu SAUM: 0.30 x 0.65 = 0.20 (Task 8: 0.6;
	 *                Fix-Runde 1: 0.45 gab links noch Delta 12-13, 0.30 gibt
	 *                Delta 9-10 bei Grund ~42 und bleibt bei 1x als weicher
	 *                Schatten lesbar).
	 * DRAHT_SAUM_MM  Strichbreite ueber den Drahtdurchmesser hinaus: 0, der
	 *                Kernschatten ist so breit wie der Draht (Task 8: 2 mm).
	 * DRAHT_HALB(_MM) Halbschatten: derselbe Strich 2 mm breiter mit Deckung
	 *                0.4 x DRAHT_SAUM-Deckung. Fix-Runde 1: mit 0.6 / 2 mm
	 *                und einem Strich las sich links ein harter, abgesetzter
	 *                zweiter Strich (Delta 13, 11 px breit).
	 * DRAHT_BEIN_MM  Radius des Fusspunkts (4.5 mm: das Bein selbst ist 1.6 mm
	 *                stark und deckt bei 3 mm den dunklen Kern fast ganz ab).
	 * DRAHT_BEIN_DECKUNG Kontaktschatten am Beinfuss, absolut und bewusst NICHT
	 *                an DRAHT_SAUM gekoppelt: mit DRAHT_SAUM 0.30 war der
	 *                Fusspunkt nur noch Delta 0-2 Luma und damit unsichtbar.
	 */
	var DRAHT_SAUM = 0.30, DRAHT_SAUM_MM = 0, DRAHT_HALB = 0.4, DRAHT_HALB_MM = 2, DRAHT_BEIN_MM = 4.5, DRAHT_BEIN_DECKUNG = 0.40;
	var ABRIEB_ZAHL = 30, ABRIEB_Y_MIN = 0.12, ABRIEB_Y_MAX = 0.45;
	var MM = 0.001;

	/*
	 * ------------------------------------------------- Insert-Stellschrauben
	 * (Pinball-Look Stufe 1, Task 2 "Inserts als hinterleuchtete Flaechen")
	 *
	 * Inserts sind im Feldbild AUSGESCHALTET gezeichnet: eine transluzente
	 * Kunststoffscheibe in der Lampenfarbe, dunkel und leicht milchig. Das
	 * Leuchten kommt im Renderer additiv ueber die Maske (einsatzMaske) dazu.
	 *
	 * INSERT_AUS         Grundfarbe = Lampenfarbe x INSERT_AUS (sRGB). Ziel:
	 *                    ausgeschaltet mindestens 1.5 x Feldgrund, aber unter
	 *                    dem halben Druck-Gelb. Wert aus der Messung am
	 *                    1920x1080-Bild (siehe Task-2-Bericht).
	 * INSERT_ENTSAETTIGT Anteil Richtung Grau: Kunststoff ohne Licht dahinter
	 *                    ist nie satt.
	 * INSERT_HOTSPOT     Die Birne sitzt unter der Mitte: Mitte 1.15 x, nach
	 *                    aussen auslaufend (weisse Ueberlagerung).
	 * FASE_MM            1 mm Fasenring am Rand, gegenueberliegend hell und
	 *                    dunkel entlang SCHATTEN_RICHTUNG. FASE_VERSENKT: das
	 *                    Insert sitzt leicht versenkt - die dem Licht zugewandte
	 *                    Kante (links/vorn, dort wo auch die Posten hell sind)
	 *                    liegt im Schatten, die abgewandte Kante faengt Licht.
	 *                    false dreht das um (erhabene Scheibe).
	 */
	var INSERT_AUS = 0.30, INSERT_ENTSAETTIGT = 0.15, INSERT_HOTSPOT = 0.15;
	var FASE_MM = 1.0, FASE_HELL = 0.28, FASE_DUNKEL = 0.45, FASE_VERSENKT = true;
	// Zielblenden werden nach Abschnitt 13 mit dieser Deckung nachgezeichnet
	// (halbiert den Schlagschatten der Fallziele auf der Blende, Fix-Runde 1)
	var BLENDE_NACH_SCHATTEN = 0.7;
	// Durchlass des Drucks auf dem Kunststoff (Maske, Kanal R): die Farbe
	// sperrt das Licht nicht ganz - die Ziffer bleibt dunkel, aber nicht
	// schwarz (Fix-Runde 1).
	var DRUCK_DURCHLASS = 0.2;

	function schwarz(a) { return "rgba(0,0,0," + Math.max(0, a).toFixed(4) + ")"; }
	function weiss(a) { return "rgba(255,255,255," + Math.max(0, a).toFixed(4) + ")"; }

	/*
	 * Kontaktschatten eines stehenden Teils, gezeichnet in Tischmetern (der
	 * Kontext traegt die Abbildung Tisch -> Bild). Zwei Verlaeufe:
	 *
	 * 1. Schlagschatten: eine weiche Ellipse um den Punkt, auf den die Oberkante
	 *    faellt - (x, y) + SCHATTEN_RICHTUNG * h. Quer misst sie r + 0.15 h;
	 *    laengs ist sie bis an den Fuss zurueckgezogen, sonst loest sich der
	 *    Schatten hoher, schlanker Teile vom Fuss. Der dunkelste Punkt sitzt auf
	 *    halbem Weg zum Fuss: dort ist ein Schatten am schaerfsten, zur Spitze
	 *    hin laeuft er weich aus.
	 * 2. AO-Ring direkt am Fuss, RING_BREITE (4 mm) ueber den Radius hinaus:
	 *    die Fuge, in die kein Licht kommt. Ohne Plateau - am Fuss voll, nach
	 *    aussen weich auslaufend.
	 *
	 * staerke skaliert beide Deckungen (1 = KERN, RING).
	 * opt.ring = false laesst den Ring weg (Teile, die nicht auf dem Feld
	 * stehen). opt.ringMm setzt die Ringbreite, opt.ringDeckung die Deckung
	 * des Rings (statt RING). opt.laengsMm und opt.achse machen den Grundriss
	 * laenglich - Fallziele: halbe Plattenlaenge und Richtung der Platte.
	 */
	function kontaktschatten(g, x, y, radiusMm, hoeheMm, staerke, opt) {
		opt = opt || {};
		var s = staerke === undefined ? 1 : staerke;
		var r = radiusMm * MM, h = hoeheMm * MM;
		var ringB = (opt.ringMm === undefined ? RING_BREITE : opt.ringMm * MM);
		var ringD = (opt.ringDeckung === undefined ? RING : opt.ringDeckung) * s;
		var dx = SCHATTEN_RICHTUNG[0] * h, dy = SCHATTEN_RICHTUNG[1] * h;
		var quer = r + HALBSCHATTEN * h;
		var laengs = (opt.laengsMm || 0) * MM;
		var w, a, b, fx, fy;                     // Drehung, Halbachsen, Fuss im Rahmen
		if (laengs > 0) {
			w = opt.achse || 0;
			var cw = Math.cos(w), sw = Math.sin(w);
			var ol = dx * cw + dy * sw, oq = -dx * sw + dy * cw;
			a = laengs + HALBSCHATTEN * h;
			b = Math.max(quer, Math.abs(oq) + r);
			fx = -ol; fy = -oq;
		} else {
			var lang = Math.hypot(dx, dy);
			w = lang > 0 ? Math.atan2(dy, dx) : 0;
			a = Math.max(quer, lang + 0.5 * r);
			b = quer;
			fx = -lang; fy = 0;
		}
		g.save();
		g.translate(x + dx, y + dy);
		g.rotate(w);
		g.scale(a / b, 1);
		var rg = g.createRadialGradient(0.5 * fx * b / a, 0.5 * fy, 0, 0, 0, b);
		rg.addColorStop(0.00, schwarz(KERN * s));
		rg.addColorStop(0.40, schwarz(KERN * s * 0.85));
		rg.addColorStop(0.75, schwarz(KERN * s * 0.45));
		rg.addColorStop(1.00, schwarz(0));
		g.fillStyle = rg;
		g.beginPath(); g.arc(0, 0, b, 0, Math.PI * 2); g.fill();
		g.restore();

		if (opt.ring === false) return;
		var rr = r + ringB;
		g.save();
		g.translate(x, y);
		if (laengs > 0) { g.rotate(w); g.scale((laengs + ringB) / rr, 1); }
		// Verlauf vom Fuss (r) nach aussen (r + Breite); innen bleibt die
		// volle Deckung - dort steht das Teil selbst darueber.
		var rk = g.createRadialGradient(0, 0, r, 0, 0, rr);
		rk.addColorStop(0.0, schwarz(ringD));
		rk.addColorStop(0.5, schwarz(ringD * 0.55));
		rk.addColorStop(1.0, schwarz(0));
		g.fillStyle = rk;
		g.beginPath(); g.arc(0, 0, rr, 0, Math.PI * 2); g.fill();
		g.restore();
	}

	/*
	 * Saum an den Banden. Je Rohrstaerke EIN Pfad aus allen Segmenten, in
	 * Lichtrichtung um die Mittenhoehe versetzt und in Stufen breiter gezogen.
	 * Ein Pfad je Stufe heisst: wo Segmente sich treffen oder kreuzen, wird
	 * nicht doppelt abgedunkelt; die runden Enden schliessen die Knicke.
	 */
	function bandenSaum(g, segmente) {
		var gruppen = {}, reihe = [];
		segmente.forEach(function (sg) {
			if (sg.unsichtbar) return;           // Physik-Anschlag ohne Rohr (tisch.js), kein Saum
			if (sg.draht) return;                // Drahtfuehrung: eigener Schatten (drahtSaum, Task 8)
			var gummi = sg.art === "sling";
			var rohr = gummi ? SLING_GUMMI_R : sg.r, mitte = gummi ? SLING_GUMMI_H : sg.r;
			var schl = rohr + "|" + mitte;
			if (!gruppen[schl]) { gruppen[schl] = { rohr: rohr, mitte: mitte, liste: [] }; reihe.push(gruppen[schl]); }
			gruppen[schl].liste.push(sg);
		});
		var stufe = 1 - Math.pow(1 - SAUM, 1 / SAUM_STUFEN);
		g.save();
		g.lineCap = "round"; g.lineJoin = "round";
		g.strokeStyle = schwarz(stufe);
		reihe.forEach(function (gr) {
			var ox = SCHATTEN_RICHTUNG[0] * gr.mitte, oy = SCHATTEN_RICHTUNG[1] * gr.mitte;
			for (var k = 1; k <= SAUM_STUFEN; k++) {
				g.lineWidth = 2 * gr.rohr + 2 * SAUM_KANTE * k / SAUM_STUFEN;
				g.beginPath();
				gr.liste.forEach(function (sg) {
					g.moveTo(sg.a[0] + ox, sg.a[1] + oy);
					g.lineTo(sg.b[0] + ox, sg.b[1] + oy);
				});
				g.stroke();
			}
		});
		g.restore();
	}

	/*
	 * Schatten der Drahtfuehrungen (Task 8): die 2D-Drahtachse aus tisch.js
	 * (links hinauf, Haarnadel, rechts zurueck) als EIN Strich je Fuehrung,
	 * um SCHATTEN_RICHTUNG x Drahthoehe versetzt - der Draht haengt 12 mm
	 * ueber dem Feld, sein Schatten liegt neben ihm, nicht unter ihm. Ein
	 * zweiter, breiterer und lichterer Strich legt den Halbschatten darum
	 * (Fix-Runde 1: sonst ein harter, abgesetzter zweiter Strich). Dazu je
	 * Beinfuss ein weicher Punkt (das Bein steht senkrecht, sein Schatten ist
	 * kurz; ohne Unterlegscheibe sitzt das Bein mit einem kleinen Kontaktschatten im Feld).
	 */
	function drahtSaum(g, draehte) {
		if (!draehte) return;
		var a = SAUM * DRAHT_SAUM;
		g.save();
		g.lineCap = "round"; g.lineJoin = "round";
		draehte.forEach(function (d) {
			var ox = SCHATTEN_RICHTUNG[0] * d.h, oy = SCHATTEN_RICHTUNG[1] * d.h;
			g.lineWidth = 2 * d.drahtR + DRAHT_SAUM_MM * MM;
			g.strokeStyle = schwarz(a);
			g.beginPath();
			d.achse.forEach(function (p, i) {
				if (i) g.lineTo(p[0] + ox, p[1] + oy); else g.moveTo(p[0] + ox, p[1] + oy);
			});
			g.stroke();
			// Halbschatten: derselbe Pfad DRAHT_HALB_MM breiter, Deckung
			// DRAHT_HALB x a - die Kante laeuft in zwei Stufen aus
			g.lineWidth += DRAHT_HALB_MM * MM;
			g.strokeStyle = schwarz(a * DRAHT_HALB);
			g.stroke();
			d.beine.forEach(function (f) {
				var r = DRAHT_BEIN_MM * MM, k = DRAHT_BEIN_DECKUNG;
				var rg = g.createRadialGradient(f[0], f[1], 0, f[0], f[1], r);
				rg.addColorStop(0, schwarz(k)); rg.addColorStop(0.5, schwarz(k * 0.55)); rg.addColorStop(1, schwarz(0));
				g.fillStyle = rg;
				g.beginPath(); g.arc(f[0], f[1], r, 0, Math.PI * 2); g.fill();
			});
		});
		g.restore();
	}

	/*
	 * ------------------------------------------------------------- Inserts
	 * Ein Insert ist eine Form in Tischmetern plus die Lampenfarbe darunter:
	 *   { id, x, y, form, radiusMm, farbe, ... }
	 *   form "kreis"   Scheibe r (Bonusleiter 1-8)
	 *   form "bahn"    Scheibe r plus die zwei Bahnstreifen (Kopfbahnen V F X)
	 *   form "pfeil"   Gassenpfeil, um `dreh` gedreht
	 *   form "stern"   Sternscheibe unter dem Bumper, Zacken als Druck
	 *   form "blende"  Zielblende, Viereck `punkte`
	 * `druck` sind die dunklen Druckteile AUF dem Kunststoff (Zahl, Buchstabe,
	 * Zacken); sie bleiben im Feldbild dunkel und werden in der Maske
	 * ausgespart, damit sie auch auf dem leuchtenden Insert dunkel bleiben.
	 *
	 * Dieselbe Pfadfunktion zeichnet Feldbild und Maske - so koennen die
	 * beiden nicht auseinanderlaufen.
	 */
	var maskeStand = null;                      // Inserts und Abbildung des letzten Feldbilds

	/*
	 * Schnittstelle nach aussen (window.Spielfeld): Schattenrichtung und
	 * Kontaktschatten - der Renderer versetzt Kugel- und Flipperschatten mit
	 * derselben Richtung, sonst fallen Schatten im Bild in zwei Richtungen;
	 * die Insert-Liste und die Maske fuer den Lampen-Shader; die
	 * Stellschrauben als Abschrift fuer die Pruefungen.
	 */
	var Spielfeld = {
		schattenRichtung: SCHATTEN_RICHTUNG,
		kontaktschatten: kontaktschatten,
		einsatzMaske: einsatzMaske,
		inserts: [],
		stellschrauben: { KERN: KERN, RING: RING, RING_BREITE: RING_BREITE, SAUM: SAUM, SAUM_KANTE: SAUM_KANTE,
		                  R_POSTEN_SICHT: R_POSTEN_SICHT, R_ZIEL_QUER: R_ZIEL_QUER, ZIEL_RING: ZIEL_RING,
		                  BUMPER_KOERPER_DECKUNG: BUMPER_KOERPER_DECKUNG, BUMPER_RING_MM: BUMPER_RING_MM,
		                  INSERT_AUS: INSERT_AUS, FASE_MM: FASE_MM, FASE_VERSENKT: FASE_VERSENKT,
		                  BLENDE_NACH_SCHATTEN: BLENDE_NACH_SCHATTEN, DRUCK_DURCHLASS: DRUCK_DURCHLASS,
		                  DRAHT_SAUM: DRAHT_SAUM, DRAHT_SAUM_MM: DRAHT_SAUM_MM, DRAHT_HALB: DRAHT_HALB,
		                  DRAHT_HALB_MM: DRAHT_HALB_MM, DRAHT_BEIN_MM: DRAHT_BEIN_MM,
		                  DRAHT_BEIN_DECKUNG: DRAHT_BEIN_DECKUNG }
	};

	function insertPfad(g, ins) {
		var x = ins.x, y = ins.y, r = ins.radiusMm * MM, k;
		g.beginPath();
		if (ins.form === "kreis" || ins.form === "stern") {
			g.arc(x, y, r, 0, Math.PI * 2);
		} else if (ins.form === "bahn") {
			g.arc(x, y, r, 0, Math.PI * 2);
			// zwei Streifen laengs der Bahn, Vierecke als eigene Teilpfade
			var c = Math.cos(ins.w), s = Math.sin(ins.w), qx = -s, qy = c;
			var hb = ins.streifenMm * MM / 2;
			[-1, 1].forEach(function (sgn) {
				var ox = ins.cx + qx * sgn * ins.abstand, oy = ins.cy + qy * sgn * ins.abstand;
				g.moveTo(ox + c * ins.r0 + qx * hb, oy + s * ins.r0 + qy * hb);
				g.lineTo(ox + c * ins.r1 + qx * hb, oy + s * ins.r1 + qy * hb);
				g.lineTo(ox + c * ins.r1 - qx * hb, oy + s * ins.r1 - qy * hb);
				g.lineTo(ox + c * ins.r0 - qx * hb, oy + s * ins.r0 - qy * hb);
				g.closePath();
			});
		} else if (ins.form === "pfeil") {
			var cw = Math.cos(ins.dreh), sw = Math.sin(ins.dreh);
			[[0, 0.016], [0.011, -0.004], [0.004, -0.004], [0.004, -0.016],
			 [-0.004, -0.016], [-0.004, -0.004], [-0.011, -0.004]].forEach(function (p, i) {
				var px = x + cw * p[0] - sw * p[1], py = y + sw * p[0] + cw * p[1];
				i ? g.lineTo(px, py) : g.moveTo(px, py);
			});
			g.closePath();
		} else if (ins.form === "blende") {
			for (k = 0; k < ins.punkte.length; k++) {
				k ? g.lineTo(ins.punkte[k][0], ins.punkte[k][1]) : g.moveTo(ins.punkte[k][0], ins.punkte[k][1]);
			}
			g.closePath();
		}
	}

	// Grundfarbe des ausgeschalteten Inserts: Lampenfarbe x INSERT_AUS, leicht
	// entsaettigt. Zurueck kommt rgb() und die Luminanz (0-255).
	function insertFarbe(lampenFarbe) {
		var c = lampenFarbe.map(function (v) { return v * 255 * INSERT_AUS; });
		var l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
		c = c.map(function (v) { return Math.round(v + (l - v) * INSERT_ENTSAETTIGT); });
		return { stil: "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")", luma: l };
	}

	// Druck auf dem Kunststoff: Zahl/Buchstabe und die Zacken der Sternscheibe.
	// `farbe` ist im Feldbild FARBE.linie bzw. grundTief, in der Maske schwarz.
	function insertDruck(g, ins, sx, sy, xRand, farbeText, farbeFlaeche, saumPx) {
		if (ins.text) {
			g.save();
			g.translate(ins.x, ins.y);
			g.scale(1 / sx, 1 / sy);
			g.fillStyle = farbeText; g.textAlign = "center"; g.textBaseline = "middle";
			// Schriftgroesse ist fuer 1024 Bildpunkte Breite gesetzt; die
			// Leinwandbreite ist 2 xRand * sx
			g.font = "700 " + (ins.textGroesse * 2 * xRand * Math.abs(sx) / 1024) + "px ui-monospace, SFMono-Regular, Menlo, monospace";
			// In der Maske bekommt die Schrift einen schmalen Saum: ein
			// 1-px-Strich wuerde beim Filtern zur halben Maske und leuchtete
			// mit - die Druckfarbe sperrt das Licht auch knapp neben dem Glyph.
			if (saumPx) { g.strokeStyle = farbeText; g.lineWidth = saumPx; g.lineJoin = "round"; g.strokeText(ins.text, 0, 0); }
			g.fillText(ins.text, 0, 0);
			g.restore();
		}
		if (ins.form === "stern") {
			var r = ins.radiusMm * MM;
			g.fillStyle = farbeFlaeche;
			for (var k = 0; k < ins.zacken; k++) {
				var a0 = k / ins.zacken * Math.PI * 2, a1 = a0 + Math.PI / ins.zacken * 0.72;
				g.beginPath(); g.moveTo(ins.x, ins.y);
				g.lineTo(ins.x + Math.cos(a0) * r, ins.y + Math.sin(a0) * r);
				g.lineTo(ins.x + Math.cos(a1) * r, ins.y + Math.sin(a1) * r);
				g.closePath(); g.fill();
			}
		}
	}

	/*
	 * Insert im Feldbild, ausgeschaltet: Grundfarbe, Birnen-Hotspot, Fase,
	 * Druck, Umrandung. Der Kontext traegt die Abbildung Tisch -> Bild; sx, sy
	 * sind ihre Skalen (fuer Schrift und Strichbreiten).
	 */
	function zeichneInsert(g, ins, sx, sy, xRand) {
		var px = 1 / sx, r = ins.radiusMm * MM;    // px: ein Bildpunkt in Metern
		var grund = insertFarbe(ins.farbe);
		insertPfad(g, ins);
		g.fillStyle = grund.stil; g.fill();

		g.save();
		insertPfad(g, ins); g.clip();
		// Hotspot: Mitte 1 + INSERT_HOTSPOT, nach aussen auslaufend
		var hx = ins.hx === undefined ? ins.x : ins.hx, hy = ins.hy === undefined ? ins.y : ins.hy;
		var a = INSERT_HOTSPOT * grund.luma / Math.max(1, 255 - grund.luma);
		var rg = g.createRadialGradient(hx, hy, 0, hx, hy, r);
		rg.addColorStop(0.0, weiss(a));
		rg.addColorStop(0.9, weiss(0));
		rg.addColorStop(1.0, weiss(0));
		g.fillStyle = rg;
		insertPfad(g, ins); g.fill();
		// Fase: ein Strich der Form, um die halbe Fasenbreite entlang der
		// Schattenrichtung versetzt, deckt innen nur auf einer Seite - das ist
		// der helle bzw. dunkle Rand. Versenkt: dunkel zum Licht hin.
		var ls = Math.hypot(SCHATTEN_RICHTUNG[0], SCHATTEN_RICHTUNG[1]) || 1;
		var dx = SCHATTEN_RICHTUNG[0] / ls * FASE_MM * MM / 2, dy = SCHATTEN_RICHTUNG[1] / ls * FASE_MM * MM / 2;
		var sgn = FASE_VERSENKT ? 1 : -1;
		g.lineWidth = FASE_MM * MM;
		g.translate(sgn * dx, sgn * dy);
		insertPfad(g, ins); g.strokeStyle = schwarz(FASE_DUNKEL); g.stroke();
		g.translate(-2 * sgn * dx, -2 * sgn * dy);
		insertPfad(g, ins); g.strokeStyle = weiss(FASE_HELL); g.stroke();
		g.restore();

		insertDruck(g, ins, sx, sy, xRand, FARBE.linie, FARBE.grundTief);
		// Umrandung wie `umrandet` im Feldbild: Breite in Bildpunkten
		insertPfad(g, ins);
		g.strokeStyle = FARBE.linie; g.lineWidth = (ins.linie || 1.6) * px; g.stroke();
	}

	/*
	 * Maske fuer den Lampen-Shader: alle Inserts des letzten Feldbilds auf
	 * der uebergebenen Leinwand mit derselben Abbildung wie das Feldbild (nur
	 * in anderer Aufloesung, z. B. 512 x 1024). Zwei Kanaele (Textur
	 * rg8unorm im Renderer):
	 *   R  die Form OHNE Druck - was leuchtet (Emission)
	 *   G  die Form MIT Druck  - worueber der Hof gedaempft wird; sonst legt
	 *      sich der Hof in die Druckaussparung und die Ziffer verschwindet
	 *      bei an = 1 (Fix-Runde 1).
	 * Form also Gelb (#FFFF00), Druck Gruen mit DRUCK_DURCHLASS in R, Rest
	 * Schwarz.
	 */
	function einsatzMaske(cv) {
		if (!maskeStand) throw new Error("einsatzMaske: erst spielfeldKunst aufrufen");
		var st = maskeStand, B = cv.width, H = cv.height;
		var g = cv.getContext("2d");
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.fillStyle = "#000000"; g.fillRect(0, 0, B, H);
		var sx = B / (2 * st.xRand), sy = -H / (st.y1 - st.y0);
		g.setTransform(sx, 0, 0, sy, B / 2, -st.y1 * sy);
		st.inserts.forEach(function (ins) {
			insertPfad(g, ins);
			g.fillStyle = "#FFFF00"; g.fill();
			var druck = "rgb(" + Math.round(255 * DRUCK_DURCHLASS) + ",255,0)";
			insertDruck(g, ins, sx, sy, st.xRand, druck, druck, 1.5 * B / 512);
		});
		return cv;
	}

	function spielfeldKunst(opt) {
		var t = opt.tisch, logo = opt.logo;
		var W = t.W, L = t.L, XM = t.XM, BOGEN_Y = t.bogenY, SCHACHT = t.schachtX;
		var B = 1024, H = 2048;                 // Zweierpotenzen: WebGL 1 braucht das fuer Mipmaps
		var cv = document.createElement("canvas");
		cv.width = B; cv.height = H;
		var g = cv.getContext("2d");
		var lampen = [], inserts = [];

		// Welchen Ausschnitt die Leinwand abdeckt, gibt der Aufrufer vor - er
		// baut das Netz aus denselben Zahlen.
		var xRand = opt.xRand, y0 = opt.y0, y1 = opt.y1;
		var sx = B / (2 * xRand), sy = -H / (y1 - y0);
		g.setTransform(sx, 0, 0, sy, B / 2, -y1 * sy);
		var mm = 1 / sx;                        // ein Bildpunkt in Metern
		// Die Maske (einsatzMaske) zeichnet dieselben Inserts mit derselben
		// Abbildung - sie liest diesen Stand.
		maskeStand = { inserts: inserts, xRand: xRand, y0: y0, y1: y1 };
		Spielfeld.inserts = inserts;
		function insert(ins) { inserts.push(ins); zeichneInsert(g, ins, sx, sy, xRand); return ins; }

		var RECHTS = SCHACHT - 0.008, LINKS = -W + 0.008;

		// -------------------------------------------------------- Werkzeuge
		function strich(breiteMM) { g.lineWidth = breiteMM * mm; }

		function text(s, x, y, groesse, farbe, dreh) {
			g.save();
			g.translate(x, y);
			g.scale(1 / sx, 1 / sy);
			if (dreh) g.rotate(dreh);
			g.fillStyle = farbe; g.textAlign = "center"; g.textBaseline = "middle";
			g.font = "700 " + groesse + "px ui-monospace, SFMono-Regular, Menlo, monospace";
			g.fillText(s, 0, 0);
			g.restore();
		}

		function stern(cx, cy, r, farbe) {
			g.beginPath();
			for (var k = 0; k < 10; k++) {
				var rad = k % 2 ? r * 0.42 : r;
				var w = -Math.PI / 2 + k * Math.PI / 5;
				var px = cx + Math.cos(w) * rad, py = cy + Math.sin(w) * rad;
				k ? g.lineTo(px, py) : g.moveTo(px, py);
			}
			g.closePath(); g.fillStyle = farbe; g.fill();
		}

		function umrandet(farbe, breiteMM) {
			g.fillStyle = farbe; g.fill();
			g.strokeStyle = FARBE.linie; strich(breiteMM || 1.6); g.stroke();
		}

		// ============================================================ 1. Grund
		// Eine einzige Farbe fuer das ganze Brett - das Blau der Seite. Zwei
		// Toene mit Bogenkante sahen nach Verlauf aus und nahmen der Grafik
		// darueber die Ruhe.
		g.fillStyle = FARBE.grund;
		g.fillRect(-xRand, y0, 2 * xRand, y1 - y0);

		// ==================================================== 2. Bogenbaender
		// 0 bis PI ist die OBERE Haelfte - in Tischkoordinaten zeigt y nach oben.
		function bogenband(radius, breite, farbe) {
			g.beginPath();
			g.arc(0, BOGEN_Y, radius + breite / 2, 0, Math.PI, false);
			g.arc(0, BOGEN_Y, radius - breite / 2, Math.PI, 0, true);
			g.closePath();
			umrandet(farbe, 1.4);
		}
		bogenband(W - 0.014, 0.016, FARBE.rot);
		bogenband(W - 0.034, 0.010, FARBE.gruen);
		bogenband(W - 0.048, 0.005, FARBE.gelb);

		for (var i = 0; i < 13; i++) {
			var a = (i + 0.5) / 13 * Math.PI, rr = W - 0.014;
			stern(Math.cos(a) * rr, BOGEN_Y + Math.sin(a) * rr, 0.0052, FARBE.weiss);
		}

		// ========================================================= 3. Blitze
		function blitz(x0, yy0, x1, yy1, breite, farbe) {
			var dx = x1 - x0, dy = yy1 - yy0, l = Math.hypot(dx, dy);
			var qx = -dy / l, qy = dx / l;
			var stufen = 5, pl = [], pr = [], k;
			for (k = 0; k <= stufen; k++) {
				var tt = k / stufen;
				var versatz = (k % 2 ? 1 : -1) * breite * 0.85;
				var bx = x0 + dx * tt, by = yy0 + dy * tt;
				var wgt = breite * (1 - tt * 0.55);
				pl.push([bx + qx * (versatz + wgt), by + qy * (versatz + wgt)]);
				pr.push([bx + qx * (versatz - wgt), by + qy * (versatz - wgt)]);
			}
			g.beginPath();
			pl.forEach(function (p, k2) { k2 ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); });
			for (k = pr.length - 1; k >= 0; k--) g.lineTo(pr[k][0], pr[k][1]);
			g.closePath();
			umrandet(farbe, 1.4);
		}

		// Je Bumper zwei Strahlen, die am Rand seiner Sternscheibe ansetzen und
		// von einem Punkt UNTERHALB der Gruppe fortzeigen - so laufen alle nach
		// oben und aussen und verschwinden nicht unter dem V.
		var bumper = t.scheiben.filter(function (q) { return q.art === "bumper"; });
		var zentrum = [XM, 0.560];
		bumper.forEach(function (q, nr) {
			var scheibeR = q.r + 0.024;
			var grund = Math.atan2(q.p[1] - zentrum[1], q.p[0] - zentrum[0]);
			[-0.78, 0.78].forEach(function (versatz, k) {
				var w2 = grund + versatz, rx = Math.cos(w2), ry = Math.sin(w2);
				var laenge = 0.100;
				while (laenge > 0.03) {
					var ex = q.p[0] + rx * (scheibeR + laenge);
					var ey = q.p[1] + ry * (scheibeR + laenge);
					var imBogen = ey <= BOGEN_Y || Math.hypot(ex, ey - BOGEN_Y) < W - 0.055;
					if (ex > LINKS && ex < RECHTS && ey > 0.620 && imBogen) break;
					laenge -= 0.008;
				}
				blitz(q.p[0] + rx * scheibeR,            q.p[1] + ry * scheibeR,
				      q.p[0] + rx * (scheibeR + laenge), q.p[1] + ry * (scheibeR + laenge),
				      0.0095, (nr + k) % 2 ? FARBE.orange : FARBE.gelb);
			});
		});

		// ==================================================== 4. Sternscheiben
		// Transluzente Scheibe unter dem Bumper, die Zacken sind Druck darauf;
		// die Bumperlampe laesst die Scheibe zwischen den Zacken leuchten.
		// Der rote Kern liegt unter dem Fuss (r 29 mm) und ist nie zu sehen.
		bumper.forEach(function (q, nr) {
			var farbe = [1.00, 0.86, 0.42];
			insert({ id: "bumper:" + nr, x: q.p[0], y: q.p[1], form: "stern",
			         radiusMm: (q.r + 0.024) / MM, farbe: farbe, zacken: 16, linie: 2 });
			g.beginPath(); g.arc(q.p[0], q.p[1], (q.r + 0.024) * 0.42, 0, Math.PI * 2);
			umrandet(FARBE.rot, 1.6);
			lampen.push({ x: q.p[0], y: q.p[1], r: q.r + 0.046,
			              farbe: farbe, art: "bumper", objekt: q, an: 0 });
		});

		// ===================================================== 5. Das grosse V
		// Auf die Spielfeldmitte XM bezogen, nicht auf die Schrankmitte: die
		// Flipper stehen dort, und darauf zielt das V.
		function keil(spitzeY, halbBreite, obenY, farbe) {
			g.beginPath();
			g.moveTo(XM, spitzeY);
			g.lineTo(XM - halbBreite, obenY);
			g.lineTo(XM + halbBreite, obenY);
			g.closePath();
			umrandet(farbe, 2);
		}
		// Die vier geschichteten Keile sind auf Wunsch weg - sie erschlugen die
		// Grafik. keil() bleibt fuer den Fall, dass ein einzelner zurueckkommt.
		void keil;

		blitz(XM - 0.030, 0.140, XM - 0.178, 0.578, 0.010, FARBE.gruen);
		blitz(XM + 0.030, 0.140, XM + 0.178, 0.578, 0.010, FARBE.gruen);

		// ==================================================== 6. Randstreifen
		function randstreifen(x, ya, yb, breite, sterne) {
			g.beginPath(); g.rect(x - breite / 2, ya, breite, yb - ya);
			umrandet(FARBE.rot, 1.4);
			for (var k = 0; k < sterne; k++) {
				stern(x, ya + (yb - ya) * (k + 0.5) / sterne, 0.0042, FARBE.weiss);
			}
		}
		randstreifen(-W + 0.008, 0.10, BOGEN_Y - 0.06, 0.012, 14);
		randstreifen(SCHACHT - 0.004, 0.10, BOGEN_Y - 0.13, 0.010, 12);

		// ================================================= 7. Slingshot-Flaechen
		var SL = t.slingshot;
		[-1, 1].forEach(function (seite) {
			function sx2(x) { return seite < 0 ? x : 2 * XM - x; }
			g.beginPath();
			g.moveTo(sx2(SL.a[0]), SL.a[1]);
			g.lineTo(sx2(SL.b[0]), SL.b[1]);
			g.lineTo(sx2(SL.c[0]), SL.c[1]);
			g.closePath();
			umrandet(FARBE.rotDunkel, 2);
			// Innenflaeche als heller Keil, wie die lackierte Blende
			g.beginPath();
			g.moveTo(sx2(SL.a[0] * 0.90 + SL.c[0] * 0.10), SL.a[1] * 0.90 + SL.c[1] * 0.10);
			g.lineTo(sx2(SL.b[0] * 0.88 + SL.c[0] * 0.12), SL.b[1] * 0.88 + SL.c[1] * 0.12);
			g.lineTo(sx2(SL.c[0]), SL.c[1]);
			g.closePath();
			g.fillStyle = FARBE.gelb; g.fill();
		});

		// ======================================================= 8. Fallziele
		// Hinterleuchtete Blende vor jeder Zielscheibe (Insert in der
		// Lampenfarbe), die Lampe sitzt 10 mm vor der Platte.
		t.ziele.forEach(function (z, nr) {
			var qx = -z.ny, qy = z.nx;           // laengs der Zielplatte
			var farbe = z.gruppe === "steh" ? [1.0, 0.80, 0.25] : [1.0, 0.55, 0.20];
			var lx = z.x + z.nx * 0.010, ly = z.y + z.ny * 0.010;
			insert({ id: "ziel:" + z.gruppe + ":" + z.nr, x: lx, y: ly, form: "blende", radiusMm: 24,
			         farbe: farbe, punkte: [
			             [z.x + qx * z.halb - z.nx * 0.004, z.y + qy * z.halb - z.ny * 0.004],
			             [z.x - qx * z.halb - z.nx * 0.004, z.y - qy * z.halb - z.ny * 0.004],
			             [z.x - qx * z.halb + z.nx * 0.017, z.y - qy * z.halb + z.ny * 0.017],
			             [z.x + qx * z.halb + z.nx * 0.017, z.y + qy * z.halb + z.ny * 0.017]] });
			void nr;
			lampen.push({ x: lx, y: ly, r: 0.026, farbe: farbe, art: "ziel", objekt: z, an: 0 });
		});
		// Beschriftung der Baenke
		text("DROP TARGETS", -W + 0.028, 0.520, 10, FARBE.gruen, -Math.PI / 2);
		text("DROP TARGETS", SCHACHT - 0.028, 0.460, 10, FARBE.gruen, Math.PI / 2);

		// ==================================================== 9. Kopfbahnen
		// Skill-Shot-Bahnen: Buchstabenscheibe und die zwei Bahnstreifen sind
		// EIN Insert und leuchten mit derselben Lampe. Der Lampenradius (44 mm)
		// deckt die Streifen (0.110 bis 0.186 vom Bogenmittelpunkt, +-20 mm) -
		// das Lampen-Quad muss die ganze Form umschliessen.
		t.rollover.filter(function (r) { return r.art === "bahn"; }).forEach(function (ro) {
			var w = Math.atan2(ro.y - BOGEN_Y, ro.x);
			insert({ id: "bahn:" + ro.buchstabe, x: ro.x, y: ro.y, form: "bahn", radiusMm: 16.5,
			         farbe: [0.55, 0.95, 0.42], w: w, cx: 0, cy: BOGEN_Y, r0: 0.110, r1: 0.186,
			         abstand: 0.020, streifenMm: 4, text: ro.buchstabe, textGroesse: 17, linie: 1.8 });
			lampen.push({ x: ro.x, y: ro.y, r: 0.044, farbe: [0.55, 0.95, 0.42],
			              art: "bahn", buchstabe: ro.buchstabe, objekt: ro, an: 0 });
		});

		// ============================================== 7c. Slingshot-Lampen
		// Unter jeder Platte sitzt eine Lampe, wie beim Vorbild. Sie glimmt
		// staendig und blitzt beim Treffer - das Regelwerk setzt `blitz` am
		// Gummisegment. Sie hat kein eigenes Insert im Feld (ohneInsert): der
		// Renderer liest fuer sie die Insert-Maske nicht. Ihr Quad (r 52 mm
		// um den Schwerpunkt) deckt seit den Gassen C+ den Rueckgassenpfeil
		// zu 91 % - sonst leuchtete der Pfeil bei jedem Treffer gelblich mit.
		(function () {
			var gummis = t.segmente.filter(function (sg) { return sg.art === "sling"; });
			[-1, 1].forEach(function (seite, k) {
				function fx(x) { return seite < 0 ? x : 2 * XM - x; }
				var cx = fx((SL.a[0] + SL.b[0] + SL.c[0]) / 3), cy = (SL.a[1] + SL.b[1] + SL.c[1]) / 3;
				lampen.push({ x: cx, y: cy, r: 0.052, farbe: [1.00, 0.80, 0.50],
							  art: "sling", objekt: gummis[k] || null, an: 0, ohneInsert: true });
			});
		})();

		// ================================================ 10. Bonusleiter 1..8
		// Die Leiter im unteren V. Sie ist die Bonusanzeige des Regelwerks:
		// Einsatz n leuchtet, sobald die Leiter Stufe n erreicht hat.
		function einsatz(x, y, r, nr) {
			insert({ id: "einsatz:" + nr, x: x, y: y, form: "kreis", radiusMm: r / MM,
			         farbe: [1.00, 0.72, 0.24], text: String(nr + 1), textGroesse: 15, linie: 1.8 });
			lampen.push({ x: x, y: y, r: r * 1.9, farbe: [1.00, 0.72, 0.24],
			              art: "einsatz", nr: nr, an: 0 });
		}
		[[0.000, 0.235], [-0.040, 0.278], [0.040, 0.278],
		 [-0.068, 0.325], [0.068, 0.325], [-0.046, 0.372], [0.046, 0.372],
		 [0.000, 0.418]].forEach(function (e, nr) {
			einsatz(XM + e[0], e[1], 0.0135, nr);
		});
		text("BONUS", XM, 0.198, 11, FARBE.gruen);

		// =================================================== 11. Gassenpfeile
		t.rollover.filter(function (r) { return r.art !== "bahn"; }).forEach(function (ro) {
			// Gassen sind an den Pfeilen senkrecht (vorher fuer schraege Gassen
			// gedreht: ro.seite * (auslauf ? 0.16 : -0.10))
			var dreh = 0;
			// Auslauf tiefrot (vorher [1, 0.35, 0.30]: additiv leuchtend wurde
			// daraus Rosa, weil Gruen und Blau mit hochliefen)
			var farbe = ro.art === "auslauf" ? [1.0, 0.24, 0.16] : [0.55, 0.95, 0.42];
			insert({ id: "pfeil:" + ro.id, x: ro.x, y: ro.y, form: "pfeil", radiusMm: 16,
			         farbe: farbe, dreh: dreh, linie: 1.4 });
			lampen.push({ x: ro.x, y: ro.y, r: 0.026, farbe: farbe, art: "pfeil", objekt: ro, an: 0 });
		});

		// ========================================================== 12. Logo
		var tafelB = 0.286, tafelH = 0.082, tafelY = 0.520;
		g.beginPath();
		g.rect(XM - tafelB / 2, tafelY - tafelH / 2, tafelB, tafelH);
		g.fillStyle = FARBE.linie; g.fill();
		g.strokeStyle = FARBE.gelb; strich(2.4); g.stroke();
		g.beginPath();
		g.rect(XM - tafelB / 2 + 0.005, tafelY - tafelH / 2 + 0.005, tafelB - 0.010, tafelH - 0.010);
		g.strokeStyle = FARBE.rot; strich(1.4); g.stroke();

		if (logo && logo.width && logo.height) {
			// Einpassen statt auf Breite ziehen - auf Breite gezogen lief das
			// Logo unten aus der Tafel heraus.
			var maxB = tafelB - 0.030, maxH = tafelH - 0.024;
			var verh = logo.width / logo.height;
			var breiteM = maxB, hoeheM = maxB / verh;
			if (hoeheM > maxH) { hoeheM = maxH; breiteM = maxH * verh; }
			g.save();
			g.translate(XM, tafelY); g.scale(1, -1);
			g.drawImage(logo, -breiteM / 2, -hoeheM / 2, breiteM, hoeheM);
			g.restore();
		}
		text("R I G I D   B O D Y", XM, tafelY - tafelH / 2 - 0.020, 13, FARBE.gelb);

		// ================================================ 13. Kontaktschatten
		/*
		 * Wo etwas auf dem Brett steht, faellt Schatten - in Lichtrichtung,
		 * nach rechts und zum Kopfende (SCHATTEN_RICHTUNG). Gebacken wird nur,
		 * was sich nicht bewegt: Schrankwaende, Banden, Posten, Bumper, Sling-
		 * Pfosten und die Zielbaenke im stehenden Zustand. Kugel und Flipper
		 * bekommen ihre Schatten im Renderer. Kommt zuletzt, weil Schatten ueber
		 * der Bedruckung liegt.
		 *
		 * Die fruehere Fassung legte Kreise mit 2.3 r und drei Striche
		 * beidseitig um jedes Teil - eine Verdunkelung ohne Richtung, die mit
		 * dem Fuehrungslicht nichts zu tun hatte. Sie ist ersetzt, nicht
		 * ueberlagert.
		 */
		// Schrankwaende: 25 mm ins Feld. Links liegt der Schatten der Wand
		// selbst, rechts nur die Fuge.
		[[-W, 1, WAND_LINKS], [W, -1, WAND_RECHTS]].forEach(function (wnd) {
			var lg = g.createLinearGradient(wnd[0], 0, wnd[0] + wnd[1] * WAND_BREITE, 0);
			lg.addColorStop(0, schwarz(wnd[2]));
			lg.addColorStop(0.45, schwarz(wnd[2] * 0.55));
			lg.addColorStop(1, schwarz(0));
			g.fillStyle = lg;
			g.fillRect(Math.min(wnd[0], wnd[0] + wnd[1] * WAND_BREITE), y0, WAND_BREITE, y1 - y0);
		});
		// Kopfende: die Wand unter dem Backglas, Lichtseite - nur die Fuge
		var kopfY = L + KOPF_WAND_Y;
		var lgK = g.createLinearGradient(0, kopfY, 0, kopfY - WAND_BREITE);
		lgK.addColorStop(0, schwarz(WAND_KOPF));
		lgK.addColorStop(0.45, schwarz(WAND_KOPF * 0.55));
		lgK.addColorStop(1, schwarz(0));
		g.fillStyle = lgK; g.fillRect(-xRand, kopfY - WAND_BREITE, 2 * xRand, y1 - kopfY + WAND_BREITE);

		// Banden und Gummis: Saum auf der lichtabgewandten Seite; die
		// Drahtfuehrungen als duenne Striche neben dem Draht (Task 8)
		bandenSaum(g, t.segmente);
		drahtSaum(g, t.draehte);

		// Posten (am sichtbaren Gummi-Aussenradius) und Bumper (Ring 6 mm
		// ueber den Fuss hinaus, weich - kein gedruckter Ring auf der Scheibe)
		t.scheiben.forEach(function (q) {
			if (q.art === "bumper") {
				kontaktschatten(g, q.p[0], q.p[1], q.r / MM, HOEHE_BUMPER_FUSS, 1, { ringMm: BUMPER_RING_MM });
				kontaktschatten(g, q.p[0], q.p[1], R_BUMPER_KOERPER, HOEHE_BUMPER,
				                BUMPER_KOERPER_DECKUNG / KERN, { ring: false });
			} else {
				kontaktschatten(g, q.p[0], q.p[1], R_POSTEN_SICHT, HOEHE_POSTEN, 1);
			}
		});
		// Sling-Pfosten: drei je Seite, an den Ecken des Dreiecks
		[-1, 1].forEach(function (seite) {
			[SL.a, SL.b, SL.c].forEach(function (e) {
				kontaktschatten(g, seite < 0 ? e[0] : 2 * XM - e[0], e[1], R_SLING_PFOSTEN, HOEHE_SLING, 1);
			});
		});
		// Ziele im stehenden Zustand - das Bild ist statisch, gefallene Ziele
		// sind die Ausnahme und stehen nach 1.6 s wieder
		t.ziele.forEach(function (z) {
			kontaktschatten(g, z.x, z.y, R_ZIEL_QUER, HOEHE_ZIEL, 1,
			                { laengsMm: z.halb / MM, achse: Math.atan2(z.ny, z.nx) + Math.PI / 2,
			                  ringDeckung: ZIEL_RING });
			// Schlitzlinie an der Vorderkante der Platte (halbe Dicke 3 mm):
			// die Fuge, in der das Ziel versinkt
			var qx = -z.ny, qy = z.nx, vx = z.nx * (0.003 + ZIEL_SCHLITZ_MM * MM / 2), vy = z.ny * (0.003 + ZIEL_SCHLITZ_MM * MM / 2);
			g.beginPath();
			g.moveTo(z.x + vx + qx * z.halb, z.y + vy + qy * z.halb);
			g.lineTo(z.x + vx - qx * z.halb, z.y + vy - qy * z.halb);
			g.strokeStyle = schwarz(ZIEL_SCHLITZ); g.lineWidth = ZIEL_SCHLITZ_MM * MM; g.lineCap = "butt";
			g.stroke();
		});
		// Zielblenden nach den Schatten mit halber Deckung nachzeichnen: der
		// Schlagschatten der Fallziele faellt in Lichtrichtung genau auf die
		// Blende davor (links gemessen 34-40 bei Grund 42). Halbiert liegt die
		// Blende aus wieder ueber dem Grund; die Schlitzlinie bleibt sichtbar,
		// weil die Blende hinter der Platte (−4 mm) beginnt (Fix-Runde 1).
		g.save();
		g.globalAlpha = BLENDE_NACH_SCHATTEN;
		inserts.forEach(function (ins) { if (ins.form === "blende") zeichneInsert(g, ins, sx, sy, xRand); });
		g.restore();

		// ======================================================= 14. Patina
		// Feine Koernung und ein Hauch Abrieb in den Laufwegen der Kugel. Ein
		// makellos glattes Brett sieht aus wie ein Rendering, nicht wie Holz
		// unter Lack.
		g.setTransform(1, 0, 0, 1, 0, 0);
		var samen = 31337;
		function wurf() { samen = (samen * 1103515245 + 12345) & 0x7fffffff; return samen / 0x7fffffff; }
		for (var kk = 0; kk < 9000; kk++) {
			var hell = wurf() < 0.5;
			g.fillStyle = hell ? "rgba(255,255,255," + (wurf() * 0.045) + ")"
							   : "rgba(0,0,0," + (wurf() * 0.06) + ")";
			g.fillRect(wurf() * B, wurf() * H, 1 + wurf() * 2, 1 + wurf() * 2);
		}
		// Abrieb: wenige helle, sehr schwache Laengsstriche - nur unten, wo die
		// Kugel wirklich laeuft: zwischen den Flippern und in den Gassen.
		// Gerechnet in Tischmetern, gezeichnet in Bildpunkten.
		for (kk = 0; kk < ABRIEB_ZAHL; kk++) {
			var axT = XM + (wurf() - 0.5) * 0.40;
			var ayT = ABRIEB_Y_MIN + wurf() * (ABRIEB_Y_MAX - ABRIEB_Y_MIN);
			var ax = (axT + xRand) * sx, ay = (ayT - y1) * sy;
			g.strokeStyle = "rgba(255,255,255," + (0.01 + wurf() * 0.02).toFixed(4) + ")";
			g.lineWidth = 1 + wurf() * 2;
			g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + (wurf() - 0.5) * 30, ay + 60 + wurf() * 220); g.stroke();
		}

		return { canvas: cv, lampen: lampen, inserts: inserts, einsatzMaske: einsatzMaske };
	}

	/*
	 * Backglas - die aufrechte Scheibe am Kopfende. Sie traegt das Logo und die
	 * Anzeige. `aktualisiere` zeichnet nur bei Aenderung neu; der Aufrufer laedt
	 * die Textur dann erneut hoch. Jedes Bild neu zu zeichnen waere Verschwendung.
	 */
	function backglasKunst(opt) {
		var logo = opt.logo;
		// Die Scheibe ist 1,81-mal so breit wie hoch (WebGPU, Task 5b: 0.544 m
		// zu 0.300 m; der WebGL-Rueckfall gibt sein eigenes Verhaeltnis). Ein
		// quadratisches Bild darauf zog das Logo um eben diesen Faktor in die
		// Breite. Die Leinwand bekommt das Verhaeltnis der Scheibe. Die
		// WebGPU-Fassung baut seit Task 5 Mipstufen ueber 1024 x 565 (eigene
		// Blit-Paesse); nur der WebGL-Rueckfall laedt ohne Mipmaps und braucht
		// dafuer die Freiheit der Nicht-Zweierpotenz-Hoehe.
		var B = 1024, H = Math.round(B / (opt.verhaeltnis || 1));
		// Schriften und Strichbreiten sind fuer 512 px Breite gesetzt
		var SK = B / 512;
		// Lampenradius an der Hoehe (Task 5b, Fix-Runde 1): bei 1024 x 591 war
		// er 24 px absolut; mit der kuerzeren Scheibe (H 565) beruehrten sich
		// Bonus-Reihe und Fusszeile, und die Fusszeilen-Kreise schnitten die
		// Goldlinie. 0.0405 H = 23.9 px bei 591, 22.9 px bei 565.
		var R_LAMPE = 0.0405 * H;
		var cv = document.createElement("canvas");
		cv.width = B; cv.height = H;
		var g = cv.getContext("2d");

		function txt(s, x, y, groesse, farbe, aus) {
			g.fillStyle = farbe;
			g.textAlign = aus || "center"; g.textBaseline = "middle";
			g.font = "700 " + (groesse * SK) + "px ui-monospace, SFMono-Regular, Menlo, monospace";
			g.fillText(s, (x + 1) * B / 2, (1 - y) * H);
		}
		function kasten(x0, y0, x1, y1) {
			g.beginPath();
			g.rect((x0 + 1) * B / 2, (1 - y1) * H, (x1 - x0) * B / 2, (y1 - y0) * H);
		}
		function lampe(x, y, an, farbe, beschriftung) {
			var cx = (x + 1) * B / 2, cy = (1 - y) * H;
			g.beginPath(); g.arc(cx, cy, R_LAMPE, 0, Math.PI * 2);
			g.fillStyle = an ? farbe : "#181C28"; g.fill();
			g.strokeStyle = an ? "#04060B" : "#2A2F3E"; g.lineWidth = 2 * SK; g.stroke();
			if (beschriftung) {
				g.fillStyle = an ? "#04060B" : "#525A6E";
				g.textAlign = "center"; g.textBaseline = "middle";
				// Schrift mit dem Radius (1.1 R = 25 px bei R 22.9; vorher 26 px fest)
				g.font = "700 " + Math.round(1.1 * R_LAMPE) + "px ui-monospace, SFMono-Regular, Menlo, monospace";
				g.fillText(beschriftung, cx, cy + SK);
			}
		}

		/*
		 * Schlicht gehalten: dunkler Grund, ein duenner Rahmen, Logo, Anzeige.
		 * Die frueheren Farbbaender und Sternreihen machten die Scheibe unruhig,
		 * und weil sie zusaetzlich mit dem Leuchtzuschlag ueberzogen war, lag ein
		 * gelber Schleier ueber allem.
		 */
		function aktualisiere(z) {
			g.setTransform(1, 0, 0, 1, 0, 0);
			g.fillStyle = "#0B0D14"; g.fillRect(0, 0, B, H);

			kasten(-0.955, 0.045, 0.955, 0.955);
			g.strokeStyle = "#7A6420"; g.lineWidth = 3 * SK; g.stroke();

			if (logo && logo.width && logo.height) {
				var maxB = 1.24 * B / 2, maxH = 0.19 * H;
				var verh = logo.width / logo.height;
				var bb = maxB, hh = maxB / verh;
				if (hh > maxH) { hh = maxH; bb = maxH * verh; }
				g.drawImage(logo, B / 2 - bb / 2, (1 - 0.800) * H - hh / 2, bb, hh);
			} else {
				txt("FRIDAYVFX", 0, 0.800, 48, FARBE.weiss);
			}
			// Deutlich unter dem Logo - vorher sass die Zeile an dessen Unterkante
			txt("R I G I D   B O D Y   P I N B A L L", 0, 0.612, 17, "#6E7789");

			// Punktefenster
			kasten(-0.82, 0.400, 0.82, 0.560);
			g.fillStyle = "#04060B"; g.fill();
			g.strokeStyle = "#2A3D2A"; g.lineWidth = 2 * SK; g.stroke();
			// Ziffern mit leichtem Gluehen (Canvas-Schatten in der eigenen
			// Farbe): die Anzeige ist hinterleuchtet, Leuchtziffern haben einen
			// weichen Saum (Look Stufe 1, Task 5)
			var p = String(z.punkte);
			g.save();
			g.shadowColor = FARBE.gruen; g.shadowBlur = 12 * SK;
			txt(("0000000" + p).slice(-Math.max(7, p.length)), 0, 0.481, 58, FARBE.gruen);
			g.restore();

			// Meldungszeile
			// Auf dem Handy gibt es keine Leertaste - dort heisst die Taste LAUNCH
			var beruehrung = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
			var zeile = z.meldung || (z.zustand === "attract" ? (beruehrung ? "TAP  LAUNCH  TO  START" : "PRESS  SPACE  TO  START")
			          : z.zustand === "aus" ? "GAME  OVER" : "");
			/*
			 * Untere Zeilen (Task 6, Leinwand 1024 x 565, R 22.9). Der Kreisrand
			 * ist lineWidth 2 SK = 4 px breit und ragt 2 px ueber R hinaus, jeder
			 * Kreis ist also 24.9 px hoch - die Rechnung der Fix-Runde 1 zu
			 * Task 5b (0.334 / 0.268 / 0.195 / 0.098) hatte ihn mit 1 px
			 * angesetzt, die Reihen lagen 4 px auseinander und die Fusszeilen-
			 * Kreise beruehrten die Goldlinie (Pruefung 5b). Jetzt: Meldung
			 * 0.345 (Mitte Zeile 370), BONUS 0.282 (Mitte 406), Bonus-Reihe
			 * 0.205 (Kreise mit Rand 424-474), Fusszeile 0.102 (483-532),
			 * Goldlinie 0.045 (Oberkante 537): rechnerisch 8 px Luft zwischen
			 * den Reihen und 4 px zur Linie; an der gerenderten Leinwand
			 * gemessen (Pixel, die vom Grund abweichen, Kantenglaettung
			 * mitgezaehlt): Bonus-Kreise 424-473, Fusszeile 482-532, Goldlinie
			 * 536-542 - 8 px Luft (Grundzeilen 474-481) und 3 px zur Linie,
			 * kein Kreis beruehrt sie. Im WebGL-Rueckfall (1024 x 591, R 23.9)
			 * 8 px und 4 px.
			 */
			txt(zeile, 0, 0.345, 20, FARBE.gelb);

			// Bonusleiter
			txt("BONUS", 0, 0.282, 13, "#6E7789");
			for (var k = 0; k < 8; k++) {
				lampe(-0.63 + k * 0.18, 0.205, k < z.bonus, FARBE.gelb, String(k + 1));
			}

			// Fusszeile: Bahnen links, Ball in der Mitte, Multiplikator rechts
			["V", "F", "X"].forEach(function (bu, j) {
				lampe(-0.79 + j * 0.155, 0.102, !!z.bahnen[bu], FARBE.gruen, bu);
			});
			txt("BALL", -0.12, 0.102, 16, "#6E7789", "right");
			txt(String(z.ball || 1), 0.02, 0.102, 20, FARBE.weiss, "left");
			[2, 3, 5].forEach(function (m, j) {
				lampe(0.48 + j * 0.155, 0.102, z.multi >= m, FARBE.rot, m + "X");
			});
			return cv;
		}

		aktualisiere({ punkte: 0, bonus: 0, multi: 1, bahnen: {}, ball: 1,
		               zustand: "attract", meldung: "" });
		return { canvas: cv, aktualisiere: aktualisiere };
	}

	/*
	 * Sling-Platte: das bedruckte, hinterleuchtete Plastik ueber den drei
	 * Pfosten. Ihr Umriss ist das Pfostendreieck, um seinen Schwerpunkt
	 * PLATTE_UEBERSTAND vergroessert (die Platte ragt ueber die Pfosten
	 * hinaus wie beim Vorbild), mit gerundeten Ecken - echte Platten sind
	 * ausgesaegt, nie spitz. Die Renderer bauen daraus das Netz, teileKunst
	 * legt den Druck in dieselben uv. Beide nehmen Umriss und uv von hier,
	 * so passt die Zeichnung nach jeder Aenderung an den Pfosten wieder auf
	 * die Platte (vorher stand das Zeichendreieck als feste Zahl im Bild und
	 * lief mit den Gassen C+ quer ueber die Platte).
	 *   ecken   die drei Ecken des vergroesserten Dreiecks, ungerundet, in
	 *           der Reihenfolge der Pfosten
	 *   umriss  der gerundete Umriss in Tischkoordinaten
	 *   uv(q)   planare Texturkoordinate eines Tischpunkts: die Bounding-Box
	 *           des Umrisses auf 0..1, v = 0 am Kopfende (oben im Bild)
	 * PLATTE_RAND: so weit liegt die gedruckte Umrandung innen vor der
	 * Plattenkante (1 mm, die 5 px breite Linie liegt dann ganz auf der
	 * Platte; aussen bleibt ein schmaler grauer Saum wie bisher).
	 */
	var PLATTE_UEBERSTAND = 1.22, PLATTE_RUNDUNG = 0.009, PLATTE_RAND = 0.001;

	// Ecken eines Umrisses runden: jede Ecke wird durch eine kurze Kurve
	// (quadratisch, n Stuecke) ersetzt, die r vor der Ecke ansetzt.
	function abgerundet(punkte, r, n) {
		var aus = [], m = punkte.length;
		for (var i = 0; i < m; i++) {
			var A = punkte[(i + m - 1) % m], P = punkte[i], B = punkte[(i + 1) % m];
			var la = Math.hypot(A[0]-P[0], A[1]-P[1]), lb = Math.hypot(B[0]-P[0], B[1]-P[1]);
			var ta = Math.min(0.45, r / la), tb = Math.min(0.45, r / lb);
			var Q1 = [P[0] + (A[0]-P[0]) * ta, P[1] + (A[1]-P[1]) * ta];
			var Q2 = [P[0] + (B[0]-P[0]) * tb, P[1] + (B[1]-P[1]) * tb];
			for (var k = 0; k <= n; k++) {
				var t = k / n, u = 1 - t;
				aus.push([u*u*Q1[0] + 2*u*t*P[0] + t*t*Q2[0], u*u*Q1[1] + 2*u*t*P[1] + t*t*Q2[1]]);
			}
		}
		return aus;
	}

	function slingPlatte(pfosten) {
		var cx = (pfosten[0][0] + pfosten[1][0] + pfosten[2][0]) / 3;
		var cy = (pfosten[0][1] + pfosten[1][1] + pfosten[2][1]) / 3;
		var ecken = pfosten.map(function (e) {
			return [cx + (e[0] - cx) * PLATTE_UEBERSTAND, cy + (e[1] - cy) * PLATTE_UEBERSTAND];
		});
		var umriss = abgerundet(ecken, PLATTE_RUNDUNG, 5);
		var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
		umriss.forEach(function (q) {
			minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]);
			miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]);
		});
		return {
			ecken: ecken,
			umriss: umriss,
			uv: function (q) { return [(q[0] - minx) / (maxx - minx), 1 - (q[1] - miny) / (maxy - miny)]; }
		};
	}

	/*
	 * Teileblatt - vier Flaechen auf einer Textur: Bumperkappe, Fallziel,
	 * Stehziel und die Blende am Auslauf. Ein Blatt statt vier Texturen spart
	 * Umschaltungen beim Zeichnen, und die Grautoene werden im Shader mit der
	 * Bauteilfarbe eingefaerbt - dieselbe Zielflaeche wird so rot oder orange,
	 * ohne dass sie zweimal gezeichnet werden muss.
	 *
	 * Die Ausschnitte stehen in TEILE_FELD, damit der Zeichner sie nicht raten
	 * muss. opt.tisch ist die Tischbeschreibung: aus ihr kommt die Form der
	 * Sling-Platte (slingPlatte).
	 */
	var TEILE_FELD = {
		bumperKappe: [0.00, 0.0, 0.25, 0.5],
		fallziel:    [0.25, 0.0, 0.25, 0.5],
		stehziel:    [0.00, 0.5, 0.25, 0.5],
		blende:      [0.25, 0.5, 0.25, 0.5],
		slingPlatte: [0.50, 0.0, 0.25, 1.0]      // hochkant, 256 x 512
	};

	function teileKunst(opt) {
		var tisch = opt && opt.tisch;
		var N = 1024, cv = document.createElement("canvas");
		cv.width = N; cv.height = N / 2;
		var g = cv.getContext("2d");
		var H = N / 4;                          // Kantenlaenge eines quadratischen Feldes

		function feld(ix, iy, zeichner) {
			g.save();
			g.beginPath(); g.rect(ix * H, iy * H, H, H); g.clip();
			g.translate(ix * H, iy * H);
			zeichner(H);
			g.restore();
		}
		function feldRechteck(x, y, b, h, zeichner) {
			g.save();
			g.beginPath(); g.rect(x, y, b, h); g.clip();
			g.translate(x, y);
			zeichner(b, h);
			g.restore();
		}
		function beschriftung(s, x, y, groesse, farbe) {
			g.fillStyle = farbe; g.textAlign = "center"; g.textBaseline = "middle";
			g.font = "700 " + groesse + "px ui-monospace, SFMono-Regular, Menlo, monospace";
			g.fillText(s, x, y);
		}

		// Bumperkappe von oben: konzentrische Ringe wie die gefraeste Kunststoffkappe
		feld(0, 0, function (h) {
			g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, h, h);
			var m = h / 2;
			[[0.48, "#E8E8EA"], [0.40, "#FFFFFF"], [0.30, "#D8D8DC"], [0.20, "#FFFFFF"]]
				.forEach(function (r) {
					g.beginPath(); g.arc(m, m, h * r[0], 0, Math.PI * 2);
					g.fillStyle = r[1]; g.fill();
					g.strokeStyle = "rgba(0,0,0,.22)"; g.lineWidth = 3; g.stroke();
				});
			for (var k = 0; k < 12; k++) {
				var a = k / 12 * Math.PI * 2;
				g.beginPath();
				g.moveTo(m + Math.cos(a) * h * 0.22, m + Math.sin(a) * h * 0.22);
				g.lineTo(m + Math.cos(a) * h * 0.44, m + Math.sin(a) * h * 0.44);
				g.strokeStyle = "rgba(0,0,0,.16)"; g.lineWidth = 6; g.stroke();
			}
			// Die Lampe sitzt unter der Mitte: zum Rand hin wird die Kappe
			// dunkler, das Leuchten (leucht im Renderer) konzentriert sich
			// in der Mitte (Task 2).
			var lampe = g.createRadialGradient(m, m, 0, m, m, h * 0.5);
			lampe.addColorStop(0.00, "rgba(0,0,0,0)");
			lampe.addColorStop(0.35, "rgba(0,0,0,0.04)");
			lampe.addColorStop(1.00, "rgba(0,0,0,0.34)");
			g.fillStyle = lampe; g.fillRect(0, 0, h, h);
			beschriftung("100", m, m, 46, "rgba(0,0,0,.55)");
		});

		// Fallziel: helle Platte mit Pfeil - im Shader wird sie eingefaerbt
		feld(1, 0, function (h) {
			g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, h, h);
			g.fillStyle = "rgba(0,0,0,.16)"; g.fillRect(0, h * 0.80, h, h * 0.20);
			g.fillStyle = "rgba(255,255,255,.45)"; g.fillRect(0, 0, h, h * 0.14);
			g.beginPath();
			g.moveTo(h * 0.50, h * 0.24);
			g.lineTo(h * 0.72, h * 0.52);
			g.lineTo(h * 0.60, h * 0.52);
			g.lineTo(h * 0.60, h * 0.72);
			g.lineTo(h * 0.40, h * 0.72);
			g.lineTo(h * 0.40, h * 0.52);
			g.lineTo(h * 0.28, h * 0.52);
			g.closePath();
			g.fillStyle = "rgba(0,0,0,.42)"; g.fill();
		});

		// Stehziel: Platte mit Zielkreis
		feld(0, 1, function (h) {
			g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, h, h);
			var m = h / 2;
			[[0.34, "rgba(0,0,0,.40)"], [0.24, "rgba(255,255,255,.9)"], [0.13, "rgba(0,0,0,.40)"]]
				.forEach(function (r) {
					g.beginPath(); g.arc(m, m * 1.05, h * r[0], 0, Math.PI * 2);
					g.fillStyle = r[1]; g.fill();
				});
			g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(0, h * 0.84, h, h * 0.16);
		});

		/*
		 * Platte der Slingshots: bedrucktes, hinterleuchtetes Plastik wie beim
		 * Vorbild. Cremefarbener Grund, dunkle Umrandung, Grafik im Stil des
		 * Feldes. Die Form kommt aus dem Tisch (slingPlatte, linke Platte - die
		 * rechte ist im Netz gespiegelt): das Netz legt die Bounding-Box des
		 * Umrisses auf dieses Feld, hier wird derselbe Umriss mit derselben uv
		 * gezeichnet, um PLATTE_RAND nach innen versetzt, damit die Umrandung
		 * ganz auf der Platte liegt. Die Grafik sitzt in Schwerpunktkoordinaten
		 * der Ecken a (unten innen, der Gummi beginnt), b (oben, der Gummi
		 * endet) und c (unten aussen) und wandert mit, wenn sich die Pfosten
		 * verschieben. Mit den Gassen C+ ist die Platte schlank und hoch: die
		 * Aussenkante b-c steht senkrecht, die lange Kante a-b ist der Gummi,
		 * die "10" sitzt im Inkreis, der Blitz im Arm zur Ecke a.
		 */
		feldRechteck(2 * H, 0, H, 2 * H, function (b, h) {
			// Rand aussen: neutrales Grau fuer die Seitenflaechen, siehe
			// Netzbau - die Seiten zeigen auf die linke obere Ecke (uv
			// 0.01|0.01). Dort liegt jetzt die Spitze b; die nach innen
			// versetzte Zeichnung laesst den Punkt grau (vorher traf ihn die
			// Gehrung der Umrandung, die Seiten waren schwarz)
			g.fillStyle = "#C9C2B4"; g.fillRect(0, 0, b, h);
			if (!tisch) return;                 // ohne Tisch (Pruefstand) bleibt das Feld grau
			var SL = tisch.slingshot, pl = slingPlatte([SL.a, SL.b, SL.c]), E = pl.ecken;
			// Inkreis des Plattendreiecks (Tischmeter): Mitte I, Radius 2F/Umfang
			function abst(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }
			var la = abst(E[1], E[2]), lb = abst(E[2], E[0]), lc = abst(E[0], E[1]), um = la + lb + lc;
			var I = [(la * E[0][0] + lb * E[1][0] + lc * E[2][0]) / um, (la * E[0][1] + lb * E[1][1] + lc * E[2][1]) / um];
			var fl = Math.abs((E[1][0] - E[0][0]) * (E[2][1] - E[0][1]) - (E[2][0] - E[0][0]) * (E[1][1] - E[0][1])) / 2;
			// Zum Inkreismittelpunkt gestaucht: jede gerade Kante wandert
			// genau PLATTE_RAND nach innen
			var k = 1 - PLATTE_RAND / (2 * fl / um);
			function bild(q) {
				var t = pl.uv([I[0] + (q[0] - I[0]) * k, I[1] + (q[1] - I[1]) * k]);
				return [t[0] * b, t[1] * h];
			}
			var pa = bild(E[0]), pb = bild(E[1]), pc = bild(E[2]);
			// Punkt aus Schwerpunktkoordinaten (Anteil a, Anteil b, Rest c)
			function bei(wa, wb) {
				var wc = 1 - wa - wb;
				return [wa * pa[0] + wb * pb[0] + wc * pc[0], wa * pa[1] + wb * pb[1] + wc * pc[1]];
			}
			function zug(punkte) {
				g.beginPath();
				punkte.forEach(function (w, i) { var p = bei(w[0], w[1]); i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); });
				g.closePath();
			}
			var rand = pl.umriss.map(bild);
			function randPfad() {
				g.beginPath();
				rand.forEach(function (p, i) { i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); });
				g.closePath();
			}
			g.save();
			randPfad(); g.clip();
			g.fillStyle = "#EDE4D3"; g.fillRect(0, 0, b, h);
			// Zwei Farbbaender laengs des Gummis (Kante a-b), von der Spitze b
			// bis vor den Arm zur Ecke a (bis Gassen C+ lagen sie, wie der
			// vierte Stern, ganz ausserhalb des festen Zeichendreiecks)
			zug([[0.05, 0.90], [0.45, 0.50], [0.45, 0.43], [0.05, 0.83]]);
			g.fillStyle = "#C8202B"; g.fill();
			zug([[0.08, 0.77], [0.42, 0.43], [0.42, 0.38], [0.08, 0.72]]);
			g.fillStyle = "#E8721A"; g.fill();
			// Blitz in Gruen, laengs des Arms zur Ecke a, Spitze zum Pfosten a.
			// Die Punkte sind auf die Form C+ eingepasst: Lage und Umriss
			// wandern mit den Pfosten, bei deutlich anderer Form schert der
			// Blitz aber - dann neu einpassen
			zug([[0.288, 0.093], [0.231, 0.217], [0.438, 0.225], [0.393, 0.350],
			     [0.647, 0.191], [0.447, 0.208], [0.482, 0.097]]);
			g.fillStyle = "#81E458"; g.fill(); g.strokeStyle = "#050A14"; g.lineWidth = 3; g.stroke();
			// Sterne
			[[0.062, 0.673], [0.082, 0.287], [0.719, 0.101], [0.191, 0.091]].forEach(function (st) {
				var m = bei(st[0], st[1]), r = 9;
				g.beginPath();
				for (var j = 0; j < 10; j++) {
					var rad = j % 2 ? r * 0.42 : r, w = -Math.PI / 2 + j * Math.PI / 5;
					j ? g.lineTo(m[0] + Math.cos(w) * rad, m[1] + Math.sin(w) * rad) : g.moveTo(m[0] + Math.cos(w) * rad, m[1] + Math.sin(w) * rad);
				}
				g.closePath(); g.fillStyle = "#F2B705"; g.fill();
			});
			var zehn = bei(0.245, 0.31);
			beschriftung("10", zehn[0], zehn[1], 34, "#050A14");
			// Schriftzug laengs der Aussenkante, von c nach b lesend
			var sl = bei(0.07, 0.479);
			g.save(); g.translate(sl[0], sl[1]); g.rotate(Math.atan2(pb[1] - pc[1], pb[0] - pc[0]));
			beschriftung("S L I N G", 0, 0, 15, "rgba(5,10,20,0.75)");
			g.restore();
			g.restore();
			// Umrandung der Platte
			randPfad();
			g.strokeStyle = "#050A14"; g.lineWidth = 5; g.stroke();
		});

		// Blende am Auslauf: geriffeltes Blech mit Aufschrift
		feld(1, 1, function (h) {
			g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, h, h);
			for (var k = 0; k < 26; k++) {
				g.fillStyle = k % 2 ? "rgba(0,0,0,.10)" : "rgba(255,255,255,.5)";
				g.fillRect(0, k * h / 26, h, h / 52);
			}
			g.fillStyle = "rgba(0,0,0,.30)";
			g.fillRect(h * 0.10, h * 0.34, h * 0.80, h * 0.30);
			beschriftung("FRIDAYVFX", h / 2, h * 0.44, 26, "rgba(255,255,255,.92)");
			beschriftung("RIGID BODY", h / 2, h * 0.56, 18, "rgba(255,255,255,.62)");
		});

		return cv;
	}

	global.spielfeldKunst = spielfeldKunst;
	global.backglasKunst = backglasKunst;
	/*
	 * Schrankblatt - die Flaechen des Holzschranks auf einer Textur:
	 *   innen   die Innenwand ueber dem Feld, lackiert, mit Zierband und Sternen
	 *   aussen  die Seitengrafik, wie die Decals echter Geraete
	 *   kante   die Holzoberkante, auf der die Glasleiste sitzt
	 *   front   die Vorderfront mit Muenzeinwurf
	 * Die Ausschnitte stehen in SCHRANK_FELD; das Netz traegt sie direkt in
	 * seinen Texturkoordinaten, weil ein Schrank aus lauter verschiedenen
	 * Flaechen in EINEM Zug gezeichnet wird.
	 */
	var SCHRANK_FELD = {
		innen:  [0, 0.00000, 1, 0.21875],
		aussen: [0, 0.21875, 1, 0.43750],
		kante:  [0, 0.65625, 1, 0.12500],
		front:  [0, 0.78125, 1, 0.21875]
	};

	function schrankKunst(opt) {
		var logo = opt && opt.logo;
		var B = 1024, H = 512, cv = document.createElement("canvas");
		cv.width = B; cv.height = H;
		var g = cv.getContext("2d");
		var samen = 9137;
		function wurf() { samen = (samen * 1103515245 + 12345) & 0x7fffffff; return samen / 0x7fffffff; }
		function zeile(y0, y1, zeichner) {
			g.save();
			g.beginPath(); g.rect(0, y0, B, y1 - y0); g.clip();
			g.translate(0, y0);
			zeichner(B, y1 - y0);
			g.restore();
		}
		function sternchen(cx, cy, r, farbe) {
			g.beginPath();
			for (var k = 0; k < 10; k++) {
				var rad = k % 2 ? r * 0.42 : r, w = -Math.PI / 2 + k * Math.PI / 5;
				var px = cx + Math.cos(w) * rad, py = cy + Math.sin(w) * rad;
				k ? g.lineTo(px, py) : g.moveTo(px, py);
			}
			g.closePath(); g.fillStyle = farbe; g.fill();
		}
		function schrift(s2, x, y, groesse, farbe, aus) {
			g.fillStyle = farbe; g.textAlign = aus || "center"; g.textBaseline = "middle";
			g.font = "700 " + groesse + "px ui-monospace, SFMono-Regular, Menlo, monospace";
			g.fillText(s2, x, y);
		}
		function holz(b, h, dunkel, hell) {
			var verlauf = g.createLinearGradient(0, 0, 0, h);
			verlauf.addColorStop(0, hell); verlauf.addColorStop(0.5, dunkel); verlauf.addColorStop(1, hell);
			g.fillStyle = verlauf; g.fillRect(0, 0, b, h);
			for (var k = 0; k < 70; k++) {
				var y = wurf() * h, amp = 1 + wurf() * 3, per = 120 + wurf() * 300;
				g.beginPath();
				for (var x = 0; x <= b; x += 8) {
					var yy = y + Math.sin(x / per + k) * amp;
					x === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
				}
				g.strokeStyle = wurf() < 0.5 ? "rgba(60,35,18," + (0.15 + wurf() * 0.25) + ")"
											 : "rgba(240,205,160," + (0.08 + wurf() * 0.14) + ")";
				g.lineWidth = 0.6 + wurf() * 1.8;
				g.stroke();
			}
		}

		// ---- innen: dunkel lackiert, Zierband unten, Sterne, Pinselstruktur
		zeile(0, 112, function (b, h) {
			g.fillStyle = "#171B2C"; g.fillRect(0, 0, b, h);
			for (var k = 0; k < 400; k++) {
				g.fillStyle = "rgba(255,255,255," + (wurf() * 0.035) + ")";
				g.fillRect(wurf() * b, 0, 1 + wurf() * 2, h);
			}
			g.fillStyle = FARBE.rot; g.fillRect(0, h - 30, b, 16);
			g.fillStyle = FARBE.gruen; g.fillRect(0, h - 36, b, 3);
			g.fillStyle = FARBE.gelb; g.fillRect(0, h - 11, b, 2);
			for (k = 0; k < 22; k++) sternchen(24 + k * 46, h - 22, 5, FARBE.weiss);
			// Glasnut oben: dunkle Rille
			g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(0, 0, b, 6);
			g.fillStyle = "rgba(255,255,255,0.10)"; g.fillRect(0, 6, b, 2);
		});

		// ---- aussen: Seitengrafik mit Schraegbaendern, Sternen und Wortmarke
		zeile(112, 336, function (b, h) {
			g.fillStyle = "#1B1F30"; g.fillRect(0, 0, b, h);
			var baender = [[FARBE.rotDunkel, 0], [FARBE.rot, 34], [FARBE.orange, 62], [FARBE.gelb, 84]];
			baender.forEach(function (e) {
				g.beginPath();
				g.moveTo(0, h); g.lineTo(0, h - 120 + e[1]);
				g.lineTo(b * 0.42 + e[1] * 2, h - 210 + e[1] * 1.2);
				g.lineTo(b, h - 26 + e[1] * 0.3); g.lineTo(b, h);
				g.closePath(); g.fillStyle = e[0]; g.fill();
			});
			// Lichtstrahl, der schraeg ueber das Band laeuft
			var strahl = g.createLinearGradient(0, 0, b, 0);
			strahl.addColorStop(0, "rgba(255,255,255,0)");
			strahl.addColorStop(0.5, "rgba(255,255,255,0.08)");
			strahl.addColorStop(1, "rgba(255,255,255,0)");
			g.fillStyle = strahl; g.fillRect(0, 0, b, h);
			for (var k = 0; k < 28; k++) sternchen(30 + wurf() * (b - 60), 14 + wurf() * 70, 3 + wurf() * 5, FARBE.weiss);
			if (logo && logo.width) {
				var bb = 300, hh = bb * logo.height / logo.width;
				if (hh > 80) { hh = 80; bb = hh * logo.width / logo.height; }
				g.drawImage(logo, b * 0.5 - bb / 2, 40, bb, hh);
			} else {
				schrift("FRIDAYVFX", b * 0.5, 70, 56, FARBE.weiss);
			}
			schrift("R I G I D   B O D Y   P I N B A L L", b * 0.5, 140, 18, "rgba(255,255,255,0.75)");
			// Kantenverschleiss: ein wenig heller Abrieb entlang der Oberkante
			g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(0, 0, b, 4);
		});

		// ---- kante: Holz
		zeile(336, 400, function (b, h) { holz(b, h, "#7B5533", "#9E7046"); });

		// ---- front: Grafik, Muenztuer, Schild
		zeile(400, 512, function (b, h) {
			g.fillStyle = "#1B1F30"; g.fillRect(0, 0, b, h);
			g.fillStyle = FARBE.rot; g.fillRect(0, h - 26, b, 12);
			g.fillStyle = FARBE.gelb; g.fillRect(0, h - 12, b, 3);
			for (var k = 0; k < 20; k++) sternchen(30 + k * 50, h - 20, 4, FARBE.weiss);
			// Muenztuer: Blech mit zwei Einwuerfen und Schloss
			var tx = b * 0.5 - 110, ty = 14, tb = 220, th = 70;
			g.fillStyle = "#5A6068"; g.fillRect(tx, ty, tb, th);
			g.strokeStyle = "#20242A"; g.lineWidth = 3; g.strokeRect(tx, ty, tb, th);
			g.fillStyle = "#8C939C"; g.fillRect(tx + 6, ty + 6, tb - 12, th - 12);
			[tx + 50, tx + 170].forEach(function (x) {
				g.fillStyle = "#101216"; g.fillRect(x - 5, ty + 16, 10, 30);
				g.fillStyle = "#C8CDD4"; g.fillRect(x - 12, ty + 14, 24, 4);
				schrift("25c", x, ty + 58, 10, "#20242A");
			});
			g.beginPath(); g.arc(tx + tb / 2, ty + th / 2 + 4, 8, 0, Math.PI * 2);
			g.fillStyle = "#B8BEC6"; g.fill();
			g.fillStyle = "#20242A"; g.fillRect(tx + tb / 2 - 1, ty + th / 2 - 1, 2, 10);
			// Schild links und rechts
			schrift("FRIDAYVFX", b * 0.18, 46, 26, FARBE.weiss);
			schrift("PINBALL", b * 0.82, 46, 26, FARBE.gruen);
		});

		return cv;
	}

	/*
	 * Eiche, prozedural - der Ersatz, wenn umgebung/holz.jpg fehlt. Nach der
	 * Vorlage: honigfarben, breite weiche Kathedralboegen, feine gerade Maserung
	 * mit wenig Kontrast. Die Maserung laeuft waagerecht (entlang u).
	 *
	 * Die Textur wird gespiegelt gekachelt (MIRRORED_REPEAT), deshalb muss sie
	 * nicht nahtlos sein. Angesetzt wird sie in Metern: eine Kachel sind 30 cm,
	 * auf jeder Holzflaeche gleich - so kann nichts mehr gestreckt werden.
	 */
	function holzKunst() {
		var N = 512, cv = document.createElement("canvas");
		cv.width = cv.height = N;
		var g = cv.getContext("2d");
		var samen = 2718;
		function wurf() { samen = (samen * 1103515245 + 12345) & 0x7fffffff; return samen / 0x7fffffff; }

		// Grund: honigfarbene Baender, weich ineinander
		var grund = g.createLinearGradient(0, 0, 0, N);
		[[0.00, "#D6AC74"], [0.18, "#B8874F"], [0.34, "#D9B07A"], [0.52, "#A97A46"],
		 [0.70, "#D2A66E"], [0.86, "#B1824C"], [1.00, "#D6AC74"]].forEach(function (e) {
			grund.addColorStop(e[0], e[1]);
		});
		g.fillStyle = grund; g.fillRect(0, 0, N, N);

		// Flecken: leichte Tonschwankungen
		for (var k = 0; k < 14; k++) {
			var fx = wurf() * N, fy = wurf() * N, fr = 60 + wurf() * 160;
			var rg = g.createRadialGradient(fx, fy, 0, fx, fy, fr);
			var hell = wurf() < 0.5;
			rg.addColorStop(0, hell ? "rgba(240,215,170,0.16)" : "rgba(140,95,50,0.14)");
			rg.addColorStop(1, "rgba(0,0,0,0)");
			g.fillStyle = rg; g.fillRect(0, 0, N, N);
		}

		// Kathedralboegen: ineinanderliegende, langgezogene Boegen
		g.lineCap = "round";
		for (k = 0; k < 4; k++) {
			var mx = wurf() * N, my = 80 + wurf() * (N - 160), breite = 220 + wurf() * 260;
			for (var j = 0; j < 9; j++) {
				var hoehe = 6 + j * (7 + wurf() * 6);
				g.beginPath();
				for (var x = -40; x <= N + 40; x += 6) {
					var u = (x - mx) / breite;
					var y = my + (u * u) * hoehe * 3 - hoehe + Math.sin(x * 0.05 + j) * 1.2;
					x === -40 ? g.moveTo(x, y) : g.lineTo(x, y);
				}
				g.strokeStyle = "rgba(105,66,30," + (0.18 + wurf() * 0.22) + ")";
				g.lineWidth = 1.2 + wurf() * 2.4;
				g.stroke();
			}
		}

		// Feine gerade Maserung, sehr zurueckhaltend
		for (k = 0; k < 260; k++) {
			var y0 = wurf() * N, amp = 0.4 + wurf() * 1.6, per = 90 + wurf() * 260;
			g.beginPath();
			for (x = 0; x <= N; x += 8) {
				var yy = y0 + Math.sin(x / per + k) * amp;
				x === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
			}
			var dunkel = wurf() < 0.6;
			g.strokeStyle = dunkel ? "rgba(110,70,35," + (0.05 + wurf() * 0.10) + ")"
								   : "rgba(250,228,190," + (0.05 + wurf() * 0.10) + ")";
			g.lineWidth = 0.5 + wurf() * 1.2;
			g.stroke();
		}
		return cv;
	}

	global.teileKunst = teileKunst;
	global.slingPlatte = slingPlatte;
	global.holzKunst = holzKunst;
	global.schrankKunst = schrankKunst;
	global.SCHRANK_FELD = SCHRANK_FELD;
	global.TEILE_FELD = TEILE_FELD;
	global.SPIELFELD_FARBEN = FARBE;
	global.Spielfeld = Spielfeld;
})(typeof window !== "undefined" ? window : globalThis);
