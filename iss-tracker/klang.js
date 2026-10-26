/*
 * ISS Tracker - Hintergrundmusik (Task 17): "Space Ambient" von leberch
 * (Pixabay Content License), Ambient ohne Beat, als Schleife hinter der Szene.
 *
 * Musik ist per Voreinstellung AN (Entscheidung 01.10.2026). Die Wahl steht in
 * localStorage['iss-tracker-klang'] ('an' | 'aus'); nur eine bewusste Aktion
 * (Lautsprecher-Knopf #bKlang, Taste m in tracker.js, an()/aus()) schreibt sie.
 *   - ohne Wahl oder mit 'an': neu() versucht sofort zu spielen. Browser
 *     erlauben Ton meist erst nach einer Nutzeraktion; lehnt der Browser play()
 *     ab (NotAllowedError), bleibt der Knopf im Zustand "Wunsch"
 *     (aria-pressed="true", Klasse "wunsch", wartet() = true) und die erste
 *     Nutzergeste im Dokument startet den Ton: pointerdown (Maus), pointerup
 *     (Finger/Stift), touchend, keydown (nicht Escape) - Hoerer auf window,
 *     Einfangphase, passiv, nach dem Start wieder entfernt. Die Geste behaelt
 *     ihre Wirkung (Kamera drehen usw.). Nicht als Geste zaehlen Ereignisse am
 *     Knopf selbst und die Tasten in optionen.tasten (tracker.js: m) - die
 *     schalten ohnehin bewusst um, sonst liefe an -> sofort wieder aus.
 *     Eine Ablehnung speichert nichts.
 *   - mit 'aus': kein Versuch, keine Gesten-Hoerer; der Knopf startet.
 * umschalten() entscheidet nach dem Zustand: im Wunsch (Zustand 'aus') startet
 * es, bei 'an'/'laedt' schaltet es aus.
 *
 * Zustaende (zustand()):
 *   'aus'    kein Ton (auch waehrend des Ausblendens und im Wunsch)
 *   'laedt'  play() ist unterwegs (preload="none": die Datei kommt erst jetzt)
 *   'an'     Ton laeuft (oder ist nur wegen eines verborgenen Tabs pausiert)
 *   'fehler' keine Quelle abspielbar (Datei fehlt, Format unbekannt); der
 *            naechste Klick versucht es erneut (load() + play())
 * Uebergaenge:
 *   aus    --an() / Start / Geste-->  laedt
 *   laedt  --play() erfuellt-->       an     (Einblenden 2 s von 0 auf 0,35)
 *   laedt  --play() abgelehnt-->      aus + Wunsch (Gesten-Hoerer, nichts gespeichert)
 *   laedt  --NotSupportedError / Fehler an der letzten <source>--> fehler
 *   laedt  --aus()-->                 aus    (pause() bricht das offene play() ab)
 *   an     --aus()-->                 aus    (Ausblenden 1 s, danach pause())
 *   aus (noch am Ausblenden) --an()--> an    (Rampe kehrt um, kein neues play())
 * Antworten aelterer play()-Versuche verfallen (Zaehler lauf).
 *
 * Lautstaerke-Rampe per setInterval (50 ms) ueber HTMLMediaElement.volume,
 * kein Web-Audio-Graph. Einblenden quadratisch (leiser Anfang), Ausblenden
 * mit (1 - t)^2; die Dauer gilt fuer den vollen Weg 0 <-> 0,35 und schrumpft
 * anteilig (Umkehr mitten in einer Blende ist entsprechend kuerzer). Wo volume
 * nicht setzbar ist (iOS liest immer 1), entfallen die Blenden: aus() pausiert
 * sofort.
 * visibilitychange: verborgen -> pause(); wieder sichtbar und 'an' -> play()
 * und erneut einblenden.
 *
 * In Node ladbar: document/Audio erst in neu(). Fuer Tests ersetzen
 *   optionen.player   das <audio>-Element: { play() -> Promise, pause(), volume, loop }
 *   optionen.takt     die Uhr: { alle(fn, ms) -> id, stopp(id), jetzt() -> ms }
 *   optionen.dokument das document (visibilitychange, hidden)
 *   optionen.fenster  das window (Gesten-Hoerer; null = keine)
 */
