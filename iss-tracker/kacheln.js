/*
 * ISS Tracker - Detailkacheln der Erde (Task 15b)
 *
 * Die Tagkarte gibt es in zwei Stufen: die Basis (erde-tag-8192/4096) fuer die
 * Fernsicht und 32 Kacheln in voller Quellaufloesung (500 m/px), die nur bei
 * Annaeherung nachgeladen werden. Kachelschema wie in LIESMICH.md: 8 Spalten
 * (s, West -> Ost ab 180 Grad West) x 4 Zeilen (z, Nord -> Sued), je 45 x 45
 * Grad = 2700 x 2700 px Nutzflaeche plus 2 px Rand je Seite (2704 x 2704).
 * Globale Textur-uv (u = lon/2pi + 0,5; v = 0,5 - lat/pi) -> Kachel-uv:
 *   u' = 2/2704 + (8u - s) * 2700/2704,   v' = 2/2704 + (4v - z) * 2700/2704.
 *
 * Laufzeit: eine texture_2d_array rgba8unorm 2704 x 2704 x Slots (Desktop 4,
 * Handy 2) mit 12 Mipstufen; je Slot liegt eine Kachel. Auswahl: die 'slots'
 * Kacheln, deren Mittelpunkte dem Fusspunkt der Station am naechsten liegen
 * (Abstand in Kacheleinheiten, Spalten zyklisch, Zeilen 0/3 ueber den Pol
 * gespiegelt). Neubewertung alle 2 s echter Zeit oder bei Kachelwechsel des
 * Fusspunkts; hoechstens ein Ladevorgang gleichzeitig (fetch -> ImageBitmap ->
 * copyExternalImageToTexture in den Layer -> Mipmaps je Layer), Warteschlange
 * nach Naehe, Verdraengung der am laengsten nicht gewuenschten Kachel (LRU).
 * Ein fehlgeschlagener Abruf wird in derselben Sitzung nicht wiederholt; die
 * Basis bleibt dann sichtbar.
 *
 * Uniform-Tabelle fuer den Erd-Shader (tabelle(), 20 Floats = 80 Byte):
 *   Slot i (Float 4i): u0 = s/8, v0 = z/4, skala = 2700/2704, aktiv (0|1)
 *   Float 16: blendNahKm, blendFernKm, slots, 0
 * Der Shader mischt die Kachel gegen die Basis nach dem Abstand Kamera ->
 * Oberflaechenpunkt: voll unter 3000 km, aus ueber 6000 km.
 *
 * Speicher je Slot: 2704^2 x 4 Byte = 29,2 MB, mit Mipkette ~39 MB.
 *
 * Kacheln.index/waehle/uvLokal/slotsFuer sind reine Funktionen (Tests in Node);
 * neu(gpu, optionen) fasst das Geraet erst beim Aufruf an. optionen.lade und
 * optionen.waehle sind Haken fuer die Tests (Attrappen statt fetch/Auswahl).
 */
