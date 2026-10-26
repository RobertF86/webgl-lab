/*
 * FRIDAYVFX Pinball - Regelwerk
 *
 * Nach dem Vorbild elektromechanischer Bally-Tische der spaeten Siebziger:
 * Punkte gibt es nicht fuers blosse Anstossen, sondern fuer erreichte Ziele.
 * Der Kern ist die Bonusleiter - sie zaehlt waehrend des Balls hoch und wird
 * erst beim Ballverlust ausgezahlt, mal Multiplikator. Dadurch ist ein langer
 * Ball mehr wert als viele kurze, und das Risiko am Abfluss bekommt Gewicht.
 *
 *   Bumper            100, jeder fuenfte Treffer hebt den Bonus
 *   Slingshot          10, nur wenn er feuert (Schwelle, Profil: tisch.js)
 *   Stehziel          500, beide zusammen 2000 und Bonus hoch
 *   Fallziel         1000, komplette Bank 5000 und Multiplikator hoch
 *   Kopfbahn V/F/X    500, alle drei 3000 und Bonus hoch
 *   Rueckgasse        200 und Bonus hoch
 *   Auslaufgasse      500 als Trostpreis
 *   Skill Shot       5000, wenn der erste Treffer nach dem Abschuss eine
 *                          Kopfbahn ist
 *   Bonus         Leiter x 1000 x Multiplikator, beim Ballverlust
 *   Extraball     einmalig ab 75000
 *
 * Das Modul kennt keine Grafik und kein WebGL. Es laesst sich dadurch ohne
 * Browser pruefen, und genau das tut tests/spiel_test.js.
 */
