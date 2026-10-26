/*
 * ISS Tracker - Labels: Beschriftungen als DOM-Elemente ueber dem Canvas
 *
 * Je Bild (aktualisiere):
 *   1. Anker projizieren - Welt-Punkte (Erdradien) ueber viewProj der Welt-
 *      Ebene, Richtungen (unendlich fern) ueber proj * viewRot der Himmel-Ebene
 *      auf Radius 2 wie im Himmel-Shader. Kamerarelativ (Task 12c): liegen
 *      viewProjRel und kameraPos vor, wird (p - kameraPos) in double gebildet
 *      und mit viewProjRel (Kamera im Ursprung) projiziert - die float32-
 *      Verschiebung der absoluten viewProj rundet bei 1 R auf ~0,4 m, das ISS-
 *      Label sprang unter 0,2 km Abstand bis 5 px. Liegt der Punkt hinter der Kamera
 *      (clip.w <= 0) oder verdeckt die Erdkugel (Radius 1) die Strecke
 *      Kamera -> Punkt bzw. den Strahl in die Richtung, entfaellt das Label
 *      (Spec 5.7; Grund in 'entfallen': "hinten" bzw. "erde").
 *   2. Platzieren: rechts neben den Anker (radiusPx frei lassen), mit
 *      oben: true ueber das Objekt. Kein Platz rechts -> links vom Anker.
 *      Anker vor der Kamera, aber ausserhalb des Bildes oder unter einem
 *      Bedienfeld -> radial vom Bildmittelpunkt an den Rand geklemmt (12 px
 *      Abstand, halbtransparent). Alle Labels weichen Sperrflaechen
 *      (Bedienfeldern) und den Bildkreisen der Objekte aus (radiusPx, z. B.
 *      das Stationsmodell im Folgen-Modus). Ein Kreis ueber der halben
 *      Bilddiagonale ist kein Hindernis; sein Label steht oben mittig (Task 19).
 *   3. Entzerren nach Prioritaet (1 hoechste): ein Label, das ein schon
 *      gesetztes ueberlappt, rutscht um eine Stufe (Labelhoehe + 4 px) nach
 *      unten (in ein Bedienfeld/einen Objektkreis/unter den Rand: nach oben);
 *      drei Stufen (Ankerhoehe und zwei Versaetze) - passt keine, wird es
 *      ausgeblendet und als Kollision gezaehlt.
 *   4. DOM schreiben - nur, was sich geaendert hat. Je Label ein div.label
 *      (data-id), einmal angelegt und wiederverwendet; Text als innerHTML
 *      (Name fett, Werte getrennt), Lage per transform, Ein-/Ausblenden ueber
 *      die Klasse "an" (CSS-Uebergang 200 ms). Ausgeblendete Labels verlassen
 *      nach 250 ms das DOM (document.querySelectorAll('.label') zaehlt dann
 *      nur, was man sieht) und kommen bei Bedarf als dasselbe Element zurueck.
 *      Fuehrungslinie als <line> im SVG, wenn das Label vom Anker abgerueckt ist.
 *
 * Koordinaten: CSS-Pixel ab links oben, y nach unten. Reversed-Z: "vorne"
 * folgt aus clip.w > 0, nicht aus z.
 *
 * Reine Funktionen (ohne DOM, im Node-Test): projiziere, verdeckt,
 * richtungVerdeckt, strahl, entzerre. Nichts hier fasst auf oberster Ebene
 * document oder navigator an; neu() holt window.document erst beim Aufruf.
 */
