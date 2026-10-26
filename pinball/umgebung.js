/*
 * FRIDAYVFX Pinball - Umgebung
 *
 * Laedt die Wuerfelkarten aus umgebung/. Sie stammen aus einem echten HDRI:
 * "Colorful Studio" von Poly Haven (CC0, Nachweis in tmp/pinball/LIZENZ.txt),
 * ein dunkler Loungeraum mit wenigen Deckenlampen und einer Lichterkette an
 * der Bar (Look Stufe 1, Task 3/4; vorher GSG Pro Studios Metal 007). Gebaut
 * von tmp/baue_umgebung.js mit `--env-soll 0.13 --klemme 60 --saettigung
 * 0.65`, Drehung 150 Grad, Kuppel-Soll 0.35 - dort steht auch, wie man sie
 * aus einer neuen Quelle neu baut (die Drehung muss zur Nahtpruefung in
 * tests/umgebung_test.js passen, bei kleinen hellen Lampen bestehen nur
 * wenige Winkel).
 *
 * Zwei Saetze:
 *   env_*.png     256 px je Seite, fuer die Spiegelungen auf dem Chrom
 *   kuppel_*.png   16 px je Seite, die vorberechnete Bestrahlung fuers
 *                  Kuppellicht
 *
 * Die beiden Saetze sind bewusst ENTKOPPELT, ihre Normierungen haengen nicht
 * aneinander (Task 4: Faktor 3.19, env 1.2527 zu kuppel 0.3933; seit Task 3
 * env 0.6912): die Spiegelkarte soll Waende zeigen und die Lampen deckeln
 * (Mittel 0.13, hellste Stelle 60, Saettigung 0.65), das Kuppellicht die
 * volle Lampenenergie tragen (Mittel 0.35, ohne Deckel). Die Mipmaps der
 * Spiegelkarte erzeugt pinball-gpu.js LINEAR (fsBlitHdr: dekodieren, mitteln,
 * kodieren) und nicht im kodierten Raum - sonst brechen die Lampen ab Mip 1
 * ein, und die kleine Kugel im Spiel verliert ihren Glanzpunkt. Der
 * WebGL-Rueckfall (pinball.js) filtert weiter im kodierten Raum.
 *
 * Beide in der Kodierung x = c/(c+1), die der Shader mit c = x/(1-x)
 * zurueckrechnet. Damit passen Leuchtdichten weit ueber 1 in acht Bit - fein
 * aufgeloest im Dunklen, grob in den Lampen. Ohne das waere die hellste Stelle
 * 1,0 und Chrom saehe aus wie grauer Kunststoff.
 *
 * Die Karten dienen nur der Beleuchtung. Der Hintergrund bleibt schwarz.
 */
(function (global) {
	"use strict";

	var NAMEN = ["px", "nx", "py", "ny", "pz", "nz"];

	// Notbehelf, falls eine Datei fehlt: ein neutrales Grau. Lieber eine flaue
	// Beleuchtung als eine schwarze Seite.
	function ersatzSeite(wert) {
		var cv = document.createElement("canvas");
		cv.width = cv.height = 4;
		var g = cv.getContext("2d");
		g.fillStyle = wert;
		g.fillRect(0, 0, 4, 4);
		return cv;
	}

	function ladeUmgebung(opt, fertig) {
		opt = opt || {};
		var ordner = opt.ordner || "umgebung/";
		var marke = opt.marke ? "?v=" + opt.marke : "";
		var seiten = new Array(6), kuppel = new Array(6);
		var offen = 12, fehlend = [];

		function fertigWenn() {
			if (--offen > 0) return;
			if (fehlend.length) {
				for (var i = 0; i < 6; i++) {
					if (!seiten[i]) seiten[i] = ersatzSeite("#2a2a2e");
					if (!kuppel[i]) kuppel[i] = ersatzSeite("#39393d");
				}
			}
			fertig({ seiten: seiten, diffus: kuppel, fehlend: fehlend });
		}

		function hole(datei, ziel, index) {
			var bild = new Image();
			bild.onload = function () { ziel[index] = bild; fertigWenn(); };
			bild.onerror = function () { fehlend.push(datei); fertigWenn(); };
			bild.src = ordner + datei + marke;
		}

		NAMEN.forEach(function (n, i) {
			hole("env_" + n + ".png", seiten, i);
			hole("kuppel_" + n + ".png", kuppel, i);
		});
	}

	global.ladeUmgebung = ladeUmgebung;
	global.UMGEBUNG_NAMEN = NAMEN;
})(typeof window !== "undefined" ? window : globalThis);