(function (window) {
	"use strict";

	var SPALTEN = 8, ZEILEN = 4;
	var KACHEL_PX = 2704, NUTZ_PX = 2700, RAND_PX = 2;
	var MIPSTUFEN = 12;                               // 2704 -> 1352 -> ... -> 1
	var SLOTS_MAX = 4, SLOTS_DESKTOP = 4, SLOTS_HANDY = 2, HANDY_UNTER_PX = 1600;
	var BLEND_NAH_KM = 3000, BLEND_FERN_KM = 6000;    // Mischung Kachel/Basis nach Abstand Kamera -> Boden
	var LADEN_UNTER_KM = BLEND_FERN_KM;               // Kacheln nur, wenn die Station naeher ist (oder Folgen-Modus)
	var NEUBEWERTUNG_MS = 2000;
	var SKALA = NUTZ_PX / KACHEL_PX, RAND_UV = RAND_PX / KACHEL_PX;
	var TABELLE_FLOATS = SLOTS_MAX * 4 + 4;
	var TAU = 2 * Math.PI;

	// ---------------------------------------------------------- Geometrie (rein)
	// u zyklisch in [0, 1): 180 Grad Ost faellt mit 180 Grad West zusammen (Spalte 0).
	function uVon(lon) { var u = lon / TAU + 0.5; return u - Math.floor(u); }
	function vVon(lat) { return Math.min(1, Math.max(0, 0.5 - lat / Math.PI)); }
	function spalteVon(u) { return Math.min(SPALTEN - 1, Math.max(0, Math.floor(u * SPALTEN))); }
	function zeileVon(v) { return Math.min(ZEILEN - 1, Math.max(0, Math.floor(v * ZEILEN))); }

	// Kachel unter einem Punkt (rad).
	function index(lat, lon) {
		return { s: spalteVon(uVon(lon)), z: zeileVon(vVon(lat)) };
	}

	// Quadrat des Abstands (in Kacheleinheiten) eines Punktes (gu = 8u, gv = 4v)
	// zum Mittelpunkt der Kachel (s, z); Spalten zyklisch.
	function abstand2(gu, gv, s, z) {
		var du = Math.abs(gu - (s + 0.5));
		du = Math.min(du, SPALTEN - du);
		var dv = gv - (z + 0.5);
		return du * du + dv * dv;
	}

	// Die 'anzahl' Kacheln mit den naechsten Mittelpunkten, naechste zuerst.
	// Im Kachelraster hat die Kachel unter dem Punkt immer den kleinsten
	// Abstand (beide Komponenten <= 0,5) - sie ist also stets die erste; das
	// gilt fuer den Grosskreisabstand nicht (Polkacheln sind schmaler).
	// Zeilen 0/3: der Punkt wird zusaetzlich ueber den Pol gespiegelt
	// (u + 1/2, -v bzw. u + 1/2, 2 - v), damit die Gegenkachel jenseits des
	// Pols als Nachbar zaehlt.
	function waehle(lat, lon, anzahl) {
		var gu = uVon(lon) * SPALTEN, gv = vVon(lat) * ZEILEN;
		var gus = gu + SPALTEN / 2;
		if (gus >= SPALTEN) gus -= SPALTEN;
		var liste = [];
		for (var z = 0; z < ZEILEN; z++) {
			for (var s = 0; s < SPALTEN; s++) {
				var d = abstand2(gu, gv, s, z);
				if (z === 0) d = Math.min(d, abstand2(gus, -gv, s, z));
				if (z === ZEILEN - 1) d = Math.min(d, abstand2(gus, 2 * ZEILEN - gv, s, z));
				liste.push({ s: s, z: z, d: d });
			}
		}
		// Die Kachel unter dem Punkt zuerst - auch bei Gleichstand genau auf einer
		// Kachelgrenze (dort gaebe die Sortierung sonst dem Nachbarn den Vortritt).
		var unter = spalteVon(gu / SPALTEN) + zeileVon(gv / ZEILEN) * SPALTEN;
		liste[unter].d = -1;
		liste.sort(function (a, b) { return (a.d - b.d) || (a.z - b.z) || (a.s - b.s); });
		var n = Math.max(0, Math.min(liste.length, Math.floor(+anzahl) || 0));
		var aus = [];
		for (var i = 0; i < n; i++) aus.push({ s: liste[i].s, z: liste[i].z });
		return aus;
	}

	// Globale Textur-uv -> Kachel-uv (Nutzflaeche 2/2704 .. 1 - 2/2704).
	function uvLokal(s, z, u, v) {
		return { u: RAND_UV + (u * SPALTEN - s) * SKALA, v: RAND_UV + (v * ZEILEN - z) * SKALA };
	}

	function slotsFuer(breite, hoehe) {
		return Math.max(breite || 0, hoehe || 0) < HANDY_UNTER_PX ? SLOTS_HANDY : SLOTS_DESKTOP;
	}

	function schluessel(s, z) { return s + "-" + z; }

	// ---------------------------------------------------------- Laden
	// fetch -> ImageBitmap ohne Farbraumwandlung (wie die uebrigen Karten).
	function ladeBild(url) {
		return fetch(url).then(function (r) {
			if (!r.ok) throw new Error("HTTP " + r.status);
			return r.blob();
		}).then(function (blob) {
			return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
		});
	}
	function schliesse(bitmap) { if (bitmap && typeof bitmap.close === "function") { try { bitmap.close(); } catch (e) { /* schon zu */ } } }

	// ---------------------------------------------------------- Laufzeit
	// optionen: { slots (1..4), url ("texturen/kacheln/"), version ("?v=1"),
	//             lade(url) -> Promise<ImageBitmap>, waehle(lat, lon, n) }
	function neu(gpu, optionen) {
		var o = optionen || {};
		var device = gpu.device;
		var slots = isFinite(o.slots) ? Math.max(1, Math.min(SLOTS_MAX, Math.floor(o.slots))) : SLOTS_DESKTOP;
		var url = o.url !== undefined ? String(o.url) : "texturen/kacheln/";
		var version = o.version ? String(o.version) : "";
		var lade = typeof o.lade === "function" ? o.lade : ladeBild;
		var waehleFn = typeof o.waehle === "function" ? o.waehle : waehle;
		var usage = window.GPUTextureUsage;

		var textur = device.createTexture({
			label: "erde kacheln",
			size: [KACHEL_PX, KACHEL_PX, slots],
			dimension: "2d",
			format: "rgba8unorm",
			mipLevelCount: MIPSTUFEN,
			usage: usage.TEXTURE_BINDING | usage.COPY_DST | usage.RENDER_ATTACHMENT
		});

		var tabelle = new Float32Array(TABELLE_FLOATS);
		tabelle[SLOTS_MAX * 4] = BLEND_NAH_KM;
		tabelle[SLOTS_MAX * 4 + 1] = BLEND_FERN_KM;
		tabelle[SLOTS_MAX * 4 + 2] = slots;
		tabelle[SLOTS_MAX * 4 + 3] = 0;

		// Je Slot: kachel = Schluessel der Daten im Layer (null = leer), s/z dazu,
		// reserviert = Schluessel des laufenden Ladevorgangs in diesen Layer,
		// zuletzt = Zeit (ms), zu der die Kachel zuletzt gewuenscht war (LRU).
		var slotDaten = [];
		for (var i = 0; i < slots; i++) slotDaten.push({ kachel: null, s: 0, z: 0, reserviert: null, zuletzt: -Infinity });
		var fehlgeschlagen = {};                      // Schluessel -> true (kein Wiederholen)
		var ladend = null;                            // Schluessel des laufenden Ladevorgangs
		var warteschlange = [];                       // gewuenscht, nicht geladen, nach Naehe
		var zielSet = {};                             // aktuell gewuenschte Schluessel
		var letzteBewertungMs = -Infinity, letzteKachel = -1;
		var verloren = false, zerstoert = false;

		if (device.lost && typeof device.lost.then === "function") {
			device.lost.then(function () { verloren = true; }, function () { verloren = true; });
		}

		function schreibeSlot(i) {
			var sl = slotDaten[i], a = i * 4;
			tabelle[a] = sl.s / SPALTEN;
			tabelle[a + 1] = sl.z / ZEILEN;
			tabelle[a + 2] = SKALA;
			tabelle[a + 3] = sl.kachel ? 1 : 0;
		}

		// Wunschliste neu: Slots mit Gewuenschtem als frisch markieren, den Rest
		// der Liste (ohne Fehlgeschlagene) in die Warteschlange, nach Naehe.
		function bewerte(lat, lon, jetztMs) {
			var liste = waehleFn(lat, lon, slots);
			zielSet = {};
			warteschlange = [];
			var da = {}, j;
			for (j = 0; j < liste.length; j++) zielSet[schluessel(liste[j].s, liste[j].z)] = true;
			for (j = 0; j < slots; j++) {
				var sl = slotDaten[j];
				if (sl.kachel && zielSet[sl.kachel]) { sl.zuletzt = jetztMs; da[sl.kachel] = true; }
				if (sl.reserviert && zielSet[sl.reserviert]) { sl.zuletzt = jetztMs; da[sl.reserviert] = true; }
			}
			for (j = 0; j < liste.length; j++) {
				var key = schluessel(liste[j].s, liste[j].z);
				if (!da[key] && !fehlgeschlagen[key]) warteschlange.push(key);
			}
			letzteBewertungMs = jetztMs;
			k.version++;                                  // wartend hat sich geaendert (trackerDebug)
		}

		// Leerer Slot zuerst; sonst unter den nicht gewuenschten, nicht ladenden
		// der am laengsten nicht gewuenschte (bei Gleichstand der niedrigste).
		function freierSlot() {
			var best = -1, bestZeit = Infinity;
			for (var j = 0; j < slots; j++) {
				var sl = slotDaten[j];
				if (sl.reserviert) continue;
				if (!sl.kachel) return j;
				if (zielSet[sl.kachel]) continue;
				if (sl.zuletzt < bestZeit) { bestZeit = sl.zuletzt; best = j; }
			}
			return best;
		}

		function abschluss(i, key, ok) {
			slotDaten[i].reserviert = null;
			if (ladend === key) ladend = null;
			k.version++;
			return ok ? key : null;
		}
		function fehler(i, key, e) {
			fehlgeschlagen[key] = true;
			console.warn("tile unavailable: " + key + " (" + (e && e.message ? e.message : e) + ")");
			return abschluss(i, key, false);
		}

		function ladeInSlot(i, key, s, z, jetztMs) {
			var sl = slotDaten[i];
			sl.reserviert = key;
			sl.zuletzt = jetztMs;
			ladend = key;
			k.version++;
			var p;
			try { p = Promise.resolve(lade(url + "tag-" + key + ".jpg" + version)); }
			catch (e) { return Promise.resolve(fehler(i, key, e)); }
			return p.then(function (bitmap) {
				if (verloren || zerstoert) { schliesse(bitmap); return abschluss(i, key, false); }
				try {
					if (!bitmap || bitmap.width !== KACHEL_PX || bitmap.height !== KACHEL_PX) {
						throw new Error("unexpected size " + (bitmap ? bitmap.width + "x" + bitmap.height : "none"));
					}
					// Der alte Inhalt des Layers bleibt bis zu dieser Kopie sichtbar;
					// Kopie und Mipmap-Blits stehen in der Warteschlange vor dem naechsten
					// Bild, die Tabelle zeigt die neue Kachel also erst mit fertigen Mips.
					device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: textur, origin: [0, 0, i] }, [KACHEL_PX, KACHEL_PX, 1]);
					schliesse(bitmap);
					window.GPU.erzeugeMipmapsLayer(device, textur, "rgba8unorm", MIPSTUFEN, i);
					sl.kachel = key; sl.s = s; sl.z = z;
					schreibeSlot(i);
					return abschluss(i, key, true);
				} catch (e) {
					schliesse(bitmap);
					return fehler(i, key, e);
				}
			}, function (e) {
				if (verloren || zerstoert) return abschluss(i, key, false);
				return fehler(i, key, e);
			});
		}

		// Naechste Kachel der Warteschlange in einen freien Slot laden.
		function starteLaden(jetztMs) {
			while (warteschlange.length) {
				var key = warteschlange.shift();
				if (fehlgeschlagen[key]) continue;
				var belegt = false;
				for (var j = 0; j < slots; j++) if (slotDaten[j].kachel === key || slotDaten[j].reserviert === key) belegt = true;
				if (belegt) continue;
				var i = freierSlot();
				if (i < 0) { warteschlange = []; k.version++; return null; }   // alle Slots gewuenscht: bis zur naechsten Bewertung nichts
				var teile = key.split("-");
				return ladeInSlot(i, key, +teile[0], +teile[1], jetztMs);
			}
			return null;
		}

		var k = {
			slots: slots,
			textur: textur,
			version: 0,                                   // zaehlt jede Zustandsaenderung (fuer trackerDebug)

			// lat/lon (rad) = Fusspunkt der Station, distanzKm = Kamera -> Station,
			// jetztMs = echte Zeit (rAF-Stempel), erzwingen = true im Folgen-Modus.
			// Liefert das Promise eines gestarteten Ladevorgangs (loest mit dem
			// Schluessel oder null auf, nie reject), sonst null. Keine Allokation,
			// solange sich nichts aendert.
			aktualisiere: function (lat, lon, distanzKm, jetztMs, erzwingen) {
				if (zerstoert || verloren) return null;
				if (!isFinite(lat) || !isFinite(lon)) return null;
				if (!(erzwingen === true || distanzKm < LADEN_UNTER_KM)) return null;
				var t = isFinite(jetztMs) ? jetztMs : 0;
				var fuss = spalteVon(uVon(lon)) * ZEILEN + zeileVon(vVon(lat));
				if (fuss !== letzteKachel || t - letzteBewertungMs >= NEUBEWERTUNG_MS) {
					letzteKachel = fuss;
					bewerte(lat, lon, t);
				}
				if (ladend !== null) return null;
				return starteLaden(t);
			},

			tabelle: function () { return tabelle; },

			status: function () {
				var geladen = [], aktiv = 0;
				for (var j = 0; j < slots; j++) {
					if (slotDaten[j].kachel) { geladen.push(slotDaten[j].kachel); }
					if (tabelle[j * 4 + 3] > 0) aktiv++;
				}
				return { slots: slots, geladen: geladen, ladend: ladend, fehlgeschlagen: Object.keys(fehlgeschlagen), aktiv: aktiv, wartend: warteschlange.slice() };
			},

			zerstoere: function () {
				if (zerstoert) return;
				zerstoert = true;
				for (var j = 0; j < slots; j++) {
					slotDaten[j].kachel = null; slotDaten[j].reserviert = null;
					tabelle[j * 4 + 3] = 0;
				}
				ladend = null;
				warteschlange = [];
				try { textur.destroy(); } catch (e) { /* Geraet schon weg */ }
				k.version++;
			}
		};
		return k;
	}

	window.Kacheln = {
		SPALTEN: SPALTEN, ZEILEN: ZEILEN,
		KACHEL_PX: KACHEL_PX, NUTZ_PX: NUTZ_PX, RAND_PX: RAND_PX, MIPSTUFEN: MIPSTUFEN,
		SLOTS_MAX: SLOTS_MAX, BLEND_NAH_KM: BLEND_NAH_KM, BLEND_FERN_KM: BLEND_FERN_KM,
		TABELLE_FLOATS: TABELLE_FLOATS, NEUBEWERTUNG_MS: NEUBEWERTUNG_MS,
		index: index,
		waehle: waehle,
		uvLokal: uvLokal,
		slotsFuer: slotsFuer,
		neu: neu
	};
})(window);