(function (window) {
	"use strict";

	var RAND = 12;                 // Randabstand in CSS-Pixeln
	var ABSTAND = 8;               // Luecke Anker(-radius) -> Label
	var LUECKE = 4;                // Stufe = Labelhoehe + 4
	var STUFEN = 3;                // Ebenen je Label: Ankerhoehe und zwei Versaetze
	var AUS_DOM_MS = 250;          // nach dem 200-ms-Uebergang aus dem DOM
	var HOEHE_ERSATZ = 16;         // Labelhoehe, bevor eines gemessen ist
	var BREITE_ERSATZ = 100;       // entzerre: Eintrag ohne breite (sonst ueberlappte er nie)
	var KREIS_MIN = 4;             // kleinster frei gehaltener Objektkreis (auch ohne radiusPx)
	var ZIEHEN_AB_PX = 10;         // Weg (|dx|+|dy|), ab dem ein Ziehen auf einem Label an die Kamera geht (kamera.js: Tipp < 10 px)
	var GLEICH_PX = 1;             // ausweichen: Kandidaten, deren Abstand sich um weniger unterscheidet, gelten als gleich weit (Task 12c)
	var SVG_NS = "http://www.w3.org/2000/svg";

	// ---------------------------------------------------------- Helfer
	function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
	function endlich3(v) { return !!v && v.length >= 3 && isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2]); }
	function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
	// 4x4 spaltenweise wie GPU.mat4.mul: a * b (erst b, dann a)
	function mul4(a, b) {
		var r = new Array(16);
		for (var c = 0; c < 4; c++) {
			for (var z = 0; z < 4; z++) {
				r[c * 4 + z] = a[z] * b[c * 4] + a[4 + z] * b[c * 4 + 1] + a[8 + z] * b[c * 4 + 2] + a[12 + z] * b[c * 4 + 3];
			}
		}
		return r;
	}
	function ueberlappt(ax, ay, ab, ah, bx, by, bb, bh) {
		return ax < bx + bb && bx < ax + ab && ay < by + bh && by < ay + ah;
	}
	function zeitJetzt() {
		var p = window.performance;
		return p && typeof p.now === "function" ? p.now() : Date.now();
	}
	function html(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
	// "Name · Werte" -> Name fett, Rest in einem eigenen span (Monospace per CSS)
	function textHtml(text) {
		var i = text.indexOf(" · ");
		if (i < 0) return "<b>" + html(text) + "</b>";
		return "<b>" + html(text.slice(0, i)) + "</b><span class=\"w\">" + html(text.slice(i)) + "</span>";
	}

	// ---------------------------------------------------------- Projektion
	// Punkt (3 Werte, w = 1) -> Pixel ab links oben, y nach unten.
	// Hinter der Kamera (clip.w <= 0) traegt clip.xy die Richtung vom Bild-
	// mittelpunkt; die Division durch ein negatives w wuerde sie spiegeln. Dann
	// liegt {x, y} weit ausserhalb des Bildes in dieser Richtung, vorne = false.
	function projiziere(viewProj, punkt, breite, hoehe) {
		var m = viewProj, x = punkt[0], y = punkt[1], z = punkt[2];
		var cx = m[0] * x + m[4] * y + m[8] * z + m[12];
		var cy = m[1] * x + m[5] * y + m[9] * z + m[13];
		var cw = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (cw > 1e-12) return { x: (cx / cw * 0.5 + 0.5) * breite, y: (0.5 - cy / cw * 0.5) * hoehe, vorne: true };
		var dx = cx * breite / 2, dy = -cy * hoehe / 2, l = Math.hypot(dx, dy);
		if (!(l > 1e-12)) { dx = 0; dy = 1; l = 1; }                 // genau hinter der Kamera: nach unten
		var weit = breite + hoehe;
		return { x: breite / 2 + dx / l * weit, y: hoehe / 2 + dy / l * weit, vorne: false };
	}

	// Strecke Kamera -> Punkt gegen die Erdkugel (Radius 1): verdeckt, wenn der
	// dem Erdmittelpunkt naechste Punkt der Strecke innerhalb der Kugel liegt.
	function verdeckt(kameraPos, punkt) {
		if (!endlich3(kameraPos) || !endlich3(punkt)) return false;
		var a = kameraPos;
		if (dot(a, a) <= 1) return true;                             // Kamera in der Erde
		var d = [punkt[0] - a[0], punkt[1] - a[1], punkt[2] - a[2]], l2 = dot(d, d);
		if (l2 < 1e-24) return false;
		var t = clamp(-dot(a, d) / l2, 0, 1);
		var q = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
		return dot(q, q) < 1;
	}
	// Strahl ab der Kamera in eine Richtung (muss nicht normiert sein).
	function richtungVerdeckt(kameraPos, richtung) {
		if (!endlich3(kameraPos) || !endlich3(richtung)) return false;
		var a = kameraPos, d = richtung;
		if (dot(a, a) <= 1) return true;
		var l2 = dot(d, d);
		if (l2 < 1e-24) return false;
		var t = -dot(a, d) / l2;
		if (t <= 0) return false;                                    // Erde liegt hinter dem Strahl
		var q = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
		return dot(q, q) < 1;
	}
	// Weltrichtung (normiert) durch das Bildpixel (x, y) - fuer den Doppeltipp.
	// View-Matrix zeilenweise: rechts, oben, -vorn; proj[0] = f/aspekt, proj[5] = f.
	function strahl(view, proj, x, y, breite, hoehe) {
		var vx = (2 * x / breite - 1) / proj[0], vy = (1 - 2 * y / hoehe) / proj[5];
		var d = [view[0] * vx + view[1] * vy - view[2], view[4] * vx + view[5] * vy - view[6], view[8] * vx + view[9] * vy - view[10]];
		var l = Math.hypot(d[0], d[1], d[2]);
		return l > 1e-12 ? [d[0] / l, d[1] / l, d[2] / l] : null;
	}

	// ---------------------------------------------------------- Entzerrung
	// liste: Eintraege mit x, y (linke obere Ecke), breite (Pflicht; fehlt sie,
	// gilt BREITE_ERSATZ - mit 0 ueberlappte der Eintrag nie), prioritaet. Nach
	// Prioritaet (stabil: bei Gleichstand die Listenreihenfolge) setzen; wer ein
	// schon gesetztes Label ueberlappt, rutscht um Stufen zu hoeheLabel + 4 nach
	// unten - drei Stufen: 0, 1 oder 2 Versaetze. Passt keine Stufe: sichtbar =
	// false, als Kollision gezaehlt. Setzt y, versatz, sichtbar. Eintraege ohne
	// endliches y oder mit sichtbar === false bleiben unberuehrt.
	// grenzen (optional): { unten, oben, hindernisse: [{x, y, breite, hoehe}],
	// kreise: [{x, y, r}] } - laege die verschobene Oberkante unter 'unten', in
	// einem Hindernis (Bedienfeld) oder in einem Objektkreis (Bild des Modells,
	// Marker, Planetenpunkt), weicht das Label um dieselbe Stufe nach oben aus
	// (nicht ueber 'oben'). Die Ausgangslage (Stufe 0) hat platziere() schon frei
	// von Bedienfeldern gewaehlt; liegt sie in einem Objektkreis, gilt sie als belegt.
	function breiteVon(e) { return isFinite(e.breite) && e.breite > 0 ? +e.breite : BREITE_ERSATZ; }
	function entzerre(liste, hoeheLabel, grenzen) {
		var g0 = grenzen || {};
		var stufe = hoeheLabel + LUECKE, grenze = isFinite(g0.unten) ? g0.unten : Infinity;
		var obenGrenze = isFinite(g0.oben) ? g0.oben : -Infinity, hin = g0.hindernisse || null, kreise = g0.kreise || null;
		function blockiert(x, y, b) { return !boxFrei(x, y, b, hoeheLabel, hin) || kreisTrifft(x, y, b, hoeheLabel, kreise); }
		var reihe = [];
		for (var i = 0; i < liste.length; i++) {
			var e = liste[i];
			if (!e || !isFinite(e.y) || e.sichtbar === false) continue;
			reihe.push({ e: e, i: i, p: isFinite(e.prioritaet) ? +e.prioritaet : 99 });
		}
		reihe.sort(function (a, b) { return (a.p - b.p) || (a.i - b.i); });
		var gesetzt = [], kollisionen = 0;
		for (var j = 0; j < reihe.length; j++) {
			var ein = reihe[j].e, y0 = ein.y, b = breiteVon(ein), ok = false;
			for (var k = 0; k < STUFEN && !ok; k++) {
				var y = y0 + k * stufe;
				if (k === 0) {
					if (kreisTrifft(ein.x, y, b, hoeheLabel, kreise)) continue;
				} else if (y > grenze || blockiert(ein.x, y, b)) {
					y = y0 - k * stufe;
					if (y < obenGrenze || blockiert(ein.x, y, b)) continue;
				}
				var frei = true;
				for (var n = 0; n < gesetzt.length && frei; n++) {
					var g = gesetzt[n];
					if (ueberlappt(ein.x, y, b, hoeheLabel, g.x, g.y, breiteVon(g), hoeheLabel)) frei = false;
				}
				if (frei) { ein.y = y; ein.versatz = y - y0; ok = true; }
			}
			if (ok) { ein.sichtbar = true; gesetzt.push(ein); }
			else { ein.sichtbar = false; ein.versatz = 0; kollisionen++; }
		}
		return kollisionen;
	}

	// ---------------------------------------------------------- Platzierung
	// Box (x, y, bw, h) gegen Objektkreise [{x, y, r}]: naechster Punkt der Box
	// zum Kreismittelpunkt naeher als r.
	function kreisTrifft(x, y, bw, h, kreise) {
		if (!kreise) return false;
		for (var i = 0; i < kreise.length; i++) {
			var k = kreise[i];
			if (!k) continue;
			var nx = clamp(k.x, x, x + bw), ny = clamp(k.y, y, y + h);
			if ((nx - k.x) * (nx - k.x) + (ny - k.y) * (ny - k.y) < k.r * k.r) return true;
		}
		return false;
	}
	// Label aus Sperrflaechen (Bedienfeldern) und Objektkreisen schieben. Zuerst
	// die bevorzugten Lagen (z. B. die andere Seite des Ankers), sonst je
	// getroffenem Hindernis vier Kandidaten (links, rechts, darueber, darunter,
	// ins Bild geklemmt) - der naechste freie gewinnt. Nichts frei: Lage bleibt
	// (entzerre verschiebt oder blendet dann aus).
	function ausweichen(x, y, bw, h, breite, hoehe, sperren, kreise, bevorzugt) {
		var maxX = Math.max(RAND, breite - RAND - bw), maxY = Math.max(RAND, hoehe - RAND - h);
		function frei(a, b) { return boxFrei(a, b, bw, h, sperren) && !kreisTrifft(a, b, bw, h, kreise); }
		if (frei(x, y)) return [x, y];
		var i, k, kand = [];
		if (bevorzugt) {
			for (i = 0; i < bevorzugt.length; i++) {
				var bx = clamp(bevorzugt[i][0], RAND, maxX), by = clamp(bevorzugt[i][1], RAND, maxY);
				if (frei(bx, by)) return [bx, by];
			}
		}
		for (i = 0; sperren && i < sperren.length; i++) {
			var s = sperren[i];
			if (!s || !ueberlappt(x, y, bw, h, s.x, s.y, s.breite, s.hoehe)) continue;
			kand.push([s.x - bw - LUECKE, y], [s.x + s.breite + LUECKE, y], [x, s.y - h - LUECKE], [x, s.y + s.hoehe + LUECKE]);
		}
		for (i = 0; kreise && i < kreise.length; i++) {
			var o = kreise[i];
			if (!o || !kreisTrifft(x, y, bw, h, [o])) continue;
			kand.push([o.x - o.r - LUECKE - bw, y], [o.x + o.r + LUECKE, y], [x, o.y - o.r - LUECKE - h], [x, o.y + o.r + LUECKE]);
		}
		// Gleich weite Kandidaten (Unterschied unter GLEICH_PX): der erste gewinnt.
		// Befund Task 12c: im Folgen-Modus unter 0,15 km steht das Label mittig
		// ueber dem Modell, links und rechts sind exakt gleich weit - float-Rauschen
		// entschied je Bild neu, das ISS-Label sprang zwischen x 12 und x 990.
		var best = null, bestD = Infinity;
		for (k = 0; k < kand.length; k++) {
			var kx = clamp(kand[k][0], RAND, maxX), ky = clamp(kand[k][1], RAND, maxY);
			if (!frei(kx, ky)) continue;
			var d = Math.hypot(kx - x, ky - y);
			if (d < bestD - GLEICH_PX) { bestD = d; best = [kx, ky]; }
		}
		return best || [x, y];
	}
	function unterSperre(x, y, sperren) {
		if (!sperren) return false;
		for (var i = 0; i < sperren.length; i++) {
			var s = sperren[i];
			if (s && x >= s.x && x <= s.x + s.breite && y >= s.y && y <= s.y + s.hoehe) return true;
		}
		return false;
	}
	function boxFrei(x, y, bw, h, sperren) {
		if (!sperren) return true;
		for (var i = 0; i < sperren.length; i++) {
			var s = sperren[i];
			if (s && ueberlappt(x, y, bw, h, s.x, s.y, s.breite, s.hoehe)) return false;
		}
		return true;
	}
	function imBild(p, breite, hoehe, sperren) {
		return p.vorne && p.x >= 0 && p.x <= breite && p.y >= 0 && p.y <= hoehe && !unterSperre(p.x, p.y, sperren);
	}
	// Linke obere Ecke der Labelbox (bw x h) zum projizierten Anker p (vor der
	// Kamera; aktualisiere laesst Punkte hinter der Kamera gar nicht erst herein).
	// Ein Anker unter einem Bedienfeld gilt als ausserhalb (das Objekt ist verdeckt
	// wie am Bildrand). kreise: Bildkreise aller Objekte im Bild (auch des eigenen)
	// - kein Label legt sich auf ein Objekt, auch nicht auf das Stationsmodell.
	// riesig (Task 19, I1): der Objektkreis ist groesser als die halbe Bilddiagonale
	// (Stationsmodell in der Nahaufnahme fuellt das Bild) - das Label steht dann
	// oben mittig im Bild, ueber dem Modell; sein Kreis ist fuer kein Label ein
	// Hindernis (aktualisiere laesst ihn aus 'kreise' weg).
	function platziere(p, bw, h, breite, hoehe, r, oben, sperren, kreise, riesig) {
		var maxX = Math.max(RAND, breite - RAND - bw), maxY = Math.max(RAND, hoehe - RAND - h);
		var x, y, q;
		if (riesig && imBild(p, breite, hoehe, sperren)) {
			q = ausweichen(clamp(p.x - bw / 2, RAND, maxX), RAND, bw, h, breite, hoehe, sperren, kreise, null);
			return { x: q[0], y: q[1], rand: false };
		}
		if (imBild(p, breite, hoehe, sperren)) {
			var rechts = oben ? p.x + ABSTAND : p.x + r + ABSTAND;
			var links = oben ? p.x - ABSTAND - bw : p.x - r - ABSTAND - bw;
			x = rechts + bw > breite - RAND ? links : rechts;                        // rechts kein Platz
			y = oben ? p.y - r - LUECKE - h : p.y - h / 2;
			if (oben && y < RAND) y = p.y + r + LUECKE;                                  // oben kein Platz
			x = clamp(x, RAND, maxX); y = clamp(y, RAND, maxY);
			// Weder rechts noch links Platz (schmales Bild, langes Label): die geklemmte
			// Box laege auf dem Objekt -> mittig darueber (oben kein Platz: darunter).
			if (ueberlappt(x, y, bw, h, p.x - r - 2, p.y - r - 2, 2 * r + 4, 2 * r + 4)) {
				x = clamp(p.x - bw / 2, RAND, maxX);
				y = p.y - r - LUECKE - h;
				if (y < RAND) y = p.y + r + LUECKE;
				y = clamp(y, RAND, maxY);
			}
			// Unter einem Bedienfeld oder auf einem Objekt: erst die andere Seite des Ankers
			q = ausweichen(x, y, bw, h, breite, hoehe, sperren, kreise, [[x > p.x ? links : rechts, y]]);
			return { x: q[0], y: q[1], rand: false };
		}
		// Vor der Kamera ausserhalb des Bildes (oder unter einem Bedienfeld): Box-Mitte
		// radial vom Bildmittelpunkt auf das um Randabstand und halbe Box verkleinerte
		// Rechteck.
		var cx = breite / 2, cy = hoehe / 2, dx = p.x - cx, dy = p.y - cy;
		if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) dy = 1;
		var hx = Math.max(0, cx - RAND - bw / 2), hy = Math.max(0, cy - RAND - h / 2);
		var s = Math.min(Math.abs(dx) > 1e-9 ? hx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hy / Math.abs(dy) : Infinity);
		x = clamp(cx + dx * s - bw / 2, RAND, maxX);
		y = clamp(cy + dy * s - h / 2, RAND, maxY);
		q = ausweichen(x, y, bw, h, breite, hoehe, sperren, kreise, null);
		return { x: q[0], y: q[1], rand: true };
	}

	// ---------------------------------------------------------- DOM
	// container: #labels (div), svg: #linien (optional). Eintraege fuer setze:
	// { id, text, position ([x,y,z] in R) | richtung ([x,y,z]), prioritaet (1 hoechste),
	//   klick (function), radiusPx (optional: Bildradius des Objekts, frei halten),
	//   oben (optional: Label ueber das Objekt statt daneben) }.
	// aktualisiere({ viewProj, viewProjRel (optional, Task 12c: Projektion mit der
	//   Kamera im Ursprung; mit kameraPos werden Positionen kamerarelativ projiziert),
	//   viewRot, proj, kameraPos, breite, hoehe (CSS-Pixel),
	//   sperren (optional: [{x, y, breite, hoehe}]), zeitMs (optional) })
	//   -> { sichtbar, kollisionen, liste: [{id, x, y, breite, hoehe, rand, versatz}],
	//        entfallen: [{id, grund: "hinten" | "erde" | "ungueltig"}] }
	// optionen (optional, Task 12c): { zeigerZiel: Element (Canvas) } - ein Ziehen,
	//   das auf einem Label beginnt, wird dorthin weitergereicht (Kameradrehung).
	// Bedienung (Task 12c): sichtbare Labels sind role="button" mit tabindex 0
	// (ausgeblendete -1); Enter/Leertaste loest klick() aus wie ein Mausklick.
	function neu(container, svg, optionen) {
		var doc = window.document;
		var zeigerZiel = optionen && optionen.zeigerZiel && typeof optionen.zeigerZiel.dispatchEvent === "function" ? optionen.zeigerZiel : null;
		var eintraege = [];
		var zustaende = new Map();                  // id -> Zustand je Label
		var hoeheLabel = 0, groesseAlt = "", neuMessen = true, bildNr = 0;
		var rel = [0, 0, 0];                         // Punkt relativ zur Kamera (double), je Eintrag ueberschrieben

		// Webschrift nachgeladen -> Breiten neu messen
		if (doc && doc.fonts) {
			if (doc.fonts.ready && typeof doc.fonts.ready.then === "function") doc.fonts.ready.then(function () { neuMessen = true; });
			if (typeof doc.fonts.addEventListener === "function") doc.fonts.addEventListener("loadingdone", function () { neuMessen = true; });
		}

		function zustand(id) {
			var z = zustaende.get(id);
			if (z) return z;
			var el = doc.createElement("div");
			el.className = "label";
			el.setAttribute("data-id", id);
			el.setAttribute("role", "button");
			el.setAttribute("tabindex", "-1");                   // 0, sobald sichtbar (setzeKlasse)
			z = { id: id, el: el, linie: null, text: null, laenge: -1, breite: 0, messen: true, eintrag: null,
			      imDom: false, an: false, klasse: "label", tf: "", ausAb: -Infinity, gesehen: -1, linieAn: false, linieWerte: "" };
			el.addEventListener("click", function (ev) {
				var e = z.eintrag;
				if (!z.an || !e || typeof e.klick !== "function") return;
				if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
				e.klick();
			});
			// Tastatur: Enter/Leertaste wie ein Klick. stopPropagation, sonst schaltete
			// die Leertaste zusaetzlich die Pause um (kamera.js hoert am Fenster).
			el.addEventListener("keydown", function (ev) {
				if (!ev || (ev.key !== "Enter" && ev.key !== " ")) return;
				var e = z.eintrag;
				if (!z.an || !e || typeof e.klick !== "function") return;
				if (typeof ev.preventDefault === "function") ev.preventDefault();
				if (typeof ev.stopPropagation === "function") ev.stopPropagation();
				e.klick();
			});
			if (zeigerZiel) el.addEventListener("pointerdown", durchreichen);
			if (svg) {
				z.linie = doc.createElementNS(SVG_NS, "line");
				z.linie.setAttribute("visibility", "hidden");
				svg.appendChild(z.linie);
			}
			zustaende.set(id, z);
			return z;
		}
		// Klasse und Tabulatorreihenfolge: nur sichtbare Labels ("an") sind erreichbar
		function setzeKlasse(z, k) {
			if (z.klasse === k) return;
			var warAn = z.klasse !== "label", istAn = k !== "label";
			z.klasse = k; z.el.className = k;
			if (warAn !== istAn) z.el.setAttribute("tabindex", istAn ? "0" : "-1");
		}
		// Ziehen ab einem Label (Task 12c): das Label nimmt pointerdown an (Klickziel),
		// die Kamera hoert nur am Canvas. Erst ab ZIEHEN_AB_PX Weg - dieselbe Grenze,
		// unter der kamera.js einen Tipp erkennt - geht ein pointerdown am Ort des
		// Aufsetzens an zeigerZiel (kamera.js bindet dort den Zeiger), danach jede
		// Bewegung, die nicht schon am Ziel ankommt. Darunter bleibt es ein Klick.
		function durchreichen(ev) {
			if (ev.pointerType === "mouse" && ev.button !== 0) return;
			var id = ev.pointerId, x0 = ev.clientX, y0 = ev.clientY, weiter = false;
			function senden(typ, q, x, y) {
				var E = window.PointerEvent;
				if (typeof E !== "function") return;
				zeigerZiel.dispatchEvent(new E(typ, { bubbles: true, cancelable: true, pointerId: q.pointerId, pointerType: q.pointerType,
					isPrimary: q.isPrimary, button: q.button, buttons: q.buttons, clientX: x, clientY: y }));
			}
			function bewegt(m) {
				if (m.pointerId !== id) return;
				if (!weiter) {
					if (Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < ZIEHEN_AB_PX) return;
					weiter = true;
					senden("pointerdown", ev, x0, y0);
				}
				if (m.target !== zeigerZiel) senden("pointermove", m, m.clientX, m.clientY);
			}
			function los(u) {
				if (u.pointerId !== id) return;
				window.removeEventListener("pointermove", bewegt, true);
				window.removeEventListener("pointerup", los, true);
				window.removeEventListener("pointercancel", los, true);
				if (weiter && u.target !== zeigerZiel) senden(u.type, u, u.clientX, u.clientY);
			}
			window.addEventListener("pointermove", bewegt, true);
			window.addEventListener("pointerup", los, true);
			window.addEventListener("pointercancel", los, true);
		}
		function linieZeigen(z, an, x1, y1, x2, y2) {
			if (!z.linie) return;
			if (an) {
				var w = [x1, y1, x2, y2].map(function (v) { return Math.round(v * 2) / 2; });
				var s = w.join(",");
				if (s !== z.linieWerte) {
					z.linieWerte = s;
					z.linie.setAttribute("x1", w[0]); z.linie.setAttribute("y1", w[1]);
					z.linie.setAttribute("x2", w[2]); z.linie.setAttribute("y2", w[3]);
				}
			}
			if (an !== z.linieAn) { z.linieAn = an; z.linie.setAttribute("visibility", an ? "visible" : "hidden"); }
		}
		function ausblenden(z, jetzt) {
			if (z.an) { z.an = false; z.ausAb = jetzt; setzeKlasse(z, "label"); }
			linieZeigen(z, false);
		}

		function setze(liste) { eintraege = Array.isArray(liste) ? liste : []; }

		function aktualisiere(o) {
			var jetzt = isFinite(o.zeitMs) ? +o.zeitMs : zeitJetzt();
			var W = o.breite, H = o.hoehe, kp = o.kameraPos;
			var erg = { sichtbar: 0, kollisionen: 0, liste: [], entfallen: [] };
			bildNr++;
			var groesse = W + "x" + H;
			if (groesse !== groesseAlt) { groesseAlt = groesse; neuMessen = true; }
			var himmelVP = o.viewRot && o.proj ? mul4(o.proj, o.viewRot) : null;
			// Task 12c: Positionen kamerarelativ (double) ueber viewProjRel, sonst absolut
			var relativ = !!o.viewProjRel && endlich3(kp);
			var arbeit = [], i, k, z;

			// 1. Anker, Verdeckung; Text und Einhaengen (nur Schreibzugriffe)
			if (W > 0 && H > 0) {
				for (i = 0; i < eintraege.length; i++) {
					var e = eintraege[i];
					if (!e || e.id === undefined || e.id === null) continue;
					var p = null, grund = null;
					if (e.position) {
						if ((o.viewProj || relativ) && endlich3(e.position)) {
							var q = e.position;
							if (verdeckt(kp, q)) grund = "erde";
							else if (relativ) {
								rel[0] = q[0] - kp[0]; rel[1] = q[1] - kp[1]; rel[2] = q[2] - kp[2];
								p = projiziere(o.viewProjRel, rel, W, H);
							}
							else p = projiziere(o.viewProj, q, W, H);
						}
					} else if (e.richtung && himmelVP) {
						var d = e.richtung;
						if (endlich3(d)) {
							if (richtungVerdeckt(kp, d)) grund = "erde";
							else p = projiziere(himmelVP, [d[0] * 2, d[1] * 2, d[2] * 2], W, H);
						}
					}
					// Hinter der Kamera (Positionen und Richtungen): ausblenden, kein Randlabel (Spec 5.7)
					if (p && !p.vorne) { p = null; grund = "hinten"; }
					if (!p) { erg.entfallen.push({ id: String(e.id), grund: grund || "ungueltig" }); continue; }
					z = zustand(String(e.id));
					if (z.gesehen === bildNr) continue;                  // doppelte id: der erste gilt
					z.gesehen = bildNr;
					z.eintrag = e;
					var text = String(e.text === undefined || e.text === null ? "" : e.text);
					if (text !== z.text) {
						z.el.innerHTML = textHtml(text);
						if (text.length !== z.laenge) z.messen = true;       // Werte in Monospace: Breite haengt an der Laenge
						z.text = text; z.laenge = text.length;
					}
					if (!z.imDom) { container.appendChild(z.el); z.imDom = true; z.messen = true; }
					arbeit.push({ z: z, id: z.id, p: p, prioritaet: e.prioritaet, r: isFinite(e.radiusPx) && e.radiusPx > 0 ? +e.radiusPx : 0, oben: !!e.oben });
				}
			}

			// 2. Messen (eine Leseposition je Bild, nur bei neuen/geaenderten Labels)
			for (i = 0; i < arbeit.length; i++) {
				z = arbeit[i].z;
				if (neuMessen || z.messen) {
					z.breite = z.el.offsetWidth || 0;
					z.messen = false;
					if (neuMessen || !hoeheLabel) hoeheLabel = z.el.offsetHeight || 0;
				}
			}
			if (arbeit.length) neuMessen = false;
			var h = hoeheLabel || HOEHE_ERSATZ;

			// 3. Platzieren und entzerren. Die Bildkreise aller Objekte im Bild (Marker,
			// Stationsmodell mit seinem Bildradius, Mond, Sonne, Planetenpunkte) sind
			// Hindernisse fuer jedes Label, damit keines auf einem Objekt liegt.
			// Task 19 (I1): ein Kreis ueber der halben Bilddiagonale deckt das ganze
			// Bild - als Hindernis blockierte er jede Lage, und in der Nahaufnahme
			// (Folgen < 0,12 km) verschwanden alle Labels. Er zaehlt nicht mehr.
			var kreise = [], diagHalb = Math.hypot(W, H) / 2;
			for (i = 0; i < arbeit.length; i++) {
				k = arbeit[i];
				k.riesig = k.r > diagHalb;
				if (!k.riesig && imBild(k.p, W, H, o.sperren)) kreise.push({ x: k.p.x, y: k.p.y, r: Math.max(k.r, KREIS_MIN) });
			}
			for (i = 0; i < arbeit.length; i++) {
				k = arbeit[i];
				var pl = platziere(k.p, k.z.breite, h, W, H, k.r, k.oben, o.sperren, kreise, k.riesig);
				k.x = pl.x; k.y = pl.y; k.rand = pl.rand; k.breite = k.z.breite; k.versatz = 0;
			}
			erg.kollisionen = entzerre(arbeit, h, { oben: RAND, unten: H - RAND - h, hindernisse: o.sperren, kreise: kreise });

			// 4. DOM schreiben
			for (i = 0; i < arbeit.length; i++) {
				k = arbeit[i]; z = k.z;
				if (!k.sichtbar) { ausblenden(z, jetzt); continue; }
				var tf = "translate(" + Math.round(k.x) + "px, " + Math.round(k.y) + "px)";
				if (tf !== z.tf) { z.tf = tf; z.el.style.transform = tf; }
				setzeKlasse(z, k.rand ? "label an rand" : "label an");
				z.an = true;
				z.sichtbarBild = bildNr;
				// Fuehrungslinie: vom Rand des Objekts zum naechsten Punkt der Box, wenn
				// das Label entzerrt oder weiter als ueblich vom Anker abgerueckt ist.
				var zeigen = false;
				if (!k.rand) {
					var nx = clamp(k.p.x, k.x, k.x + k.breite), ny = clamp(k.p.y, k.y, k.y + h);
					var dx = nx - k.p.x, dy = ny - k.p.y, dl = Math.hypot(dx, dy);
					if ((k.versatz !== 0 || dl > k.r + ABSTAND + 2) && dl > k.r + 6) {
						zeigen = true;
						linieZeigen(z, true, k.p.x + dx / dl * (k.r + 2), k.p.y + dy / dl * (k.r + 2), nx, ny);
					}
				}
				if (!zeigen) linieZeigen(z, false);
				erg.sichtbar++;
				erg.liste.push({ id: z.id, x: Math.round(k.x), y: Math.round(k.y), breite: k.breite, hoehe: h, rand: k.rand, versatz: k.versatz });
			}

			// 5. Alle anderen ausblenden; nach dem Uebergang aus dem DOM. Wer nur wegen
			// einer Kollision fehlt, bleibt (unsichtbar) drin - sonst haengte er jedes
			// Bild neu ein und wuerde neu gemessen.
			zustaende.forEach(function (zz) {
				if (zz.sichtbarBild === bildNr) return;
				ausblenden(zz, jetzt);
				if (zz.imDom && zz.gesehen !== bildNr && jetzt - zz.ausAb >= AUS_DOM_MS) {
					if (zz.el.parentNode) zz.el.parentNode.removeChild(zz.el);
					zz.imDom = false;
				}
			});
			return erg;
		}

		return { setze: setze, aktualisiere: aktualisiere };
	}

	window.Labels = {
		neu: neu,
		projiziere: projiziere,
		verdeckt: verdeckt,
		richtungVerdeckt: richtungVerdeckt,
		strahl: strahl,
		entzerre: entzerre,
		RAND: RAND
	};
})(window);