(function (window) {
	"use strict";

	var SCHLUESSEL = "iss-tracker-klang";
	var LAUTSTAERKE = 0.35, EINBLENDEN_MS = 2000, AUSBLENDEN_MS = 1000, SCHRITT_MS = 50;
	var TYPEN = { ogg: "audio/ogg; codecs=vorbis", opus: "audio/ogg; codecs=opus", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };

	// MIME-Typ fuer <source type>: der Browser ueberspringt damit Formate, die er
	// nicht kann, ohne sie abzurufen.
	function typVon(url) {
		var m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(url));
		return (m && TYPEN[m[1].toLowerCase()]) || "";
	}

	// <audio loop preload="none"> mit einer <source> je Quelle (Reihenfolge =
	// Vorrang). Das Element bleibt ausserhalb des DOM - spielen kann es trotzdem.
	function erzeugePlayer(quellen) {
		var a = document.createElement("audio");
		a.loop = true;
		a.preload = "none";
		quellen.forEach(function (q) {
			var s = document.createElement("source");
			s.src = q;
			var t = typVon(q);
			if (t) s.type = t;
			a.appendChild(s);
		});
		return a;
	}

	function standardTakt() {
		return {
			alle: function (fn, ms) { return setInterval(fn, ms); },
			stopp: function (id) { clearInterval(id); },
			jetzt: function () { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }
		};
	}

	function neu(optionen) {
		var o = optionen || {};
		var knopf = o.knopf || null;
		var quellen = o.quellen || [];
		var ziel = typeof o.lautstaerke === "number" && isFinite(o.lautstaerke) ? Math.max(0, Math.min(1, o.lautstaerke)) : LAUTSTAERKE;
		var speicher = o.speicher || null;
		var takt = o.takt || standardTakt();
		var dok = o.dokument !== undefined ? o.dokument : (typeof document !== "undefined" ? document : null);
		var fenster = o.fenster !== undefined ? o.fenster : (window && typeof window.addEventListener === "function" ? window : null);
		var tasten = o.tasten || [];
		var eigen = !o.player;
		var player = o.player || erzeugePlayer(quellen);
		player.loop = true;

		var zustand = "aus";
		var spielt = false;              // play() erfuellt, noch kein pause()
		var ausstehend = false;          // ein play() ist unterwegs
		var lauf = 0;                    // Nummer des letzten play()-Versuchs
		var steuerbar = true;            // volume setzbar (iOS: nein)
		var wartetAufSichtbar = false;   // wegen verborgenem Tab pausiert, Zustand 'an'
		var keineQuelle = false;         // letzte <source> meldete einen Fehler -> vor dem naechsten play() load()
		var rampeId = null;
		var wartetAufGeste = liesWahl() !== "aus";   // Voreinstellung und gespeichertes 'an': Musik gewuenscht
		var gestenAn = false;

		// ---- Speicher (localStorage kann werfen: privater Modus, gesperrte Cookies)
		function liesWahl() {
			try { return speicher ? speicher.getItem(SCHLUESSEL) : null; } catch (e) { return null; }
		}
		function merke(wert) {
			try { if (speicher) speicher.setItem(SCHLUESSEL, wert); } catch (e) { /* ohne Speicher weiter */ }
		}

		// ---- Knopf: aria-pressed = Ton an/startet oder Wunsch (wartet auf eine Geste)
		function wartet() { return zustand === "aus" && wartetAufGeste; }
		function zeigeKnopf() {
			if (!knopf) return;
			var wunsch = wartet();
			var gedrueckt = zustand === "an" || zustand === "laedt" || wunsch;
			if (knopf.setAttribute) knopf.setAttribute("aria-pressed", gedrueckt ? "true" : "false");
			if (knopf.classList) {
				knopf.classList.toggle("wunsch", wunsch);
				knopf.classList.toggle("laedt", zustand === "laedt");
				knopf.classList.toggle("fehler", zustand === "fehler");
			}
		}

		// ---- Lautstaerke und Rampe
		function lautstaerke() {
			var v = +player.volume;
			return isFinite(v) ? v : 0;
		}
		function setzeLautstaerke(v) {
			try { player.volume = Math.max(0, Math.min(1, v)); } catch (e) { /* manche Browser werfen bei volume */ }
		}
		function stoppeRampe() {
			if (rampeId !== null) { takt.stopp(rampeId); rampeId = null; }
		}
		function rampe(zielWert, vollMs, dann) {
			stoppeRampe();
			var start = lautstaerke(), weg = Math.abs(zielWert - start);
			var dauer = ziel > 0 ? vollMs * Math.min(1, weg / ziel) : 0;
			if (!steuerbar || dauer < SCHRITT_MS) {
				setzeLautstaerke(zielWert);
				if (dann) dann();
				return;
			}
			var t0 = takt.jetzt(), steigt = zielWert > start;
			rampeId = takt.alle(function () {
				var t = Math.min(1, (takt.jetzt() - t0) / dauer);
				var k = steigt ? t * t : 1 - (1 - t) * (1 - t);
				setzeLautstaerke(t >= 1 ? zielWert : start + (zielWert - start) * k);
				if (t >= 1) {
					stoppeRampe();
					if (dann) dann();
				}
			}, SCHRITT_MS);
		}

		function verborgen() { return !!(dok && dok.hidden); }
		function halte() { try { player.pause(); } catch (e) { /* nichts */ } }

		// ---- play() mit Zaehler: spaete Antworten eines abgeloesten Versuchs verfallen
		function spiele(nachErfolg) {
			var n = ++lauf, p;
			ausstehend = true;
			try { p = player.play(); }
			catch (e) { ausstehend = false; abgelehnt(e); return; }
			Promise.resolve(p).then(function () {
				if (n !== lauf) return;
				ausstehend = false;
				nachErfolg();
			}, function (e) {
				if (n !== lauf) return;        // z. B. AbortError nach pause() aus aus()
				ausstehend = false;
				abgelehnt(e);
			});
		}
		function abgelehnt(e) {
			stoppeRampe();
			spielt = false;
			wartetAufSichtbar = false;
			if (e && e.name === "NotSupportedError") {
				zustand = "fehler";
				keineQuelle = true;              // naechster Versuch mit load() (Quellenauswahl neu)
				wartetAufGeste = false;
				loeseGesten();
				if (typeof console !== "undefined") console.warn("background music unavailable: " + (e.message || e.name));
			} else {
				// Autoplay-Sperre (NotAllowedError) u. a.: der Wunsch bleibt, die erste
				// Geste startet. Nichts speichern - 'aus' schreibt nur eine bewusste
				// Abschaltung (Nachtrag 01.10.2026; vorher: 'aus' gemerkt).
				zustand = "aus";
				wartetAufGeste = true;
				haengeGestenAn();
				// Task 19 (M11): sonst still - ein Kippen von 'an' auf 'aus' (Pruefstand
				// r12a) war nicht zu diagnostizieren
				if (typeof console !== "undefined") console.info("background music waits for a user gesture: " + (e && e.name ? e.name : String(e)));
			}
			zeigeKnopf();
		}

		// ---- Erste Nutzergeste startet den Wunsch. Einfangphase auf window: kein
		// Seiten-Handler kann sie mit stopPropagation verschlucken; passiv, die
		// Geste behaelt ihre Wirkung. Nur Ereignisse, die Browser als Nutzeraktion
		// werten (Maus: pointerdown; Finger/Stift: pointerup, touchend; Tasten
		// ausser Escape) - reine Bewegung, Rad und Scrollen zaehlen nicht.
		var GESTEN = ["pointerdown", "pointerup", "touchend", "keydown"];
		var GESTEN_OPTIONEN = { capture: true, passive: true };
		function istGeste(e) {
			if (!e) return false;
			var art = e.pointerType;
			if (e.type === "pointerdown" && art && art !== "mouse") return false;   // Finger/Stift: erst beim Loslassen
			if (e.type === "pointerup" && (!art || art === "mouse")) return false;  // Maus: schon bei pointerdown
			if (e.type === "keydown" && (e.key === "Escape" || tasten.indexOf(e.key) >= 0)) return false;   // m: tracker.js schaltet selbst
			if (knopf && e.target && typeof knopf.contains === "function" && knopf.contains(e.target)) return false;   // Knopf: sein click schaltet
			return true;
		}
		function beiGeste(e) {
			if (!wartet() || spielt || !istGeste(e)) return;
			starte(false);
		}
		function haengeGestenAn() {
			if (gestenAn || !fenster || typeof fenster.addEventListener !== "function") return;
			gestenAn = true;
			GESTEN.forEach(function (typ) { fenster.addEventListener(typ, beiGeste, GESTEN_OPTIONEN); });
		}
		function loeseGesten() {
			if (!gestenAn) return;
			gestenAn = false;
			GESTEN.forEach(function (typ) { fenster.removeEventListener(typ, beiGeste, GESTEN_OPTIONEN); });
		}
		function pausiereVerborgen() {
			stoppeRampe();
			halte();
			spielt = false;
			if (zustand === "an") wartetAufSichtbar = true;
		}
		function laeuft() {                   // play() erfuellt: einblenden (oder gleich halten, wenn verborgen)
			spielt = true;
			if (verborgen()) { pausiereVerborgen(); return; }
			rampe(ziel, EINBLENDEN_MS);
		}

		// ---- Schnittstelle
		// starte(bewusst): bewusst = Knopf/Taste/an() - merkt 'an' und beendet den
		// Wunsch; sonst (Start in neu(), erste Geste) wird nichts gespeichert.
		function starte(bewusst) {
			if (bewusst) {
				wartetAufGeste = false;
				loeseGesten();
				merke("an");
			}
			if (zustand === "an" || zustand === "laedt") { zeigeKnopf(); return; }
			if (spielt) {                     // noch am Ausblenden: umkehren
				zustand = "an";
				zeigeKnopf();
				rampe(ziel, EINBLENDEN_MS);
				return;
			}
			zustand = "laedt";
			zeigeKnopf();
			if (keineQuelle && typeof player.load === "function") {
				keineQuelle = false;
				try { player.load(); } catch (e) { /* play() meldet den Fehler */ }
			}
			setzeLautstaerke(0);
			steuerbar = lautstaerke() < 0.001;
			spiele(function () {
				wartetAufGeste = false;           // Ton laeuft: Gesten-Hoerer weg (einmalig)
				loeseGesten();
				zustand = "an";
				zeigeKnopf();
				laeuft();
			});
		}
		function an() { starte(true); }
		function aus() {
			wartetAufGeste = false;
			loeseGesten();
			merke("aus");
			wartetAufSichtbar = false;
			lauf++;                           // offene play()-Antworten verfallen
			if (ausstehend) { ausstehend = false; halte(); }
			zustand = "aus";
			zeigeKnopf();
			if (spielt) {
				rampe(0, AUSBLENDEN_MS, function () { halte(); spielt = false; });
			}
		}
		function umschalten() {
			if (zustand === "an" || zustand === "laedt") aus();
			else an();
		}

		// ---- Ereignisse
		function sichtbarkeit() {
			if (verborgen()) {
				if (spielt) pausiereVerborgen();
			} else if (wartetAufSichtbar && zustand === "an" && !ausstehend) {
				wartetAufSichtbar = false;
				setzeLautstaerke(0);
				spiele(laeuft);
			}
		}
		function quellenFehler() {
			keineQuelle = true;
			if (zustand !== "laedt" && zustand !== "an") return;
			lauf++;
			ausstehend = false;
			abgelehnt({ name: "NotSupportedError", message: "no playable source" });
		}
		if (eigen && player.addEventListener) {
			var letzte = player.lastElementChild;           // Fehler an der letzten <source>: keine Quelle ging
			if (letzte && letzte.addEventListener) letzte.addEventListener("error", quellenFehler);
			player.addEventListener("error", quellenFehler); // Netz-/Dekodierfehler am Element
		}
		if (dok && dok.addEventListener) dok.addEventListener("visibilitychange", sichtbarkeit);
		if (knopf && knopf.addEventListener) knopf.addEventListener("click", function () { umschalten(); });
		setzeLautstaerke(0);                            // still bis zum ersten Einblenden (lautstaerke() stimmt dann auch vorher)
		zeigeKnopf();
		if (wartetAufGeste) {                           // Voreinstellung/'an': gleich versuchen, Gesten als Rueckfall
			haengeGestenAn();
			starte(false);
		}

		return {
			an: an,
			aus: aus,
			umschalten: umschalten,
			istAn: function () { return zustand === "an" || zustand === "laedt"; },   // wie aria-pressed, ohne den Wunsch
			wartet: wartet,                                                          // Wunsch: gesperrt, erste Geste startet
			zustand: function () { return zustand; },
			lautstaerke: lautstaerke,
			player: player
		};
	}

	window.Klang = {
		neu: neu,
		typVon: typVon,
		SCHLUESSEL: SCHLUESSEL,
		LAUTSTAERKE: LAUTSTAERKE,
		EINBLENDEN_MS: EINBLENDEN_MS,
		AUSBLENDEN_MS: AUSBLENDEN_MS,
		SCHRITT_MS: SCHRITT_MS
	};
})(window);