(function (global) {
	"use strict";

	var BONUS_MAX = 8;                          // so viele Einsaetze hat das Feld
	var MULTI_STUFEN = [1, 2, 3, 5];
	var EXTRABALL_AB = 75000;
	var BAELLE = 3;

	function macheSpiel(o) {
		var ziele = o.ziele, rollover = o.rollover;

		var s = {
			zustand: "attract",                 // attract | bereit | spiel | bonus | aus
			punkte: 0, ball: 0, baelle: BAELLE,
			bonus: 0, multiStufe: 0,
			bumperZaehler: 0,
			bahnen: {}, stehziele: {},
			extraballVergeben: false,
			skillBereit: false,
			meldung: "", meldungZeit: 0,
			bonusZaehlt: 0, bonusRest: 0, bonusTakt: 0,
			letzteWertung: 0
		};

		function multi() { return MULTI_STUFEN[s.multiStufe]; }

		function sage(text, dauer) {
			s.meldung = text;
			s.meldungZeit = dauer === undefined ? 2.2 : dauer;
		}

		function werte(n, text) {
			s.punkte += n;
			s.letzteWertung = n;
			if (text) sage(text + "  " + n.toLocaleString("en-US"));
			if (!s.extraballVergeben && s.punkte >= EXTRABALL_AB) {
				s.extraballVergeben = true;
				s.baelle++;
				sage("EXTRA BALL", 3.0);
			}
		}

		function bonusHoch(n) {
			n = n || 1;
			for (var i = 0; i < n; i++) {
				if (s.bonus < BONUS_MAX) s.bonus++;
				else s.punkte += 1000;           // Leiter voll: direkt gutschreiben
			}
		}

		function multiHoch() {
			if (s.multiStufe < MULTI_STUFEN.length - 1) {
				s.multiStufe++;
				sage("BONUS " + multi() + "X", 2.6);
			} else {
				werte(10000);
				sage("SPECIAL  10,000", 2.6);
			}
		}

		// ------------------------------------------------------- Fallziele
		function bankVollstaendig(gruppe) {
			return ziele.every(function (z) { return z.gruppe !== gruppe || z.unten; });
		}
		function bankZuruecksetzen(gruppe) {
			ziele.forEach(function (z) { if (z.gruppe === gruppe) { z.unten = false; z.sinken = 0; } });
		}
		var bankTimer = {};

		// -------------------------------------------------------- Ereignisse
		s.starte = function () {
			s.punkte = 0; s.ball = 1; s.baelle = BAELLE;
			s.multiStufe = 0; s.extraballVergeben = false;
			s.bumperZaehler = 0;
			s.zustand = "bereit";
			neuerBall();
			sage("BALL 1", 2.0);
		};

		function neuerBall() {
			s.bonus = 0;
			s.bahnen = {}; s.stehziele = {};
			bankZuruecksetzen("links"); bankZuruecksetzen("rechts");
			ziele.forEach(function (z) { if (z.gruppe === "steh") z.an = 0; });
			rollover.forEach(function (ro) { ro.drin = false; });
			s.skillBereit = true;
			s.zustand = "spiel";
		}
		s.neuerBall = neuerBall;

		/*
		 * Kollisionsliste: feste Waende plus die noch STEHENDEN Fallziele.
		 * Gefallene muessen verschwinden, sonst prallt die Kugel weiter an
		 * Zielen ab, die im Bild schon im Feld versunken sind.
		 */
		s.segmenteFuer = function (feste) {
			var liste = feste.slice();
			for (var i = 0; i < ziele.length; i++) if (!ziele[i].unten) liste.push(ziele[i].seg);
			return liste;
		};

		/*
		 * Eine Weiche fuer alle Beruehrungen aus der Physik. Gibt `true`
		 * zurueck, wenn sich der Zielbestand geaendert hat und der Aufrufer die
		 * Kollisionsliste neu bauen muss. `gefeuert` kommt aus der Physik
		 * (beiTreffer): hat der Kicker wirklich gestossen?
		 */
		s.beruehrung = function (art, objekt, gefeuert) {
			if (art === "ziel") {
				var z = objekt && objekt.objekt;
				if (!z) return false;
				var vorher = z.unten;
				s.ziel(z);
				return z.unten !== vorher;
			}
			s.treffer(art, objekt, gefeuert);
			return false;
		};

		/*
		 * Rollover werden beim EINTRITT in den Kreis ausgeloest, nicht solange
		 * die Kugel darin liegt - sonst zaehlt eine langsam durchrollende Kugel
		 * hundertfach.
		 */
		s.pruefeRollover = function (px, py) {
			for (var i = 0; i < rollover.length; i++) {
				var ro = rollover[i];
				var drin = Math.hypot(px - ro.x, py - ro.y) < ro.r;
				if (drin && !ro.drin) s.rollover(ro);
				ro.drin = drin;
			}
		};

		// Der Abschuss beendet die Skill-Shot-Bereitschaft nicht - erst der
		// erste Treffer entscheidet, ob es eine Kopfbahn war.
		//
		// Bumper und Slings zaehlen nur, wenn sie gefeuert haben (Spielgefuehl
		// Paket 2a): eine Kugel, die sanft am Sling-Gummi liegt oder unter der
		// Schwelle anrollt, bleibt stumm und dunkel. Ohne Angabe (`gefeuert`
		// undefined, Aufruf von Hand) gilt der Treffer als gefeuert.
		s.treffer = function (art, objekt, gefeuert) {
			if (s.zustand !== "spiel") return;
			if (gefeuert === false && (art === "bumper" || art === "sling")) return;
			if (art === "bumper") {
				s.skillBereit = false;
				werte(100);
				if (objekt) objekt.blitz = 1;
				if (++s.bumperZaehler % 5 === 0) { bonusHoch(); sage("BONUS " + s.bonus); }
			} else if (art === "sling") {
				s.skillBereit = false;
				werte(10);
				if (objekt) objekt.blitz = 1;      // die Platte darueber blitzt auf
			}
		};

		s.rollover = function (ro) {
			if (s.zustand !== "spiel") return;
			if (ro.art === "bahn") {
				if (s.skillBereit) {
					s.skillBereit = false;
					werte(5000, "SKILL SHOT");
				}
				if (s.bahnen[ro.buchstabe]) return;
				s.bahnen[ro.buchstabe] = true;
				werte(500);
				if (s.bahnen.V && s.bahnen.F && s.bahnen.X) {
					s.bahnen = {};
					werte(3000, "V-F-X COMPLETE");
					bonusHoch();
				}
			} else if (ro.art === "rueckgasse") {
				s.skillBereit = false;
				werte(200);
				bonusHoch();
			} else if (ro.art === "auslauf") {
				s.skillBereit = false;
				werte(500);
			}
		};

		s.ziel = function (z) {
			if (s.zustand !== "spiel") return;
			s.skillBereit = false;
			if (z.gruppe === "steh") {
				if (z.an) return;
				z.an = 1;
				werte(500);
				if (ziele.every(function (q) { return q.gruppe !== "steh" || q.an; })) {
					werte(2000, "TARGETS LIT");
					bonusHoch();
				}
				return;
			}
			if (z.unten) return;
			z.unten = true; z.sinken = 0;
			werte(1000);
			if (bankVollstaendig(z.gruppe) && !bankTimer[z.gruppe]) {
				werte(5000, "BANK COMPLETE");
				multiHoch();
				bankTimer[z.gruppe] = 1.6;       // gleich wieder aufstellen
			}
		};

		// Ballverlust: erst wird der Bonus abgezaehlt, dann geht es weiter.
		s.ballVerloren = function () {
			if (s.zustand !== "spiel") return;
			if (s.bonus > 0) {
				s.zustand = "bonus";
				s.bonusRest = s.bonus;
				s.bonusZaehlt = 0;
				s.bonusTakt = 0;
				sage("BONUS  " + s.bonus + " X " + multi(), 3.0);
			} else {
				naechsterBall();
			}
		};

		function naechsterBall() {
			s.baelle--;
			if (s.baelle <= 0) {
				s.zustand = "aus";
				sage("GAME OVER", 5.0);
			} else {
				s.ball++;
				neuerBall();
				sage("BALL " + s.ball, 2.0);
			}
		}
		s.naechsterBall = naechsterBall;

		s.schritt = function (dt) {
			if (s.meldungZeit > 0) {
				s.meldungZeit -= dt;
				if (s.meldungZeit <= 0) s.meldung = "";
			}
			// Fallziele sinken sichtbar ab
			ziele.forEach(function (z) {
				if (z.unten && z.sinken < 1) z.sinken = Math.min(1, z.sinken + dt * 6);
				if (!z.unten && z.sinken > 0) z.sinken = Math.max(0, z.sinken - dt * 4);
			});
			Object.keys(bankTimer).forEach(function (g) {
				bankTimer[g] -= dt;
				if (bankTimer[g] <= 0) { bankZuruecksetzen(g); delete bankTimer[g]; }
			});
			// Bonusabrechnung: eine Stufe alle 0,28 s, hoerbar Stueck fuer Stueck
			if (s.zustand === "bonus") {
				s.bonusTakt += dt;
				while (s.bonusTakt >= 0.28 && s.bonusRest > 0) {
					s.bonusTakt -= 0.28;
					s.bonusRest--;
					s.bonusZaehlt++;
					s.punkte += 1000 * multi();
					s.bonus = s.bonusRest;
				}
				if (s.bonusRest === 0 && s.bonusTakt > 0.6) naechsterBall();
			}
		};

		/*
		 * Sollhelligkeit einer Lampe. Waehrend des Spiels zeigen die Lampen den
		 * Stand an - die Bonusleiter steht auf ihrer Stufe, gesammelte
		 * Buchstaben leuchten, gefallene Ziele sind aus. Nur ohne laufendes
		 * Spiel laeuft das Wandermuster des Attract-Modus.
		 */
		s.lampeZiel = function (lp, zeit, i) {
			var spielt = s.zustand === "spiel" || s.zustand === "bonus";
			if (!spielt) {
				// Attract: eine Welle wandert ueber den ganzen Tisch
				var w = Math.max(0, Math.sin(zeit * 1.8 - i * 0.35));
				return 0.05 + 0.95 * w * w * w * w;
			}
			switch (lp.art) {
			case "bumper":
				return 0.13 + 0.87 * (lp.objekt ? lp.objekt.blitz : 0);
			case "sling":
				// Dauerglimmen unter der Platte, beim Treffer voll
				return 0.30 + 0.70 * (lp.objekt && lp.objekt.blitz ? lp.objekt.blitz : 0);
			case "einsatz":
				// Bonusleiter: die erreichte Stufe blinkt, darunter steht alles an
				if (lp.nr < s.bonus) return 1.0;
				if (lp.nr === s.bonus && s.zustand === "bonus")
					return (zeit * 8) % 1 < 0.5 ? 1.0 : 0.1;
				return 0.05;
			case "bahn":
				return s.bahnen[lp.buchstabe] ? 1.0
				     : (s.skillBereit ? (0.25 + 0.35 * (0.5 + 0.5 * Math.sin(zeit * 6))) : 0.08);
			case "ziel":
				var z = lp.objekt;
				if (!z) return 0.08;
				if (z.gruppe === "steh") return z.an ? 1.0 : 0.10;
				return z.unten ? 0.06 : 0.85;
			case "pfeil":
				return ((zeit * 2.2 + i * 0.5) % 2) < 1 ? 0.75 : 0.06;
			default:
				return 0.10;
			}
		};

		s.multi = multi;
		s.bonusMax = BONUS_MAX;
		return s;
	}

	/*
	 * Kugelzyklus zwischen Physik und Regelwerk: Abschussrinne, Abfluss, neue
	 * Kugel. Beide Renderer (pinball-gpu.js, pinball.js) rufen schritt(dt)
	 * nach jedem Physik-Unterschritt; hier steht es einmal und laesst sich
	 * ohne Browser pruefen (tests/ablauf_test.js).
	 *
	 *   Rinne       Rechts von schachtX und unter bogenY - 0.12 liegt die Kugel
	 *               im Schacht - auch wenn sie aus dem Feld zurueckrollt.
	 *               Frueher setzte das nur das Einwerfen; eine zurueckgerollte
	 *               Kugel liess sich dann nicht mehr abschiessen. Im Schacht
	 *               haelt die Rinnenwand sie rechts von `grenze`.
	 *   Abfluss     unter y = -0.055: Kugel aus, Ballverlust melden, 1 s warten.
	 *   Neue Kugel  sobald die Wartezeit um ist UND das Regelwerk "spiel"
	 *               meldet, gleich in welcher Reihenfolge. Die Bonusabrechnung
	 *               dauert ab Bonus 2 laenger als die Wartezeit; frueher kam
	 *               dann nie wieder eine Kugel.
	 *
	 * o: { ph, spiel, schachtX, bogenY, grenze, neueKugel() }
	 */
	function macheKugelZyklus(o) {
		var RINNE_OBEN = o.bogenY - 0.12;
		var z = { imSchacht: true, ballTot: 0 };
		z.schritt = function (dt) {
			var ph = o.ph, spiel = o.spiel;
			if (ph.aktiv) {
				if (ph.p[0] > o.schachtX && ph.p[1] < RINNE_OBEN) z.imSchacht = true;
				if (z.imSchacht) {
					if (ph.p[1] > RINNE_OBEN) z.imSchacht = false;
					else if (ph.p[0] < o.grenze) { ph.p[0] = o.grenze; if (ph.v[0] < 0) ph.v[0] = 0; }
				}
				spiel.pruefeRollover(ph.p[0], ph.p[1]);
				if (ph.p[1] < -0.055) {
					ph.aktiv = false;
					spiel.ballVerloren();
					z.ballTot = 1.0;
				}
				return;
			}
			if (z.ballTot > 0) z.ballTot -= dt;
			if (z.ballTot <= 0 && spiel.zustand === "spiel") o.neueKugel();
		};
		return z;
	}

	global.macheSpiel = macheSpiel;
	global.macheKugelZyklus = macheKugelZyklus;
})(typeof window !== "undefined" ? window : globalThis);
