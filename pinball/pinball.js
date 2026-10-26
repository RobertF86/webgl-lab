/*
 * FRIDAYVFX Pinball - Modelle, Darstellung, Bedienung
 *
 * Die Simulation steht in physik.js, der Grundriss in tisch.js, die Regeln in
 * spiel.js, die Flaechengrafik in spielfeld.js. Hier wird daraus ein Bild und
 * eine Bedienung - und sonst nichts.
 *
 * Koordinaten: auf dem Tisch wird in (x quer, y laengs, h ueber dem Feld)
 * gerechnet, alles in Metern. Beim Zeichnen kippt `welt()` die Ebene um die
 * Neigung. Richtungen muessen mit `weltRichtung()` umgerechnet werden, nicht
 * mit `welt()` - sonst wandern Normalen mit der Verschiebung mit.
 */
(function () {
	"use strict";

	// ---------------------------------------------------------------- Masse
	var W = 0.26, L = 1.15;                    // halbe Schrankbreite, Laenge
	var NEIGUNG = 6.5 * Math.PI / 180;
	var KUGEL_R = 0.0135, KUGEL_M = 0.080;     // 27 mm, 80 g - Normmasse
	var SCHACHT_X = 0.206;
	var BANDE_R = 0.007;

	var SIN = Math.sin(NEIGUNG), COS = Math.cos(NEIGUNG);

	// Abdeckung der Spielfeldtextur. Sie muss die obere Rundung einschliessen:
	// die Bande laeuft im Bogen um (0, L-0.20) mit Radius W und reicht damit
	// bis y = L + 0.06. Netz und Grafik lesen dieselben drei Zahlen.
	var FELD_XR = W + 0.012, FELD_Y0 = -0.075, FELD_Y1 = L + 0.085;

	// Raumabbildung und Matrizen kommen aus raum.js - dort sind sie pruefbar,
	// und genau dort steckte der Fehler, der alle Bauteile gespiegelt zeichnete.
	var RAUM = window.macheRaum(NEIGUNG);
	var welt = RAUM.welt, weltRichtung = RAUM.weltRichtung;
	var modellFuer = RAUM.modellFuer, normalMatrix = RAUM.normalMatrix;
	var m4 = RAUM.m4, ident = RAUM.ident, mul = RAUM.mul;
	var perspektive = RAUM.perspektive, blickAuf = RAUM.blickAuf;

	// ---------------------------------------------------------------- Tisch
	// Slingshots zum Vergleich (Spielgefuehl Paket 2a, Werte in tisch.js
	// SLING_*): ?sling_kick=<m/s>, ?sling_schwelle=<m/s>, ?sling_profil=0|1,
	// ?sling_sperre=<s>, ?sling_alt=1 (altes Verhalten 2.9/0/aus/0). Weicht
	// etwas vom Start ab, haengt das HUD "sling <kick>/<schwelle>" an.
	var SLING = window.slingAusAdresse(location.search);
	var T = window.baueTisch({ W: W, L: L, kugelR: KUGEL_R, bandeR: BANDE_R,
	                           schachtX: SCHACHT_X, sling: SLING });
	var XM = T.XM, SEG = T.segmente, SCHEIBE = T.scheiben, FL = T.flipper;
	var ZIELE = T.ziele, ROLL = T.rollover, MASS = T.masse;
	var BOGEN_Y = T.bogenY;

	// -------------------------------------------------------------- Physik
	// ?alt=1: altes Kontaktverhalten (vor Spielgefuehl Paket 1) zum Vergleich -
	// Kugel klebt am Flipper, Zusatzstoss auch beim Entfernen. Das HUD zeigt
	// dann "physik alt".
	var PHYSIK_ALT = new URLSearchParams(location.search).get("alt") === "1";
	var ph = new window.Physik({
		kugelR: KUGEL_R, kugelM: KUGEL_M,
		g: 9.81 * SIN,
		rollmu: 0.55,
		luft: 0.02,
		kontaktAlt: PHYSIK_ALT
	});
	ph.scheiben = SCHEIBE; ph.flipper = FL;

	function baueKollision() { ph.segmente = spiel.segmenteFuer(SEG); }

	// --------------------------------------------------------------- Spiel
	var spiel = window.macheSpiel({ ziele: ZIELE, rollover: ROLL });
	baueKollision();
	// Rinne, Abfluss, neue Kugel: spiel.js, in beiden Renderern derselbe Zyklus
	var zyklus = window.macheKugelZyklus({ ph: ph, spiel: spiel, schachtX: SCHACHT_X, bogenY: BOGEN_Y,
	                                       grenze: SCHACHT_X + KUGEL_R + BANDE_R, neueKugel: kugelInSchacht });
	var plunger = { zug: 0, laedt: false, rueck: 0 };
	var ruettel = 0;

	// `gefeuert`: hat der Kicker gestossen? Nur dann Punkte und Blitz (spiel.js)
	ph.beiTreffer = function (art, staerke, x, y, objekt, gefeuert) {
		if (spiel.beruehrung(art, objekt, gefeuert)) baueKollision();
	};

	function kugelInSchacht() {
		// Direkt auf dem Anschlag: 0.042 Wandmitte + 0.007 Bandenradius +
		// Kugelradius. So liegt sie ruhig, statt erst hineinzufallen.
		ph.setzeKugel((SCHACHT_X + W) / 2, 0.042 + BANDE_R + KUGEL_R + 0.001);
		ph.v = [0, 0]; ph.w = 0;
		zyklus.imSchacht = true;
		plunger.zug = 0;
	}

	function starteSpiel() {
		spiel.starte();
		baueKollision();
		kugelInSchacht();
	}

	function abschuss() {
		if (!plunger.laedt) return;
		plunger.laedt = false;
		if (zyklus.imSchacht && ph.aktiv) {
			// 3,2 bis 6,6 m/s - darunter kommt die Kugel nicht ueber den Bogen
			ph.v[1] = 3.2 + plunger.zug * 3.4;
			plunger.rueck = plunger.zug;
		}
		plunger.zug = 0;
	}

	function spielSchritt(dt) {
		for (var i = 0; i < FL.length; i++) {
			var f = FL[i], ziel = f.ziel ? f.voll : f.ruhe, vorher = f.w;
			var diff = ziel - f.w, max = 30 * dt;
			f.w = Math.abs(diff) <= max ? ziel : f.w + Math.sign(diff) * max;
			f.wv = (f.w - vorher) / dt;
		}
		ph.stoss[0] = ruettel; ruettel *= Math.exp(-14 * dt);
		ph.schritt(dt);

		// Abschussrinne (auch nach Rueckfall aus dem Feld), Rollover, Abfluss und
		// neue Kugel nach Wartezeit und Bonus - spiel.js, macheKugelZyklus
		zyklus.schritt(dt);
		plunger.rueck *= Math.exp(-9 * dt);
	}

	// ------------------------------------------------------------- Bilder
	function zeichneGlimmbild() {
		// Heller Kern, weicher Hof. Die Farbe kommt aus dem Shader, hier steht
		// nur die Verteilung - so genuegt ein Bild fuer alle Lampen.
		var N = 128, cv = document.createElement("canvas");
		cv.width = cv.height = N;
		var g = cv.getContext("2d");
		var rg = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
		rg.addColorStop(0.00, "rgba(255,255,255,1.00)");
		rg.addColorStop(0.16, "rgba(255,255,255,0.92)");
		rg.addColorStop(0.34, "rgba(255,255,255,0.42)");
		rg.addColorStop(0.62, "rgba(255,255,255,0.12)");
		rg.addColorStop(1.00, "rgba(255,255,255,0.00)");
		g.fillStyle = rg; g.fillRect(0, 0, N, N);
		return cv;
	}

	function zeichneSchattenbild() {
		var N = 128, cv = document.createElement("canvas");
		cv.width = cv.height = N;
		var g = cv.getContext("2d");
		var rg = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
		rg.addColorStop(0.00, "rgba(0,0,0,.80)");
		rg.addColorStop(0.55, "rgba(0,0,0,.34)");
		rg.addColorStop(1.00, "rgba(0,0,0,0)");
		g.fillStyle = rg; g.fillRect(0, 0, N, N);
		return cv;
	}

	// --------------------------------------------------------------- WebGL
	var leinwand = document.getElementById("gl");
	var gl = leinwand.getContext("webgl", { antialias: true, alpha: false })
	      || leinwand.getContext("experimental-webgl");
	if (!gl) {
		var fb = document.getElementById("fallback");
		fb.textContent = "WebGL is not available in this browser.";
		fb.hidden = false;
		return;
	}

	var VS = [
		"attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;",
		"uniform mat4 uMVP, uModell; uniform mat3 uNormM;",
		// Ausschnitt im Teileblatt: xy Ecke, zw Groesse. So teilen sich Kappen,
		// Ziele und Blende eine einzige Textur.
		"uniform vec4 uUvFeld;",
		"varying vec3 vN, vP; varying vec2 vUv;",
		"void main(){",
		"  vec4 wp = uModell * vec4(aPos,1.0);",
		"  vP = wp.xyz; vN = uNormM * aNrm; vUv = uUvFeld.xy + aUv * uUvFeld.zw;",
		"  gl_Position = uMVP * vec4(aPos,1.0);",
		"}"
	].join("\n");

	var FS = [
		"precision highp float;",
		"varying vec3 vN, vP; varying vec2 vUv;",
		"uniform sampler2D uTex;",
		"uniform samplerCube uEnv, uKuppel;",
		"uniform vec3 uFarbe, uAuge;",
		"uniform float uTexAn, uRauheit, uLeucht, uMetall, uAlpha;",
		// Bis zu sechs Lampen des Tisches. Sie faerben die Kugel, waehrend sie
		// darueber rollt - genau das macht ein beleuchtetes Spielfeld aus.
		"uniform vec3 uLampP[6];",
		"uniform vec3 uLampC[6];",
		"uniform int uLampN;",
		// Die Umgebung liegt als x = c/(c+1) vor. Hier zurueckgerechnet; nur so
		// bleiben die Deckenkaesten heller als 1 und Chrom sieht aus wie Chrom.
		"vec3 hdr(vec4 x){ return x.rgb / max(vec3(1.0) - x.rgb, vec3(0.0039)); }",
		// Filmische Kurve statt c/(c+0.9). Die alte hatte keinen Fuss: der
		// dunkle Hallenboden kam als milchiges Grau heraus, weil schon 0.012
		// auf Bildwert 35 abgebildet wurde. Diese hier laesst Schatten
		// Schatten sein und faengt die Lampen oben weich ab.
		"vec3 kurve(vec3 c){ return clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14), 0.0, 1.0); }",
		"void main(){",
		"  vec3 N = normalize(vN);",
		"  vec3 V = normalize(uAuge - vP);",
		"  float NdV = max(dot(N, V), 1e-4);",
		"  vec3 Rf = reflect(-V, N);",
		"  vec4 tex = uTexAn > 0.5 ? texture2D(uTex, vUv) : vec4(uFarbe, 1.0);",
		// Leinwandtexturen und Farbangaben stehen in sRGB, die Beleuchtung
		// rechnet linear und codiert am Ende zurueck. Bei Textur wird zusaetzlich
		// mit uFarbe eingefaerbt - dieselbe Zielflaeche wird so rot oder orange.
		"  vec3 basis = pow(uTexAn > 0.5 ? tex.rgb * uFarbe : uFarbe, vec3(2.2));",
		// Kuppellicht aus der vorberechneten Bestrahlungskarte
		"  vec3 kuppel = hdr(textureCube(uKuppel, N));",
		// Voll angesetzt. Die Daempfung sitzt jetzt in der Belichtung der
		// Umgebungskarte (siehe tmp/baue_umgebung.js) - an einer Stelle statt an
		// zweien, sonst korrigiert man beim Nachstellen gegen sich selbst.
		"  vec3 diff = basis * kuppel * (1.0 - uMetall);",
		// Spiegelung; rauere Flaechen greifen auf unschaerfere Mipmaps
		"  vec3 spiegel = hdr(textureCube(uEnv, Rf, uRauheit * 7.0));",
		"  vec3 F0 = mix(vec3(0.045), basis, uMetall);",
		"  vec3 F = F0 + (max(vec3(1.0 - uRauheit), F0) - F0) * pow(1.0 - NdV, 5.0);",
		"  vec3 spek = spiegel * F;",
		// Ein warmes Fuehrungslicht bleibt zusaetzlich: die Kuppel allein macht
		// keine harten Glanzpunkte, und ohne die liest sich keine Rundung.
		"  vec3 L1 = normalize(vec3(-0.25, 0.90, 0.36));",
		"  vec3 H = normalize(L1 + V);",
		"  float NdL = max(dot(N, L1), 0.0);",
		"  float a2 = max(uRauheit * uRauheit, 0.0016); a2 = a2 * a2;",
		"  float nh = max(dot(N, H), 0.0);",
		"  float d = nh * nh * (a2 - 1.0) + 1.0;",
		"  float ggx = a2 / (3.14159 * d * d + 1e-6);",
		"  vec3 c = diff + spek",
		"         + vec3(1.00, 0.90, 0.74) * NdL * (basis * (1.0 - uMetall) * 0.14 + F0 * ggx * 1.1);",
		"  for (int i = 0; i < 6; i++) {",
		"    if (i >= uLampN) break;",
		"    vec3 dl = uLampP[i] - vP;",
		"    float q = dot(dl, dl);",
		"    vec3 Ld = dl * inversesqrt(max(q, 1e-6));",
		"    float abfall = 1.0 / (1.0 + 900.0 * q);",
		"    float lam = max(dot(N, Ld), 0.0) * 0.75 + 0.25;",
		"    c += (basis * 0.6 + 0.4) * uLampC[i] * lam * abfall;",
		"  }",
		// Neutral, nicht gruenstichig: der feste Farbvektor von frueher legte
		// einen gelbgruenen Schleier ueber alles, was ein wenig leuchtet -
		// am deutlichsten ueber die Scheibe des Kopfstuecks.
		"  c += uLeucht * (basis * 1.6 + vec3(0.22));",
		// Belichtung. Nachgerechnet an der Grundfarbe des Bretts: bei 0.85
		// kommt #252937 als RGB 46/49/71 heraus, also als das dunkle Blau,
		// das es sein soll.
		"  c = kurve(c * 0.85);",
		"  gl_FragColor = vec4(pow(c, vec3(0.4545)), uAlpha * (uTexAn > 0.5 ? tex.a : 1.0));",
		"}"
	].join("\n");

	// Einfaches Programm fuer den Schatten unter der Kugel
	var VS_S = ["attribute vec3 aPos; attribute vec2 aUv;",
	            "uniform mat4 uMVP; varying vec2 vUv;",
	            "void main(){ vUv = aUv; gl_Position = uMVP * vec4(aPos,1.0); }"].join("\n");
	var FS_S = ["precision mediump float; varying vec2 vUv;",
	            "uniform sampler2D uTex; uniform float uStaerke;",
	            "void main(){ gl_FragColor = vec4(0.0,0.0,0.0, texture2D(uTex,vUv).a * uStaerke); }"].join("\n");
	// Lampen: dieselbe Geometrie wie der Schatten, aber additiv und eingefaerbt.
	var FS_L = ["precision mediump float; varying vec2 vUv;",
	            "uniform sampler2D uTex; uniform vec3 uFarbe; uniform float uStaerke;",
	            "void main(){ float a = texture2D(uTex,vUv).a * uStaerke;",
	            "  gl_FragColor = vec4(uFarbe * a, a); }"].join("\n");

	function baueProgramm(vs, fs) {
		function sh(typ, q) {
			var s = gl.createShader(typ); gl.shaderSource(s, q); gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
			return s;
		}
		var p = gl.createProgram();
		gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
		gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
		return p;
	}

	var prog = baueProgramm(VS, FS), progS = baueProgramm(VS_S, FS_S);
	var progL = baueProgramm(VS_S, FS_L);
	var A = { pos: gl.getAttribLocation(prog, "aPos"), nrm: gl.getAttribLocation(prog, "aNrm"),
	          uv: gl.getAttribLocation(prog, "aUv") };
	var U = {};
	["uMVP","uModell","uNormM","uTex","uFarbe","uAuge","uTexAn","uRauheit","uLeucht","uMetall",
	 "uAlpha","uLampN","uUvFeld","uEnv","uKuppel"]
		.forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
	U.uLampP = gl.getUniformLocation(prog, "uLampP");
	U.uLampC = gl.getUniformLocation(prog, "uLampC");
	var AS = { pos: gl.getAttribLocation(progS, "aPos"), uv: gl.getAttribLocation(progS, "aUv") };
	var US = { mvp: gl.getUniformLocation(progS, "uMVP"), tex: gl.getUniformLocation(progS, "uTex"),
	           staerke: gl.getUniformLocation(progS, "uStaerke") };
	var AL = { pos: gl.getAttribLocation(progL, "aPos"), uv: gl.getAttribLocation(progL, "aUv") };
	var UL = { mvp: gl.getUniformLocation(progL, "uMVP"), tex: gl.getUniformLocation(progL, "uTex"),
	           farbe: gl.getUniformLocation(progL, "uFarbe"),
	           staerke: gl.getUniformLocation(progL, "uStaerke") };

	// ------------------------------------------------------------- Netze
	function Netz(pos, nrm, uv, idx) {
		this.n = idx.length;
		this.gross = pos.length / 3 > 65535;
		if (this.gross && !gl.getExtension("OES_element_index_uint")) {
			throw new Error("Netz zu gross fuer 16-Bit-Indizes");
		}
		function puffer(daten, Typ, ziel) {
			var b = gl.createBuffer();
			gl.bindBuffer(ziel, b);
			gl.bufferData(ziel, new Typ(daten), gl.STATIC_DRAW);
			return b;
		}
		this.bPos = puffer(pos, Float32Array, gl.ARRAY_BUFFER);
		this.bNrm = puffer(nrm, Float32Array, gl.ARRAY_BUFFER);
		this.bUv  = puffer(uv,  Float32Array, gl.ARRAY_BUFFER);
		this.bIdx = puffer(idx, this.gross ? Uint32Array : Uint16Array, gl.ELEMENT_ARRAY_BUFFER);
	}
	Netz.prototype.zeichne = function (attr) {
		gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos);
		gl.enableVertexAttribArray(attr.pos); gl.vertexAttribPointer(attr.pos, 3, gl.FLOAT, false, 0, 0);
		if (attr.nrm !== undefined && attr.nrm >= 0) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.bNrm);
			gl.enableVertexAttribArray(attr.nrm); gl.vertexAttribPointer(attr.nrm, 3, gl.FLOAT, false, 0, 0);
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, this.bUv);
		gl.enableVertexAttribArray(attr.uv); gl.vertexAttribPointer(attr.uv, 2, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
		gl.drawElements(gl.TRIANGLES, this.n, this.gross ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
	};

	// ============================================================ Bausteine
	/*
	 * Drehkoerper aus einem Profil. Das Profil laeuft von unten nach oben als
	 * [Radius, Hoehe]-Paare; gedreht wird um die Tischnormale. Damit entstehen
	 * Bumper, Posten, Knaeufe und Kappen aus einer einzigen Funktion - jedes
	 * dieser Teile von Hand zu schreiben waere nur mehr Gelegenheit fuer Fehler.
	 */
	function drehkoerper(profil, seiten, opt) {
		opt = opt || {};
		var pos = [], nrm = [], uv = [], idx = [], i, k;
		// Normale je Profilpunkt aus den angrenzenden Abschnitten mitteln
		var n2 = [];
		for (i = 0; i < profil.length; i++) {
			var vx = 0, vy = 0;
			if (i > 0) {
				var dr = profil[i][0] - profil[i-1][0], dh = profil[i][1] - profil[i-1][1];
				var l = Math.hypot(dr, dh) || 1; vx += dh / l; vy += -dr / l;
			}
			if (i < profil.length - 1) {
				var dr2 = profil[i+1][0] - profil[i][0], dh2 = profil[i+1][1] - profil[i][1];
				var l2 = Math.hypot(dr2, dh2) || 1; vx += dh2 / l2; vy += -dr2 / l2;
			}
			var ln = Math.hypot(vx, vy) || 1;
			n2.push([vx / ln, vy / ln]);
		}
		for (i = 0; i < profil.length; i++) {
			for (k = 0; k <= seiten; k++) {
				var t = k / seiten * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
				pos.push(profil[i][0] * c, profil[i][1], profil[i][0] * s);
				nrm.push(n2[i][0] * c, n2[i][1], n2[i][0] * s);
				uv.push(k / seiten, i / (profil.length - 1));
			}
		}
		var breit = seiten + 1;
		for (i = 0; i < profil.length - 1; i++) {
			for (k = 0; k < seiten; k++) {
				var a = i * breit + k, b = a + 1, c2 = a + breit, d = c2 + 1;
				idx.push(a, c2, d, a, d, b);
			}
		}
		// Deckel unten und oben, wenn das Profil dort nicht auf null laeuft
		function deckel(hoehe, radius, richtung) {
			if (radius <= 1e-6) return;
			var basis = pos.length / 3;
			pos.push(0, hoehe, 0); nrm.push(0, richtung, 0); uv.push(0.5, 0.5);
			for (k = 0; k <= seiten; k++) {
				var t2 = k / seiten * Math.PI * 2;
				pos.push(radius * Math.cos(t2), hoehe, radius * Math.sin(t2));
				nrm.push(0, richtung, 0);
				uv.push(0.5 + 0.5 * Math.cos(t2), 0.5 + 0.5 * Math.sin(t2));
			}
			for (k = 0; k < seiten; k++) {
				if (richtung > 0) idx.push(basis, basis + 1 + k, basis + 2 + k);
				else idx.push(basis, basis + 2 + k, basis + 1 + k);
			}
		}
		if (opt.unten !== false) deckel(profil[0][1], profil[0][0], -1);
		if (opt.oben !== false) deckel(profil[profil.length-1][1], profil[profil.length-1][0], 1);
		return new Netz(pos, nrm, uv, idx);
	}

	// Gummiring - fuer Posten und Flipper
	function ringkoerper(gross, klein, hoehe, nG, nK) {
		var pos = [], nrm = [], uv = [], idx = [], i, k;
		for (i = 0; i <= nG; i++) {
			var u = i / nG * Math.PI * 2, cu = Math.cos(u), su = Math.sin(u);
			for (k = 0; k <= nK; k++) {
				var v = k / nK * Math.PI * 2, cv = Math.cos(v), sv = Math.sin(v);
				pos.push((gross + klein * cv) * cu, hoehe + klein * sv, (gross + klein * cv) * su);
				nrm.push(cv * cu, sv, cv * su);
				uv.push(i / nG, k / nK);
			}
		}
		for (i = 0; i < nG; i++) for (k = 0; k < nK; k++) {
			var a = i * (nK + 1) + k, b = a + 1, c = a + nK + 1, d = c + 1;
			idx.push(a, c, d, a, d, b);
		}
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Prisma aus einem geschlossenen Umriss: Mantel plus Deckel. Damit entstehen
	 * Flipper, Fallziele, Slingshot-Koerper und die Blende - alles, was eine
	 * flache Grundflaeche und eine feste Hoehe hat.
	 */
	/*
	 * Flaeche eines geschlossenen Umrisses mit Vorzeichen. Sie sagt, in welche
	 * Richtung der Umriss laeuft - und davon haengt ab, wohin die Aussenseite
	 * zeigt. Beide Prisma-Funktionen richten den Umlaufsinn damit selbst; sich
	 * auf den Aufrufer zu verlassen ging schief, sobald ein Koerper gespiegelt
	 * wurde: die gespiegelte Haelfte war dann von aussen unsichtbar.
	 */
	function flaecheMitVorzeichen(u) {
		var f = 0;
		for (var i = 0; i < u.length; i++) {
			var j = (i + 1) % u.length;
			f += u[i][0] * u[j][1] - u[j][0] * u[i][1];
		}
		return f / 2;
	}

	function prisma(umriss, unten, oben, opt) {
		opt = opt || {};
		// Der Umriss liegt in der lokalen xz-Ebene, hochgezogen wird nach +y.
		// Damit der Deckel nach oben zeigt, muss die Flaeche negativ sein.
		if (flaecheMitVorzeichen(umriss) > 0) umriss = umriss.slice().reverse();
		var pos = [], nrm = [], uv = [], idx = [], i, n = umriss.length;
		for (i = 0; i < n; i++) {
			var p = umriss[i], q = umriss[(i + 1) % n];
			var dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
			var nx = -dz / l, nz = dx / l;
			var b = pos.length / 3;
			[[p, unten, 0, 0], [q, unten, 1, 0], [q, oben, 1, 1], [p, oben, 0, 1]]
				.forEach(function (e) {
					pos.push(e[0][0], e[1], e[0][1]); nrm.push(nx, 0, nz); uv.push(e[2], e[3]);
				});
			idx.push(b, b+1, b+2, b, b+2, b+3);
		}
		// Deckel als Faecher vom Schwerpunkt - die Umrisse sind alle konvex
		function kappe(hoehe, richtung) {
			var mx = 0, mz = 0;
			umriss.forEach(function (p2) { mx += p2[0]; mz += p2[1]; });
			mx /= n; mz /= n;
			var b2 = pos.length / 3;
			pos.push(mx, hoehe, mz); nrm.push(0, richtung, 0); uv.push(0.5, 0.5);
			for (i = 0; i < n; i++) {
				pos.push(umriss[i][0], hoehe, umriss[i][1]);
				nrm.push(0, richtung, 0); uv.push(i / n, 0);
			}
			for (i = 0; i < n; i++) {
				var j = (i + 1) % n;
				if (richtung > 0) idx.push(b2, b2 + 1 + i, b2 + 1 + j);
				else idx.push(b2, b2 + 1 + j, b2 + 1 + i);
			}
		}
		if (opt.oben !== false) kappe(oben, 1);
		if (opt.unten !== false) kappe(unten, -1);
		return new Netz(pos, nrm, uv, idx);
	}

	// Rohr entlang eines Linienzugs - fuer Banden und Gummis
	function rohrEntlangZug(pos, nrm, uv, idx, punkte, R, seiten, hoehe) {
		var n = punkte.length, ringe = [], i, k, H0 = hoehe || 0;
		for (i = 0; i < n; i++) {
			var vor = punkte[Math.max(0, i - 1)], nach = punkte[Math.min(n - 1, i + 1)];
			var dx = nach[0] - vor[0], dy = nach[1] - vor[1], l = Math.hypot(dx, dy) || 1;
			ringe.push({ p: punkte[i], t: [dx / l, dy / l] });
		}
		for (i = 0; i < n; i++) {
			var r = ringe[i], qx = -r.t[1], qy = r.t[0], b = pos.length / 3;
			for (k = 0; k <= seiten; k++) {
				var a = k / seiten * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
				var ox = qx * R * ca, oy = qy * R * ca, oh = R * sa;
				var wp = welt(r.p[0] + ox, r.p[1] + oy, H0 + R + oh);
				var wn = weltRichtung(qx * ca, qy * ca, sa);
				pos.push(wp[0], wp[1], wp[2]); nrm.push(wn[0], wn[1], wn[2]);
				uv.push(i / (n - 1), k / seiten);
			}
			if (i > 0) {
				var vorB = b - (seiten + 1);
				for (k = 0; k < seiten; k++) idx.push(vorB+k, b+k, b+k+1, vorB+k, b+k+1, vorB+k+1);
			}
		}
		// Halbkugeln als Abschluss
		[[0, -1], [n - 1, 1]].forEach(function (kap) {
			var r2 = ringe[kap[0]], vz = kap[1], b2 = pos.length / 3, ri, kk;
			var qx2 = -r2.t[1], qy2 = r2.t[0];
			for (ri = 0; ri <= 4; ri++) {
				var phi = ri / 4 * Math.PI / 2;
				for (kk = 0; kk <= seiten; kk++) {
					var aa = kk / seiten * Math.PI * 2;
					var rr = Math.cos(phi), tt = Math.sin(phi) * vz;
					var lx = qx2 * rr * Math.cos(aa) + r2.t[0] * tt;
					var ly = qy2 * rr * Math.cos(aa) + r2.t[1] * tt;
					var lh = rr * Math.sin(aa);
					var wp2 = welt(r2.p[0] + lx * R, r2.p[1] + ly * R, H0 + R + lh * R);
					var wn2 = weltRichtung(lx, ly, lh);
					pos.push(wp2[0], wp2[1], wp2[2]); nrm.push(wn2[0], wn2[1], wn2[2]);
					uv.push(ri / 4, kk / seiten);
				}
			}
			for (ri = 0; ri < 4; ri++) for (kk = 0; kk < seiten; kk++) {
				var a2 = b2 + ri*(seiten+1) + kk, b3 = a2+1, c2 = a2+seiten+1, d2 = c2+1;
				if (vz > 0) idx.push(a2, c2, d2, a2, d2, b3);
				else idx.push(a2, d2, c2, a2, b3, d2);
			}
		});
	}

	// Zusammenhaengende Segmente zu Linienzuegen verketten. Wuerde jedes Segment
	// als eigene Kapsel gezeichnet, schnuerte die Bande an jedem Gelenk ein und
	// der Bogen oben saehe aus wie eine Perlenkette.
	function verketteSegmente(liste) {
		var offen = liste.slice(), zuege = [];
		function gleich(p, q) { return Math.abs(p[0]-q[0]) < 1e-6 && Math.abs(p[1]-q[1]) < 1e-6; }
		while (offen.length) {
			var s = offen.shift();
			var zug = { punkte: [s.a, s.b], r: s.r, art: s.art };
			var weiter = true;
			while (weiter) {
				weiter = false;
				for (var i = 0; i < offen.length; i++) {
					var t = offen[i];
					if (t.r !== zug.r || t.art !== zug.art) continue;
					var letzte = zug.punkte[zug.punkte.length - 1], erste = zug.punkte[0];
					if (gleich(t.a, letzte))      { zug.punkte.push(t.b); }
					else if (gleich(t.b, letzte)) { zug.punkte.push(t.a); }
					else if (gleich(t.b, erste))  { zug.punkte.unshift(t.a); }
					else if (gleich(t.a, erste))  { zug.punkte.unshift(t.b); }
					else continue;
					offen.splice(i, 1); weiter = true; break;
				}
			}
			zuege.push(zug);
		}
		return zuege;
	}

	// ========================================================= Tischmodelle
	function baueSpielfeldNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var n = weltRichtung(0, 0, 1);
		[[-FELD_XR, FELD_Y0, 0, 1], [FELD_XR, FELD_Y0, 1, 1],
		 [ FELD_XR, FELD_Y1, 1, 0], [-FELD_XR, FELD_Y1, 0, 0]].forEach(function (e) {
			var w = welt(e[0], e[1], 0);
			pos.push(w[0],w[1],w[2]); nrm.push(n[0],n[1],n[2]); uv.push(e[2], e[3]);
		});
		idx.push(0,1,2, 0,2,3);
		return new Netz(pos, nrm, uv, idx);
	}

	function baueBandenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		verketteSegmente(SEG.filter(function (s) { return s.art === "wand"; }))
			.forEach(function (zug) {
				rohrEntlangZug(pos, nrm, uv, idx, zug.punkte, zug.r, 14);
			});
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Flipperumriss: die konvexe Huelle zweier Kreise - genau die Form eines
	 * echten Flipperfingers. Die Physik rechnet mit einer Kapsel konstanten
	 * Radius; sichtbar wird die Verjuengung zur Spitze.
	 */
	function flipperUmriss(laenge, r1, r2, n) {
		var al = Math.asin((r1 - r2) / laenge);
		var a1 = Math.PI / 2 + al, punkte = [], k;
		for (k = 0; k <= n; k++) {
			var t = a1 + (2 * Math.PI - 2 * a1) * k / n;
			punkte.push([Math.cos(t) * r1, Math.sin(t) * r1]);
		}
		for (k = 0; k <= n; k++) {
			var t2 = -a1 + 2 * a1 * k / n;
			punkte.push([laenge + Math.cos(t2) * r2, Math.sin(t2) * r2]);
		}
		return punkte;
	}

	function baueApronNetz() {
		// Die Blende unten: eine geneigte Blechplatte, die den Abfluss verdeckt
		var pos = [], nrm = [], uv = [], idx = [];
		var kanten = [[-W + 0.004, 0.052, 0.004], [SCHACHT_X - 0.004, 0.052, 0.004],
		              [SCHACHT_X - 0.030, -0.055, 0.030], [-W + 0.030, -0.055, 0.030]];
		var w = kanten.map(function (e) { return welt(e[0], e[1], e[2]); });
		var ux = [w[1][0]-w[0][0], w[1][1]-w[0][1], w[1][2]-w[0][2]];
		var uy = [w[3][0]-w[0][0], w[3][1]-w[0][1], w[3][2]-w[0][2]];
		var n = [ux[1]*uy[2]-ux[2]*uy[1], ux[2]*uy[0]-ux[0]*uy[2], ux[0]*uy[1]-ux[1]*uy[0]];
		var ln = Math.hypot(n[0],n[1],n[2]) || 1;
		w.forEach(function (p, i) {
			pos.push(p[0], p[1], p[2]); nrm.push(n[0]/ln, n[1]/ln, n[2]/ln);
			uv.push(i === 1 || i === 2 ? 1 : 0, i > 1 ? 1 : 0);
		});
		idx.push(0,1,2, 0,2,3);
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Der Schrank. Drei Waende - links, rechts, vorn - jede mit Innenseite,
	 * Aussenseite und Holzoberkante als eigene Flaechen mit eigener Normale.
	 *
	 * Die alte Fassung gab allen Flaechen die Normale (0,1,0). Die Waende wurden
	 * dadurch beleuchtet wie ein Fussboden und sahen aus wie Pappe; dazu waren
	 * sie nur 34 mm hoch statt bis unter die Glasleiste. Jetzt reichen sie bis
	 * 93 mm, die Chromleiste sitzt direkt auf der Holzkante.
	 */
	var SCHRANK_D = 0.034, SCHRANK_H0 = -0.060, SCHRANK_H1 = 0.093;
	var SCHRANK_Y0 = -0.090, SCHRANK_Y1 = L + 0.060;

	/*
	 * Holz wird in Metern angesetzt. Die Kachel ist je Flaeche so gewaehlt, dass
	 * quer zur schmalen Seite ein guter Teil der Textur sichtbar wird: bei
	 * 30 cm zeigte die 34 mm breite Kante nur 11 % der Textur - ein einziges
	 * Farbband, keine Maserung. Mit 10 cm ist es ein Drittel.
	 */
	var HOLZ_KACHEL_KANTE = 0.10, HOLZ_KACHEL_RINNE = 0.16;
	// Leder auf den Innenwaenden: 20 cm Kachel, die Wand ist 15 cm hoch - so
	// ist die Narbung in voller Groesse zu sehen.
	var LEDER_KACHEL = 0.20;

	function baueSchrankNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var K = { pos: [], nrm: [], uv: [], idx: [] };   // Holzkanten, eigenes Netz
		var I = { pos: [], nrm: [], uv: [], idx: [] };   // Innenwaende, Leder
		var F = window.SCHRANK_FELD;

		// Vier Tischpunkte [x, y, h], Normale in Tischrichtung, Ausschnitt und
		// je Ecke (fu, fv) im Ausschnitt. Der Umlaufsinn wird an der Normalen
		// gerichtet - sonst schneidet die Rueckseitenentfernung die Flaeche weg.
		function flaeche(ecken, n, feld, fuv) {
			var wn = weltRichtung(n[0], n[1], n[2]);
			var w = ecken.map(function (e) { return welt(e[0], e[1], e[2]); });
			var ax = w[1][0]-w[0][0], ay = w[1][1]-w[0][1], az = w[1][2]-w[0][2];
			var bx = w[2][0]-w[0][0], by = w[2][1]-w[0][1], bz = w[2][2]-w[0][2];
			var gx = ay*bz - az*by, gy = az*bx - ax*bz, gz = ax*by - ay*bx;
			var reihenfolge = (gx*wn[0] + gy*wn[1] + gz*wn[2]) >= 0 ? [0,1,2,3] : [0,3,2,1];
			var basis = pos.length / 3;
			reihenfolge.forEach(function (i) {
				pos.push(w[i][0], w[i][1], w[i][2]);
				nrm.push(wn[0], wn[1], wn[2]);
				uv.push(feld[0] + fuv[i][0] * feld[2], feld[1] + fuv[i][1] * feld[3]);
			});
			idx.push(basis, basis+1, basis+2, basis, basis+2, basis+3);
		}
		/*
		 * Holzflaeche: Texturkoordinaten in Metern statt 0..1. Vorher lagen 1024
		 * Bildpunkte auf 1,3 m Laenge, aber 64 auf 34 mm Breite - die Maserung
		 * wurde laengs um das 2,4-fache gestreckt. Jetzt ist die Kachel ueberall
		 * 30 cm gross, egal wie lang oder breit die Flaeche ist.
		 */
		function holzflaeche(ecken, n) {
			var wn = weltRichtung(n[0], n[1], n[2]);
			var w = ecken.map(function (e) { return welt(e[0], e[1], e[2]); });
			var ax = w[1][0]-w[0][0], ay = w[1][1]-w[0][1], az = w[1][2]-w[0][2];
			var bx = w[2][0]-w[0][0], by = w[2][1]-w[0][1], bz = w[2][2]-w[0][2];
			var gx = ay*bz - az*by, gy = az*bx - ax*bz, gz = ax*by - ay*bx;
			var reihenfolge = (gx*wn[0] + gy*wn[1] + gz*wn[2]) >= 0 ? [0,1,2,3] : [0,3,2,1];
			var basis = K.pos.length / 3;
			reihenfolge.forEach(function (i) {
				K.pos.push(w[i][0], w[i][1], w[i][2]);
				K.nrm.push(wn[0], wn[1], wn[2]);
				K.uv.push(ecken[i][1] / HOLZ_KACHEL_KANTE, ecken[i][0] / HOLZ_KACHEL_KANTE);
			});
			K.idx.push(basis, basis+1, basis+2, basis, basis+2, basis+3);
		}
		/*
		 * Lederflaeche: wie holzflaeche, aber die Koordinaten laufen laengs der
		 * Wand (y oder x) und die Hoehe (h) - in Metern, damit die Narbung auf
		 * allen Waenden gleich gross ist.
		 */
		function lederflaeche(ecken, n, laengs) {
			var wn = weltRichtung(n[0], n[1], n[2]);
			var w = ecken.map(function (e) { return welt(e[0], e[1], e[2]); });
			var ax = w[1][0]-w[0][0], ay = w[1][1]-w[0][1], az = w[1][2]-w[0][2];
			var bx = w[2][0]-w[0][0], by = w[2][1]-w[0][1], bz = w[2][2]-w[0][2];
			var gx = ay*bz - az*by, gy = az*bx - ax*bz, gz = ax*by - ay*bx;
			var reihenfolge = (gx*wn[0] + gy*wn[1] + gz*wn[2]) >= 0 ? [0,1,2,3] : [0,3,2,1];
			var basis = I.pos.length / 3;
			reihenfolge.forEach(function (i) {
				I.pos.push(w[i][0], w[i][1], w[i][2]);
				I.nrm.push(wn[0], wn[1], wn[2]);
				I.uv.push(ecken[i][laengs] / LEDER_KACHEL, ecken[i][2] / LEDER_KACHEL);
			});
			I.idx.push(basis, basis+1, basis+2, basis, basis+2, basis+3);
		}
		var Y0 = SCHRANK_Y0, Y1 = SCHRANK_Y1, H0 = SCHRANK_H0, H1 = SCHRANK_H1, D = SCHRANK_D;
		var LAENGE = Y1 - Y0;

		// Seitenwaende
		[-1, 1].forEach(function (seite) {
			var xi = seite * W, xo = seite * (W + D);
			// Innenseite - zum Feld hin, Leder
			lederflaeche([[xi, Y0, H0], [xi, Y1, H0], [xi, Y1, H1], [xi, Y0, H1]], [-seite, 0, 0], 1);
			// Aussenseite mit der Seitengrafik. Links gespiegelt, damit die
			// Schrift von vorn lesbar bleibt.
			var l = seite < 0 ? [[1, 1], [0, 1], [0, 0], [1, 0]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
			flaeche([[xo, Y0, H0], [xo, Y1, H0], [xo, Y1, H1], [xo, Y0, H1]],
					[seite, 0, 0], F.aussen, l);
			// Holzkante oben
			holzflaeche([[xo, Y0, H1], [xo, Y1, H1], [xi, Y1, H1], [xi, Y0, H1]], [0, 0, 1]);
			// Stirnseite hinten (am Kopfstueck)
			lederflaeche([[xo, Y1, H0], [xi, Y1, H0], [xi, Y1, H1], [xo, Y1, H1]], [0, 1, 0], 0);
		});

		// Vorderwand
		var xa = -(W + D), xb = W + D, yv = Y0, yh = Y0 + D;
		flaeche([[xa, yv, H0], [xb, yv, H0], [xb, yv, H1], [xa, yv, H1]],
				[0, -1, 0], F.front, [[0, 1], [1, 1], [1, 0], [0, 0]]);
		lederflaeche([[xa, yh, H0], [xb, yh, H0], [xb, yh, H1], [xa, yh, H1]], [0, 1, 0], 0);
		holzflaeche([[xa, yv, H1], [xb, yv, H1], [xb, yh, H1], [xa, yh, H1]], [0, 0, 1]);

		return { wand: new Netz(pos, nrm, uv, idx), kante: new Netz(K.pos, K.nrm, K.uv, K.idx),
				 innen: new Netz(I.pos, I.nrm, I.uv, I.idx) };
	}

	/*
	 * Modellmatrix fuer Teile, die seitlich aus der Wand ragen - die
	 * Flipperknoepfe. Lokal y zeigt nach aussen (Tisch-x), lokal x den Tisch
	 * hinauf, lokal z ergibt sich als Kreuzprodukt, damit es eine Drehung ist.
	 */
	function seitwaerts(x, y, h, seite) {
		var c1 = [seite, 0, 0];
		var c0 = weltRichtung(0, 1, 0);
		var c2 = [c0[1]*c1[2] - c0[2]*c1[1], c0[2]*c1[0] - c0[0]*c1[2], c0[0]*c1[1] - c0[1]*c1[0]];
		var o = ident(m4());
		o[0] = c0[0]; o[1] = c0[1]; o[2]  = c0[2];
		o[4] = c1[0]; o[5] = c1[1]; o[6]  = c1[2];
		o[8] = c2[0]; o[9] = c2[1]; o[10] = c2[2];
		var wp = welt(x, y, h);
		o[12] = wp[0]; o[13] = wp[1]; o[14] = wp[2];
		return o;
	}

	function baueKugelNetz(r, ringe, seiten) {
		var pos = [], nrm = [], uv = [], idx = [], i, k;
		for (i = 0; i <= ringe; i++) {
			var phi = i / ringe * Math.PI;
			for (k = 0; k <= seiten; k++) {
				var th = k / seiten * Math.PI * 2;
				var x = Math.sin(phi)*Math.cos(th), y = Math.cos(phi), z = Math.sin(phi)*Math.sin(th);
				pos.push(x*r, y*r, z*r); nrm.push(x, y, z); uv.push(k/seiten, i/ringe);
			}
		}
		for (i = 0; i < ringe; i++) for (k = 0; k < seiten; k++) {
			var a = i*(seiten+1)+k, b = a+1, c = a+seiten+1, d = c+1;
			idx.push(a, c, d, a, d, b);
		}
		return new Netz(pos, nrm, uv, idx);
	}

	function baueSchattenNetz() {
		var pos = [], uv = [], idx = [], nrm = [];
		var s = KUGEL_R * 2.6;
		[[-s,-s,0,0],[s,-s,1,0],[s,s,1,1],[-s,s,0,1]].forEach(function (e) {
			var w = welt(e[0], e[1], 0.0008);
			pos.push(w[0],w[1],w[2]); nrm.push(0,1,0); uv.push(e[2], e[3]);
		});
		idx.push(0,1,2, 0,2,3);
		return { netz: new Netz(pos, nrm, uv, idx), halb: s };
	}

	var GLAS_HALB = W + 0.030, GLAS_HOCH = 0.335, GLAS_KIPP = 0.16;

	function baueBackglasNetz(halbB, hoehe, tiefer) {
		// Steht aufrecht am Kopfende, leicht nach hinten gekippt. In
		// Weltkoordinaten gebaut: die Scheibe folgt der Feldneigung gerade NICHT.
		var fuss = welt(0, L + 0.055, 0.016);
		var c = Math.cos(GLAS_KIPP), si = Math.sin(GLAS_KIPP);
		var auf = [0, c, -si], n = [0, si, c];
		var pos = [], nrm = [], uv = [], idx = [];
		var mitte = [fuss[0] - n[0]*tiefer, fuss[1] - n[1]*tiefer, fuss[2] - n[2]*tiefer];
		[[-halbB, 0, 0, 1], [halbB, 0, 1, 1], [halbB, hoehe, 1, 0], [-halbB, hoehe, 0, 0]]
			.forEach(function (e) {
				pos.push(mitte[0] + e[0], mitte[1] + auf[1]*e[1], mitte[2] + auf[2]*e[1]);
				nrm.push(n[0], n[1], n[2]);
				uv.push(e[2], e[3]);
			});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Boden unter dem Geraet - eine grosse Platte tief unter dem Schrank. Sie
	 * traegt den Kontaktschatten als dunklen Fleck in der Textur, damit das
	 * Geraet steht und nicht schwebt.
	 */
	var BODEN_Y = -0.78;
	function baueBodenNetz() {
		var pos = [], nrm = [], uv = [], idx = [], S = 3.0;
		[[-S, -S, 0, 0], [S, -S, 1, 0], [S, S, 1, 1], [-S, S, 0, 1]].forEach(function (e) {
			pos.push(e[0], BODEN_Y, e[1]); nrm.push(0, 1, 0); uv.push(e[2], e[3]);
		});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}
	function zeichneBodenbild() {
		// Schattenfleck unter dem Schrank, weich auslaufend
		var N = 256, cv = document.createElement("canvas");
		cv.width = cv.height = N;
		var g = cv.getContext("2d");
		g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, N, N);
		var rg = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.34);
		rg.addColorStop(0.00, "rgba(0,0,0,0.78)");
		rg.addColorStop(0.55, "rgba(0,0,0,0.40)");
		rg.addColorStop(1.00, "rgba(0,0,0,0.00)");
		g.save(); g.translate(N / 2, N / 2); g.scale(0.55, 1.15); g.translate(-N / 2, -N / 2);
		g.fillStyle = rg; g.fillRect(0, 0, N, N);
		g.restore();
		return cv;
	}

	// Verschiebung ohne Drehung - fuer Teile, die senkrecht im Raum stehen
	function verschiebung(x, y, z) {
		var o = ident(m4());
		o[12] = x; o[13] = y; o[14] = z;
		return o;
	}

	// Rinne: eigenes Netz mit der Holztextur, Koordinaten in Metern. Die
	// Maserung laeuft laengs der Rinne, wie bei einem echten Holzbrett.
	function baueRinnenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var n = weltRichtung(0, 0, 1);
		var x0 = SCHACHT_X + 0.003, x1 = W - 0.002, ya = -0.02, yb = BOGEN_Y + 0.02;
		[[x0, ya], [x1, ya], [x1, yb], [x0, yb]].forEach(function (e) {
			var w = welt(e[0], e[1], 0.0006);
			pos.push(w[0], w[1], w[2]); nrm.push(n[0], n[1], n[2]);
			uv.push(e[1] / HOLZ_KACHEL_RINNE, e[0] / HOLZ_KACHEL_RINNE);
		});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}

	// Glasscheibe ueber dem Feld. Nur Spiegelung, kein Koerper.
	var GLAS_H = 0.108;
	function baueScheibenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var n = weltRichtung(0, 0, 1), xr = W + 0.028;
		[[-xr, -0.075], [xr, -0.075], [xr, L + 0.075], [-xr, L + 0.075]].forEach(function (e) {
			var w = welt(e[0], e[1], GLAS_H);
			pos.push(w[0], w[1], w[2]); nrm.push(n[0], n[1], n[2]); uv.push(0, 0);
		});
		idx.push(0, 1, 2, 0, 2, 3);
		return new Netz(pos, nrm, uv, idx);
	}

	// Chromleisten: Seitenleisten und der Riegel vorn, auf Glashoehe
	function baueLeistenNetz() {
		var pos = [], nrm = [], uv = [], idx = [];
		var xr = W + SCHRANK_D / 2;
		rohrEntlangZug(pos, nrm, uv, idx, [[-xr, -0.075], [-xr, L + 0.06]], 0.009, 12, SCHRANK_H1 - 0.009);
		rohrEntlangZug(pos, nrm, uv, idx, [[ xr, -0.075], [ xr, L + 0.06]], 0.009, 12, SCHRANK_H1 - 0.009);
		// Riegel vorn: dicker, leicht tiefer
		rohrEntlangZug(pos, nrm, uv, idx, [[-xr - 0.006, -0.082], [xr + 0.006, -0.082]], 0.014, 14, GLAS_H - 0.012);
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Flache Platte in der Feldebene mit planaren Texturkoordinaten auf der
	 * Oberseite. Umriss und uv kommen aus spielfeld.js (slingPlatte: die
	 * Bounding-Box des Umrisses auf 0..1) - teileKunst zeichnet den Druck in
	 * dieselben uv, so passt er zur Form. `spiegeln` dreht u um, damit die
	 * gespiegelte rechte Platte dieselbe Grafik zeigt. Die Seiten zeigen auf
	 * (0,0) des Ausschnitts - dort liegt eine neutrale Farbe.
	 */
	function plattenNetz(platte, unten, oben, spiegeln) {
		var umriss = platte.umriss;
		if (flaecheMitVorzeichen(umriss) < 0) umriss = umriss.slice().reverse();
		var pos = [], nrm = [], uv = [], idx = [], i, n = umriss.length;
		for (i = 0; i < n; i++) {
			var p = umriss[i], q = umriss[(i + 1) % n];
			var dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
			var wn = weltRichtung(dy / l, -dx / l, 0);
			var b = pos.length / 3;
			[[p, unten], [q, unten], [q, oben], [p, oben]].forEach(function (e) {
				var w = welt(e[0][0], e[0][1], e[1]);
				pos.push(w[0], w[1], w[2]); nrm.push(wn[0], wn[1], wn[2]); uv.push(0.01, 0.01);
			});
			idx.push(b, b+1, b+2, b, b+2, b+3);
		}
		function tex(q) {
			var t = platte.uv(q);
			return [spiegeln ? 1 - t[0] : t[0], t[1]];
		}
		var mx = 0, my = 0;
		umriss.forEach(function (q) { mx += q[0]; my += q[1]; });
		mx /= n; my /= n;
		var wnO = weltRichtung(0, 0, 1), b2 = pos.length / 3;
		var wm = welt(mx, my, oben), tm = tex([mx, my]);
		pos.push(wm[0], wm[1], wm[2]); nrm.push(wnO[0], wnO[1], wnO[2]); uv.push(tm[0], tm[1]);
		for (i = 0; i < n; i++) {
			var w2 = welt(umriss[i][0], umriss[i][1], oben), t2 = tex(umriss[i]);
			pos.push(w2[0], w2[1], w2[2]); nrm.push(wnO[0], wnO[1], wnO[2]); uv.push(t2[0], t2[1]);
		}
		for (i = 0; i < n; i++) idx.push(b2, b2 + 1 + i, b2 + 1 + ((i + 1) % n));
		return new Netz(pos, nrm, uv, idx);
	}

	/*
	 * Slingshot-Baugruppe wie beim Vorbild: drei Chrompfosten mit
	 * Sechskantmuttern, darum der geschlossene Gummi, obenauf die bedruckte,
	 * hinterleuchtete Platte. Das rote Prisma von vorher war ein Klotz.
	 */
	function baueSlingshot(seite) {
		var SL = T.slingshot;
		function fx(x) { return seite < 0 ? x : 2 * XM - x; }
		var ecken = [[fx(SL.a[0]), SL.a[1]], [fx(SL.b[0]), SL.b[1]], [fx(SL.c[0]), SL.c[1]]];
		var pos = [], nrm = [], uv = [], idx = [];
		rohrEntlangZug(pos, nrm, uv, idx, ecken.concat([ecken[0]]), 0.0045, 10, 0.011);
		// Die Platte ragt etwas ueber die Pfosten hinaus, wie beim Vorbild:
		// Umriss (x1,22, Ecken gerundet) und uv aus spielfeld.js, dieselben,
		// in die teileKunst den Druck legt
		return {
			ecken: ecken,
			gummi: new Netz(pos, nrm, uv, idx),
			platte: plattenNetz(window.slingPlatte(ecken), 0.0265, 0.0295, seite > 0),
			gummiSeg: SEG.filter(function (sg) { return sg.art === "sling"; })[seite < 0 ? 0 : 1] || null
		};
	}

	function baueGlimmNetz() {
		// Einheitsquadrat in der Tischebene. modellFuer() skaliert es je Lampe;
		// die Hoehe kommt aus der Verschiebung und bleibt unskaliert.
		var pos = [], uv = [], idx = [], nrm = [];
		[[-1,-1,0,0],[1,-1,1,0],[1,1,1,1],[-1,1,0,1]].forEach(function (e) {
			pos.push(e[0], 0, e[1]); nrm.push(0,1,0); uv.push(e[2], e[3]);
		});
		idx.push(0,1,2, 0,2,3);
		return new Netz(pos, nrm, uv, idx);
	}

	// --------------------------------------------------------------- Lauf
	var netzFeld, netzBanden, netzKugel, netzApron, schatten;
	var slingshots = [], netzPfosten, netzMutter;
	var netzBumperFuss, netzBumperKoerper, netzBumperKappe, netzBumperStange;
	var netzPost, netzPostGummi, netzFlipper, netzFlipperGummi, netzZiel;
	var netzPlunger, netzPlungerKnauf;
	var texFeld, texSchatten, texGlimm, netzGlimm;
	var texGlas, netzGlas, netzGlasRahmen, glas, glasStand = null;
	var texEnv, texKuppel;
	var netzBoden, texBoden, netzBein, netzRinne, netzScheibe, netzLeisten;
	var netzSchrank, netzSchrankKante, netzSchrankInnen, texSchrank, texHolz, texLeder, netzKnopfRing, netzKnopfKappe, netzSchraube;
	var texTeile, FELD;
	var LAMPEN = [];
	var lampP = new Float32Array(18), lampC = new Float32Array(18);
	var spielzeit = 0;
	var proj = m4(), ansicht = m4(), mvp = m4(), tmp = m4();
	/*
	 * Kamera: ein Mensch am Geraet, keine Stativkamera. Er schwankt leicht im
	 * Stand, atmet, folgt der Kugel traege mit dem Kopf, beugt sich vor, wenn
	 * sie unten bei den Flippern ist, und zuckt beim Ruetteln.
	 *
	 * Alle Bewegungen sind klein - Millimeter - und mit Zeitkonstanten um eine
	 * Sekunde geglaettet. Die beiden Schwankperioden sind so gewaehlt, dass sie
	 * nie zusammenfallen, sonst entstuende ein erkennbarer Takt.
	 */
	var RUHE_AUGE = [XM, 0.300, 0.190], RUHE_ZIEL = [XM, 0.030, -0.560];
	var augePos = [XM, 0.300, 0.190];
	var kamera = { auge: RUHE_AUGE.slice(), ziel: RUHE_ZIEL.slice(),
				   dx: 0, dz: 0, beugung: 0, stoss: 0 };

	function kameraSchritt(dt) {
		var t = spielzeit;
		var sx = Math.sin(t * 0.37) * 0.006 + Math.sin(t * 0.91 + 1.3) * 0.0025;
		var sy = Math.sin(t * 0.53 + 0.7) * 0.004;
		var sz = Math.sin(t * 1.57) * 0.0022;                  // Atmen
		var kugelDa = ph.aktiv && spiel.zustand === "spiel";
		var zielX = kugelDa ? (ph.p[0] - XM) * 0.10 : 0;
		var zielZ = kugelDa ? -(ph.p[1] - 0.56) * 0.06 : 0;
		var beugen = kugelDa && ph.p[1] < 0.36 ? 1 : 0;
		var k = Math.min(1, dt * 1.6);
		kamera.dx += (zielX - kamera.dx) * k;
		kamera.dz += (zielZ - kamera.dz) * k;
		kamera.beugung += (beugen - kamera.beugung) * Math.min(1, dt * 1.1);
		// Ruetteln: `ruettel` klingt in spielSchritt selbst ab, die Kamera
		// nimmt es direkt als seitlichen Versatz
		kamera.stoss += (ruettel * 0.0035 - kamera.stoss) * Math.min(1, dt * 18);

		kamera.auge[0] = RUHE_AUGE[0] + sx + kamera.dx * 0.5 + kamera.stoss;
		kamera.auge[1] = RUHE_AUGE[1] + sy - kamera.beugung * 0.012;
		kamera.auge[2] = RUHE_AUGE[2] + sz - kamera.beugung * 0.022;
		kamera.ziel[0] = RUHE_ZIEL[0] + kamera.dx + kamera.stoss * 0.6 + sx * 0.3;
		kamera.ziel[1] = RUHE_ZIEL[1] - kamera.beugung * 0.006;
		kamera.ziel[2] = RUHE_ZIEL[2] + kamera.dz;
		augePos = kamera.auge;
	}

	var aniso = gl.getExtension("EXT_texture_filter_anisotropic")
	         || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic")
	         || gl.getExtension("MOZ_EXT_texture_filter_anisotropic");
	var anisoMax = aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;

	function macheTextur(cv, mip, kacheln) {
		var t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		// Gespiegelte Wiederholung: kachelt auch Bilder, die nicht nahtlos sind
		var rand = kacheln ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, rand);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, rand);
		if (mip) {
			gl.generateMipmap(gl.TEXTURE_2D);
			// Das Spielfeld wird flach und stark verkuerzt gesehen. Ohne
			// anisotrope Filterung greift schon nahe am Auge eine hohe
			// Mipmap-Stufe, die Sterne und Linien ins Blau mittelt.
			if (aniso) {
				gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
				                 Math.min(16, anisoMax));
			}
		}
		return t;
	}

	var UV_GANZ = [0, 0, 1, 1];
	/*
	 * Glanzschleier (Bloom). Echte Flipper stehen im Dunkeln, und jede helle
	 * Lampe, jeder Chromreflex traegt vor dem Auge einen Hof - im Foto ebenso.
	 * Ohne den wirkt das Bild sauber und tot.
	 *
	 * Ablauf: Szene in einen Puffer, dann die hellen Stellen bei Viertelgroesse
	 * herausziehen, waagerecht und senkrecht weichzeichnen, additiv darueber.
	 * Getrennte Achsen statt eines quadratischen Kerns: 2 x 9 Proben statt 81.
	 */
	var VS_V = ["attribute vec2 aPos; varying vec2 vUv;",
	            "void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }"].join("\n");
	var FS_HELL = ["precision mediump float; varying vec2 vUv;",
	               "uniform sampler2D uBild; uniform float uSchwelle;",
	               "void main(){",
	               "  vec3 c = texture2D(uBild, vUv).rgb;",
	               "  float h = max(c.r, max(c.g, c.b));",
	               // Weicher Einsatz statt harter Kante: eine harte Schwelle
	               // laesst bewegte Glanzpunkte flackern
	               "  float f = clamp((h - uSchwelle) / (1.0 - uSchwelle + 1e-4), 0.0, 1.0);",
	               "  gl_FragColor = vec4(c * f * f, 1.0);",
	               "}"].join("\n");
	var FS_WEICH = ["precision mediump float; varying vec2 vUv;",
	                "uniform sampler2D uBild; uniform vec2 uSchritt;",
	                "void main(){",
	                "  vec3 s = texture2D(uBild, vUv).rgb * 0.2270;",
	                "  s += (texture2D(uBild, vUv + uSchritt * 1.3846).rgb",
	                "      + texture2D(uBild, vUv - uSchritt * 1.3846).rgb) * 0.3162;",
	                "  s += (texture2D(uBild, vUv + uSchritt * 3.2308).rgb",
	                "      + texture2D(uBild, vUv - uSchritt * 3.2308).rgb) * 0.0703;",
	                "  gl_FragColor = vec4(s, 1.0);",
	                "}"].join("\n");
	var FS_ZUSAMMEN = ["precision mediump float; varying vec2 vUv;",
	                   "uniform sampler2D uBild, uSchleier; uniform float uStaerke;",
	                   "void main(){",
	                   "  vec3 c = texture2D(uBild, vUv).rgb;",
	                   "  gl_FragColor = vec4(c + texture2D(uSchleier, vUv).rgb * uStaerke, 1.0);",
	                   "}"].join("\n");

	/*
	 * Hintergrund: weicher Vertikalverlauf mit Vignette, wie in der
	 * Glass-Box-Demo. Bewusst KEINE Umgebungskarte - die spiegelt sich im Chrom,
	 * ist aber keine Kulisse.
	 */
	var FS_BG = ["precision mediump float; varying vec2 vUv;",
				 "uniform vec3 uOben, uUnten;",
				 "void main(){",
				 "  vec3 c = mix(uUnten, uOben, pow(clamp(vUv.y, 0.0, 1.0), 0.85));",
				 "  float v = distance(vUv, vec2(0.5, 0.55));",
				 "  c *= 1.0 - smoothstep(0.28, 0.95, v) * 0.42;",
				 "  gl_FragColor = vec4(c, 1.0);",
				 "}"].join("\n");
	var progBg = baueProgramm(VS_V, FS_BG);
	var progHell = baueProgramm(VS_V, FS_HELL);
	var progWeich = baueProgramm(VS_V, FS_WEICH);
	var progZusammen = baueProgramm(VS_V, FS_ZUSAMMEN);
	var bVoll = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, bVoll);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

	function vollbild(prog2) {
		var a = gl.getAttribLocation(prog2, "aPos");
		gl.bindBuffer(gl.ARRAY_BUFFER, bVoll);
		gl.enableVertexAttribArray(a);
		gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function macheZiel(b, h, mitTiefe) {
		var t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, b, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		var f = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, f);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
		var tiefe = null;
		if (mitTiefe) {
			tiefe = gl.createRenderbuffer();
			gl.bindRenderbuffer(gl.RENDERBUFFER, tiefe);
			gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, b, h);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, tiefe);
		}
		var fertig = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return fertig ? { tex: t, fb: f, tiefe: tiefe, b: b, h: h } : null;
	}

	var zielSzene = null, zielHell = null, zielWeich = null, schleierGeht = true;

	function pruefePuffer(b, h) {
		if (!schleierGeht) return false;
		if (zielSzene && zielSzene.b === b && zielSzene.h === h) return true;
		[zielSzene, zielHell, zielWeich].forEach(function (z) {
			if (!z) return;
			gl.deleteTexture(z.tex); gl.deleteFramebuffer(z.fb);
			if (z.tiefe) gl.deleteRenderbuffer(z.tiefe);
		});
		var kb = Math.max(1, b >> 2), kh = Math.max(1, h >> 2);
		zielSzene = macheZiel(b, h, true);
		zielHell = macheZiel(kb, kh, false);
		zielWeich = macheZiel(kb, kh, false);
		if (!zielSzene || !zielHell || !zielWeich) {
			// Kein Framebuffer verfuegbar: dann eben ohne Schleier, statt
			// gar nichts anzuzeigen.
			schleierGeht = false;
			zielSzene = zielHell = zielWeich = null;
		}
		return schleierGeht;
	}

	function schleierUeberlagern() {
		gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
		gl.bindFramebuffer(gl.FRAMEBUFFER, zielHell.fb);
		gl.viewport(0, 0, zielHell.b, zielHell.h);
		gl.useProgram(progHell);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, zielSzene.tex);
		gl.uniform1i(gl.getUniformLocation(progHell, "uBild"), 0);
		// Hoch angesetzt: bei 0,62 lag die ganze gelbe Flaeche des V darueber
		// und brannte zu einem Klecks aus. Der Schleier soll die Lampen und
		// die Glanzpunkte auf dem Chrom fassen, nicht ganze Farbfelder.
		gl.uniform1f(gl.getUniformLocation(progHell, "uSchwelle"), 0.86);
		vollbild(progHell);

		gl.useProgram(progWeich);
		gl.uniform1i(gl.getUniformLocation(progWeich, "uBild"), 0);
		var schritt = gl.getUniformLocation(progWeich, "uSchritt");
		gl.bindFramebuffer(gl.FRAMEBUFFER, zielWeich.fb);
		gl.bindTexture(gl.TEXTURE_2D, zielHell.tex);
		gl.uniform2f(schritt, 1 / zielHell.b, 0);
		vollbild(progWeich);
		gl.bindFramebuffer(gl.FRAMEBUFFER, zielHell.fb);
		gl.bindTexture(gl.TEXTURE_2D, zielWeich.tex);
		gl.uniform2f(schritt, 0, 1 / zielHell.h);
		vollbild(progWeich);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, zielSzene.b, zielSzene.h);
		gl.useProgram(progZusammen);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, zielSzene.tex);
		gl.uniform1i(gl.getUniformLocation(progZusammen, "uBild"), 0);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, zielHell.tex);
		gl.uniform1i(gl.getUniformLocation(progZusammen, "uSchleier"), 1);
		gl.uniform1f(gl.getUniformLocation(progZusammen, "uStaerke"), 0.38);
		vollbild(progZusammen);
		gl.activeTexture(gl.TEXTURE0);
		gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
	}

	function macheWuerfel(seiten, mip) {
		var t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
		var ziele = [gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
		             gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
		             gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z];
		for (var i = 0; i < 6; i++) {
			gl.texImage2D(ziele[i], 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, seiten[i]);
		}
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER,
		                 mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		if (mip) gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
		return t;
	}

	function zeichneObjekt(netz, m, farbe, rauheit, leucht, metall, texAn, uvFeld, alpha) {
		mul(tmp, ansicht, m); mul(mvp, proj, tmp);
		gl.uniformMatrix4fv(U.uMVP, false, mvp);
		gl.uniformMatrix4fv(U.uModell, false, m);
		gl.uniformMatrix3fv(U.uNormM, false, normalMatrix(m));
		gl.uniform3fv(U.uFarbe, farbe);
		gl.uniform1f(U.uRauheit, rauheit); gl.uniform1f(U.uLeucht, leucht || 0);
		gl.uniform1f(U.uMetall, metall || 0); gl.uniform1f(U.uTexAn, texAn ? 1 : 0);
		gl.uniform1f(U.uAlpha, alpha === undefined ? 1 : alpha);
		gl.uniform4fv(U.uUvFeld, uvFeld || UV_GANZ);
		netz.zeichne(A);
	}

	function lampenSchritt(dt) {
		for (var i = 0; i < LAMPEN.length; i++) {
			var lp = LAMPEN[i];
			var ziel = spiel.lampeZiel(lp, spielzeit, i);
			// Rollt die Kugel darueber, zieht die Lampe voll durch (nicht beim
			// Sling: Lampe unter der Platte, s. pinball-gpu.js)
			if (ph.aktiv && lp.art !== "sling" && Math.hypot(ph.p[0] - lp.x, ph.p[1] - lp.y) < lp.r * 1.3) ziel = 1;
			lp.an += (ziel - lp.an) * Math.min(1, dt * 15);
		}
		for (i = 0; i < SCHEIBE.length; i++) {
			if (SCHEIBE[i].blitz > 0) SCHEIBE[i].blitz = Math.max(0, SCHEIBE[i].blitz - dt * 3.0);
		}
		for (i = 0; i < SEG.length; i++) {
			if (SEG[i].blitz > 0) SEG[i].blitz = Math.max(0, SEG[i].blitz - dt * 3.0);
		}
	}

	function waehleLichter() {
		// Der Shader nimmt hoechstens sechs Lampen. Es zaehlt, was die Kugel
		// sieht: Helligkeit geteilt durch Abstand.
		var bx = ph.p[0], by = ph.p[1], beste = [], i, j;
		for (i = 0; i < LAMPEN.length; i++) {
			var lp = LAMPEN[i];
			if (lp.an < 0.06) continue;
			var dx = bx - lp.x, dy = by - lp.y;
			beste.push({ lp: lp, wert: lp.an / (0.02 + dx * dx + dy * dy) });
		}
		beste.sort(function (a, b) { return b.wert - a.wert; });
		var n = Math.min(6, beste.length);
		for (j = 0; j < n; j++) {
			var q = beste[j].lp, wp = welt(q.x, q.y, 0.022);
			lampP[j*3] = wp[0]; lampP[j*3+1] = wp[1]; lampP[j*3+2] = wp[2];
			var k = q.an * 0.85;
			lampC[j*3] = q.farbe[0]*k; lampC[j*3+1] = q.farbe[1]*k; lampC[j*3+2] = q.farbe[2]*k;
		}
		gl.uniform1i(U.uLampN, n);
		if (n) { gl.uniform3fv(U.uLampP, lampP); gl.uniform3fv(U.uLampC, lampC); }
	}

	function zeichneLampen() {
		gl.useProgram(progL);
		gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
		gl.depthMask(false);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texGlimm);
		gl.uniform1i(UL.tex, 0);
		for (var i = 0; i < LAMPEN.length; i++) {
			var lp = LAMPEN[i];
			if (lp.an < 0.02) continue;
			// Quadratisch statt linear: 29 Lampen mit linearem Grundwert legten
			// einen Schleier ueber das Feld und liessen das Tiefblau grau wirken.
			var m = modellFuer(lp.x, lp.y, 0.0012, 0, lp.r);
			mul(tmp, ansicht, m); mul(mvp, proj, tmp);
			gl.uniformMatrix4fv(UL.mvp, false, mvp);
			gl.uniform3fv(UL.farbe, lp.farbe);
			gl.uniform1f(UL.staerke, lp.an * lp.an * 0.90);
			netzGlimm.zeichne(AL);
		}
		gl.depthMask(true); gl.disable(gl.BLEND);
		gl.useProgram(prog);
	}

	function groesse() {
		var dpr = Math.min(devicePixelRatio || 1, 2);
		var b = Math.max(1, Math.floor(leinwand.clientWidth * dpr));
		var h = Math.max(1, Math.floor(leinwand.clientHeight * dpr));
		if (leinwand.width !== b || leinwand.height !== h) {
			leinwand.width = b; leinwand.height = h; gl.viewport(0, 0, b, h);
		}
		return b / h;
	}

	var lesefeld = document.getElementById("readout");
	var bilder = 0, fpsZeit = 0, fps = 0, zuletzt = 0;

	function zeichne(jetzt) {
		var dt = Math.min((jetzt - zuletzt) / 1000, 0.05);
		zuletzt = jetzt;
		spielzeit += dt;

		if (plunger.laedt) plunger.zug = Math.min(1, plunger.zug + dt * 1.7);

		var unter = 12, h = dt / unter, i;
		for (i = 0; i < unter; i++) spielSchritt(h);
		spiel.schritt(dt);
		lampenSchritt(dt);
		kameraSchritt(dt);

		var ar = groesse();
		perspektive(proj, 60 * Math.PI / 180, ar, 0.02, 12);
		blickAuf(ansicht, kamera.auge, kamera.ziel, [0, 1, 0]);

		var mitSchleier = pruefePuffer(leinwand.width, leinwand.height);
		if (mitSchleier) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, zielSzene.fb);
			gl.viewport(0, 0, zielSzene.b, zielSzene.h);
		}
		gl.clearColor(0, 0, 0, 1);
		gl.disable(gl.BLEND);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		// Verlauf hinter allem, ohne Tiefe. Farben aus der Glass-Box-Demo:
		// unten #070A0D, oben #18232B.
		gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.depthMask(false);
		gl.useProgram(progBg);
		// 25 % heller als die Glass-Box-Werte, Verlauf unveraendert
		gl.uniform3f(gl.getUniformLocation(progBg, "uOben"), 0.118, 0.171, 0.211);
		gl.uniform3f(gl.getUniformLocation(progBg, "uUnten"), 0.034, 0.049, 0.064);
		vollbild(progBg);
		gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
		gl.useProgram(prog);
		gl.uniform3fv(U.uAuge, augePos);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_CUBE_MAP, texEnv);
		gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_CUBE_MAP, texKuppel);
		gl.activeTexture(gl.TEXTURE0);
		waehleLichter();
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFeld);
		gl.uniform1i(U.uTex, 0);

		var einheit = ident(m4());
		// Schrank mit Seitengrafik und Front; die Holzkanten mit der Holztextur
		gl.bindTexture(gl.TEXTURE_2D, texSchrank);
		zeichneObjekt(netzSchrank, einheit, [1, 1, 1], 0.38, 0, 0.06, true);
		gl.bindTexture(gl.TEXTURE_2D, texHolz);
		zeichneObjekt(netzSchrankKante, einheit, [0.92, 0.90, 0.86], 0.46, 0, 0.04, true);
		// Innenwaende: Leder, glatt genug, dass sich die Umgebung darin zeigt.
		// Die Waende werden fast streifend gesehen - dort greift der Fresnel-
		// Anteil und legt den Spiegelglanz von selbst ueber die Narbung.
		gl.bindTexture(gl.TEXTURE_2D, texLeder);
		zeichneObjekt(netzSchrankInnen, einheit, [0.92, 0.92, 0.92], 0.24, 0, 0.0, true);
		gl.bindTexture(gl.TEXTURE_2D, texFeld);

		// Flipperknoepfe aussen an den Waenden, Schrauben laengs der Holzkante
		[-1, 1].forEach(function (seite) {
			var mk = seitwaerts(seite * (W + SCHRANK_D), 0.060, 0.030, seite);
			zeichneObjekt(netzKnopfRing, mk, [0.95, 0.96, 0.97], 0.08, 0, 1.0, false);
			zeichneObjekt(netzKnopfKappe, mk, [0.86, 0.14, 0.16], 0.28, 0.04, 0.05, false);
			for (var yS = SCHRANK_Y0 + 0.08; yS < SCHRANK_Y1 - 0.04; yS += 0.16) {
				var ms = modellFuer(seite * (W + SCHRANK_D / 2), yS, SCHRANK_H1, 0, 1);
				zeichneObjekt(netzSchraube, ms, [0.90, 0.91, 0.93], 0.12, 0, 1.0, false);
			}
		});

		// Boden mit Kontaktschatten, Beine senkrecht im Raum
		gl.bindTexture(gl.TEXTURE_2D, texBoden);
		zeichneObjekt(netzBoden, einheit, [0.125, 0.188, 0.227], 0.75, 0, 0.0, true);
		gl.bindTexture(gl.TEXTURE_2D, texFeld);
		[[-W - 0.012, -0.06], [W + 0.012, -0.06], [-W - 0.012, L + 0.02], [W + 0.012, L + 0.02]]
			.forEach(function (e) {
				var fuss = welt(e[0], e[1], -0.040);
				zeichneObjekt(netzBein, verschiebung(fuss[0], BODEN_Y, fuss[2]),
							  [0.12, 0.13, 0.15], 0.35, 0, 0.55, false);
			});

		// Kopfstueck. Die Anzeige wird nur bei Aenderung neu gezeichnet und
		// hochgeladen - sie steht die meiste Zeit still.
		var stand = [spiel.punkte, spiel.ball, spiel.bonus, spiel.multi(), spiel.zustand,
		             spiel.meldung, spiel.bahnen.V, spiel.bahnen.F, spiel.bahnen.X].join("|");
		if (stand !== glasStand) {
			glasStand = stand;
			glas.aktualisiere({ punkte: spiel.punkte, ball: spiel.ball, bonus: spiel.bonus,
			                    multi: spiel.multi(), bahnen: spiel.bahnen,
			                    zustand: spiel.zustand, meldung: spiel.meldung });
			gl.bindTexture(gl.TEXTURE_2D, texGlas);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glas.canvas);
		}
		zeichneObjekt(netzGlasRahmen, einheit, [0.16, 0.17, 0.20], 0.30, 0, 0.65, false);
		gl.bindTexture(gl.TEXTURE_2D, texGlas);
		zeichneObjekt(netzGlas, einheit, [1, 1, 1], 0.12, 0.10, 0.04, true);
		gl.bindTexture(gl.TEXTURE_2D, texFeld);

		// Matter als zuvor: bei 0.26 spiegelte sich die grosse Softbox als
		// breiter Schleier ueber das halbe Brett und nahm der Grafik alle Farbe.
		zeichneObjekt(netzFeld, einheit, [1,1,1], 0.44, 0, 0.02, true);
		// Lackiertes Holz in der Rinne: glatter als das Feld
		gl.bindTexture(gl.TEXTURE_2D, texHolz);
		zeichneObjekt(netzRinne, einheit, [1,1,1], 0.17, 0, 0.04, true);
		gl.bindTexture(gl.TEXTURE_2D, texFeld);
		zeichneLampen();
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFeld);
		zeichneObjekt(netzBanden, einheit, [0.95, 0.96, 0.97], 0.075, 0, 1.0, false);

		gl.bindTexture(gl.TEXTURE_2D, texTeile);
		zeichneObjekt(netzApron, einheit, [0.66, 0.70, 0.76], 0.22, 0, 0.92, true, FELD.blende);
		gl.bindTexture(gl.TEXTURE_2D, texFeld);

		// Slingshots: Pfosten, Muttern und Gummi. Die Platte kommt spaeter,
		// nach der Kugel - sie ist durchscheinend.
		slingshots.forEach(function (sl) {
			sl.ecken.forEach(function (e) {
				var mp = modellFuer(e[0], e[1], 0, 0, 1);
				zeichneObjekt(netzPfosten, mp, [0.95, 0.96, 0.97], 0.09, 0, 1.0, false);
				zeichneObjekt(netzMutter,  mp, [0.90, 0.91, 0.93], 0.16, 0, 1.0, false);
			});
			zeichneObjekt(sl.gummi, einheit, [0.94, 0.93, 0.90], 0.55, 0, 0.0, false);
		});

		// Bumper: Fuss, Koerper, Kappe, Stange - vier Teile mit eigenen Farben
		SCHEIBE.forEach(function (q) {
			var m = modellFuer(q.p[0], q.p[1], 0, 0, 1);
			if (q.art === "bumper") {
				var blitz = q.blitz;
				zeichneObjekt(netzBumperFuss, m, [0.16, 0.18, 0.24], 0.28, 0, 0.30, false);
				zeichneObjekt(netzBumperStange, m, [0.96, 0.97, 0.98], 0.055, 0, 1.0, false);
				zeichneObjekt(netzBumperKoerper, m, [0.95, 0.80, 0.20], 0.34,
				              0.18 + blitz * 0.75, 0.0, false);
				gl.bindTexture(gl.TEXTURE_2D, texTeile);
				zeichneObjekt(netzBumperKappe, m, [0.84, 0.16, 0.20], 0.18,
				              blitz * 0.35, 0.04, true, FELD.bumperKappe);
				gl.bindTexture(gl.TEXTURE_2D, texFeld);
			} else {
				zeichneObjekt(netzPost, m, [0.95, 0.96, 0.97], 0.09, 0, 1.0, false);
				if (q.gummi) zeichneObjekt(netzPostGummi, m, [0.90, 0.92, 0.94], 0.50, 0, 0.0, false);
			}
		});

		// Fallziele - sie sinken sichtbar ins Feld
		gl.bindTexture(gl.TEXTURE_2D, texTeile);
		ZIELE.forEach(function (z) {
			var m = modellFuer(z.x, z.y, -0.028 * z.sinken, Math.atan2(z.ny, z.nx), 1);
			var steh = z.gruppe === "steh";
			var f = steh ? (z.an ? [0.98, 0.80, 0.14] : [0.62, 0.52, 0.20])
			      : z.farbe === "#C8202B" ? [0.86, 0.16, 0.20] : [0.95, 0.50, 0.12];
			zeichneObjekt(netzZiel, m, f, 0.20, z.unten ? 0 : 0.10, 0.04, true,
			              steh ? FELD.stehziel : FELD.fallziel);
		});
		gl.bindTexture(gl.TEXTURE_2D, texFeld);

		// Flipper
		FL.forEach(function (f) {
			var m = modellFuer(f.p[0], f.p[1], 0.004, f.w, 1);
			var anteil = Math.abs(f.w - f.ruhe) / Math.abs(f.voll - f.ruhe);
			// Heller Schlaeger, dunkler Gummi als schmales Band. Umgekehrt
			// verdeckte der Gummi den Schlaeger vollstaendig, und der Flipper
			// las sich nur noch als gruener Klecks.
			zeichneObjekt(netzFlipper, m, [0.90, 0.92, 0.95], 0.14, 0, 0.70, false);
			zeichneObjekt(netzFlipperGummi, m,
			              [0.20 + 0.28*anteil, 0.62 + 0.24*anteil, 0.24], 0.55, anteil * 0.22, 0.0, false);
		});

		// Abschussstange
		var pz = plunger.zug * 0.055 + plunger.rueck * -0.012;
		var mp = modellFuer((SCHACHT_X + W) / 2, 0.040 - pz, 0.012, 0, 1);
		zeichneObjekt(netzPlunger, mp, [0.95, 0.96, 0.97], 0.06, 0, 1.0, false);
		zeichneObjekt(netzPlungerKnauf, mp, [0.72, 0.14, 0.16], 0.26, 0, 0.05, false);

		if (ph.aktiv) {
			// Schatten zuerst, damit die Kugel darueber liegt
			gl.useProgram(progS);
			gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
			gl.depthMask(false);
			var ms = modellFuer(ph.p[0] + 0.004, ph.p[1] - 0.004, 0, 0, 1);
			mul(tmp, ansicht, ms); mul(mvp, proj, tmp);
			gl.uniformMatrix4fv(US.mvp, false, mvp);
			gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texSchatten);
			gl.uniform1i(US.tex, 0); gl.uniform1f(US.staerke, 0.55);
			schatten.netz.zeichne(AS);
			gl.depthMask(true); gl.disable(gl.BLEND);

			gl.useProgram(prog);
			gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFeld);
			gl.uniform3fv(U.uAuge, augePos);
			var mk = modellFuer(ph.p[0], ph.p[1], KUGEL_R, 0, 1);
			zeichneObjekt(netzKugel, mk, [0.96, 0.97, 0.98], 0.035, 0, 1.0, false);
		}

		// Slingshot-Platten: bedruckt, leicht durchscheinend, von unten
		// beleuchtet - beim Treffer glueht die ganze Platte auf.
		gl.useProgram(prog);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texTeile);
		gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.depthMask(false);
		slingshots.forEach(function (sl) {
			var blitz = sl.gummiSeg && sl.gummiSeg.blitz ? sl.gummiSeg.blitz : 0;
			zeichneObjekt(sl.platte, einheit, [1, 1, 1], 0.10, 0.10 + blitz * 0.9, 0.04, true,
						  FELD.slingPlatte, 0.90);
		});
		gl.depthMask(true); gl.disable(gl.BLEND);

		// Chromleisten auf Glashoehe
		gl.useProgram(prog);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFeld);
		zeichneObjekt(netzLeisten, einheit, [0.95, 0.96, 0.97], 0.08, 0, 1.0, false);

		/*
		 * Glasscheibe: nur die Spiegelung der Umgebung, additiv ueber das Bild,
		 * dazu eine leichte Abdunklung. Ohne Koerperfarbe, damit sie das Feld
		 * nicht verwaescht. Nach der Kugel gezeichnet, weil sie darueber liegt.
		 */
		// Rein additiv und stark gedaempft: das Studio-HDRI ist ueberall hell,
		// eine echte Halle nicht. Voll angesetzt lag die Spiegelung als grauer
		// Schleier ueber dem ganzen Feld.
		gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, 0.16);
		gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE);
		gl.depthMask(false); gl.disable(gl.CULL_FACE);
		zeichneObjekt(netzScheibe, einheit, [0, 0, 0], 0.03, 0, 0.0, false, null, 1.0);
		gl.enable(gl.CULL_FACE); gl.depthMask(true); gl.disable(gl.BLEND);

		if (mitSchleier) schleierUeberlagern();

		bilder++; fpsZeit += dt;
		if (fpsZeit >= 0.4) { fps = Math.round(bilder / fpsZeit); bilder = 0; fpsZeit = 0; }
		zeigeStand();
		requestAnimationFrame(zeichne);
	}

	function zeigeStand() {
		var geschw = Math.hypot(ph.v[0], ph.v[1]);
		// Auf Beruehrungsgeraeten gibt es keine Leertaste - dort heisst es LAUNCH
		var beruehrung = matchMedia("(pointer: coarse)").matches;
		var kopf = spiel.zustand === "attract" ? "<b>" + (beruehrung ? "TAP LAUNCH" : "PRESS SPACE") + " TO START</b>"
		         : spiel.zustand === "aus" ? "<b>GAME OVER</b> &middot; " + (beruehrung ? "launch" : "space") + " for a new game"
		         : "score <b>" + spiel.punkte.toLocaleString("en-US") + "</b> · ball <b>" +
		           spiel.ball + "/" + (spiel.baelle + spiel.ball - 1) + "</b> · bonus <b>" +
		           spiel.bonus + "×" + spiel.multi() + "</b>";
		lesefeld.innerHTML =
			kopf + (spiel.meldung ? "  ·  <b>" + spiel.meldung + "</b>" : "") + "\n" +
			"ball " + geschw.toFixed(2) + " m/s · spin " + Math.abs(ph.w).toFixed(0) + " rad/s · " +
			ph.segmente.length + " segments · " + SCHEIBE.length + " discs · " +
			"720 Hz swept solver · <i>" + fps + " fps</i>" + (PHYSIK_ALT ? " · physik alt" : "") +
			(SLING.abweichend ? " · " + SLING.kurz : "") +
			(plunger.laedt ? "  ·  plunger " + Math.round(plunger.zug * 100) + "%" : "");
	}

	// ------------------------------------------------------------- Eingabe
	function setzeFlipper(seite, an) {
		FL.forEach(function (f) { if (f.seite === seite) f.ziel = an ? 1 : 0; });
	}
	function starttaste() {
		if (spiel.zustand !== "attract" && spiel.zustand !== "aus") return false;
		starteSpiel();
		// Sofort anzeigen statt aufs naechste Bild zu warten: der Start ist die
		// eine Stelle, an der eine Verzoegerung wie ein verschluckter
		// Tastendruck wirkt.
		zeigeStand();
		return true;
	}

	addEventListener("keydown", function (e) {
		if (e.repeat) return;
		if (e.key === "ArrowLeft")  { setzeFlipper(-1, true); e.preventDefault(); }
		if (e.key === "ArrowRight") { setzeFlipper( 1, true); e.preventDefault(); }
		if (e.key === " ") {
			e.preventDefault();
			if (!starttaste()) plunger.laedt = true;
		}
		if (e.key === "n" || e.key === "N") ruettel = (Math.random() - 0.5) * 3.4;
		if (e.key === "r" || e.key === "R") starteSpiel();
	});
	addEventListener("keyup", function (e) {
		if (e.key === "ArrowLeft")  setzeFlipper(-1, false);
		if (e.key === "ArrowRight") setzeFlipper( 1, false);
		if (e.key === " ") abschuss();
	});

	var beruehrung = document.getElementById("touch");
	if (matchMedia("(pointer: coarse)").matches) {
		beruehrung.hidden = false;
		function knopf(id, an, aus) {
			var el = document.getElementById(id);
			el.addEventListener("pointerdown", function (e) { e.preventDefault(); an(); });
			el.addEventListener("pointerup", function (e) { e.preventDefault(); aus(); });
			el.addEventListener("pointercancel", aus);
		}
		knopf("tLeft",  function () { setzeFlipper(-1, true); }, function () { setzeFlipper(-1, false); });
		knopf("tRight", function () { setzeFlipper( 1, true); }, function () { setzeFlipper( 1, false); });
		knopf("tPlunge", function () { if (!starttaste()) plunger.laedt = true; }, abschuss);
	}

	// -------------------------------------------------------------- Start
	/*
	 * Aufbau. Logo und Umgebungskarten werden gleichzeitig geladen; gebaut wird,
	 * wenn beides da ist. Die Umgebung besteht aus zwoelf Bildern - sie
	 * nacheinander zu holen kostete unnoetig Zeit beim Start.
	 */
	var bild = new Image(), logo = null, umgebung = null, holzBild = null, lederBild = null, offen = 4;

	/*
	 * Oberflaechenbilder aus umgebung/: der erste Name, der laedt, gewinnt.
	 * Jedes Bild wird auf 512 x 512 gebracht - Zweierpotenz, sonst gibt es
	 * weder Mipmaps noch Wiederholung.
	 */
	function ladeBild(namen, fertig) {
		var i = 0;
		function versuch() {
			if (i >= namen.length) { fertig(null); return; }
			var b = new Image();
			b.onload = function () { fertig(b); };
			b.onerror = function () { i++; versuch(); };
			b.src = namen[i] + "?v=" + UMGEBUNG_MARKE;
		}
		versuch();
	}
	function quadrat(quelle) {
		var cv = document.createElement("canvas");
		cv.width = cv.height = 512;
		var g = cv.getContext("2d");
		g.drawImage(quelle, 0, 0, 512, 512);
		return cv;
	}
	function flaecheEinfarbig(farbe) {
		var cv = document.createElement("canvas");
		cv.width = cv.height = 4;
		var g = cv.getContext("2d");
		g.fillStyle = farbe; g.fillRect(0, 0, 4, 4);
		return cv;
	}
	ladeBild(["umgebung/holz.jpg", "umgebung/holz.png"], function (b) { holzBild = b; vielleichtBauen(); });
	ladeBild(["umgebung/leder.jpg", "umgebung/leder.png"], function (b) { lederBild = b; vielleichtBauen(); });
	function vielleichtBauen() {
		if (--offen > 0) return;
		baueAlles();
	}
	bild.onload = bild.onerror = function () {
		logo = bild.complete && bild.naturalWidth ? bild : null;
		vielleichtBauen();
	};
	bild.src = "logo.png";
	var UMGEBUNG_MARKE = "40";
	window.ladeUmgebung({ marke: UMGEBUNG_MARKE }, function (u) {
		umgebung = u;
		if (u.fehlend.length) {
			// Nicht stillschweigend flau weiterleuchten - wer die Karten
			// vergisst, soll es in der Konsole sehen.
			console.warn("Umgebungskarten fehlen:", u.fehlend.join(", "));
		}
		vielleichtBauen();
	});

	function baueAlles() {
		var kunst = window.spielfeldKunst({ tisch: T, logo: logo,
		                                    xRand: FELD_XR, y0: FELD_Y0, y1: FELD_Y1 });
		LAMPEN      = kunst.lampen;
		texFeld     = macheTextur(kunst.canvas, true);
		texSchatten = macheTextur(zeichneSchattenbild(), false);
		texGlimm    = macheTextur(zeichneGlimmbild(), false);
		glas        = window.backglasKunst({ logo: logo, verhaeltnis: 2 * GLAS_HALB / GLAS_HOCH });
		texGlas     = macheTextur(glas.canvas, false);
		texTeile    = macheTextur(window.teileKunst({ tisch: T }), true);
		texEnv      = macheWuerfel(umgebung.seiten, true);
		texKuppel   = macheWuerfel(umgebung.diffus, false);
		// Die Wuerfel liegen fest auf den Einheiten 1 und 2 - sie wechseln nie
		gl.useProgram(prog);
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_CUBE_MAP, texEnv);
		gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_CUBE_MAP, texKuppel);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(U.uEnv, 1); gl.uniform1i(U.uKuppel, 2);
		FELD        = window.TEILE_FELD;

		netzFeld     = baueSpielfeldNetz();
		netzBanden   = baueBandenNetz();
		netzApron    = baueApronNetz();
		var schrank  = baueSchrankNetz();
		netzSchrank  = schrank.wand;
		netzSchrankKante = schrank.kante;
		texSchrank   = macheTextur(window.schrankKunst({ logo: logo }), true);
		texHolz      = macheTextur(holzBild ? quadrat(holzBild) : window.holzKunst(), true, true);
		texLeder     = macheTextur(lederBild ? quadrat(lederBild) : flaecheEinfarbig("#1E2130"), true, true);
		netzSchrankInnen = schrank.innen;
		netzKnopfRing  = drehkoerper([[0.0170, 0.000], [0.0170, 0.0045], [0.0125, 0.0065]], 20);
		netzKnopfKappe = drehkoerper([[0.0000, 0.0045], [0.0115, 0.0050], [0.0105, 0.0105], [0.0000, 0.0135]], 20, { unten: false });
		netzSchraube   = drehkoerper([[0.0040, 0.000], [0.0040, 0.0022], [0.0026, 0.0038], [0.0000, 0.0044]], 12);
		netzKugel    = baueKugelNetz(KUGEL_R, 20, 30);
		schatten     = baueSchattenNetz();
		netzGlimm    = baueGlimmNetz();
		netzBoden    = baueBodenNetz();
		texBoden     = macheTextur(zeichneBodenbild(), false);
		netzBein     = drehkoerper([[0.017, 0.000], [0.017, 0.700], [0.021, 0.720]], 12);
		netzRinne    = baueRinnenNetz();
		netzScheibe  = baueScheibenNetz();
		netzLeisten  = baueLeistenNetz();
		netzGlas       = baueBackglasNetz(GLAS_HALB, GLAS_HOCH, 0);
		netzGlasRahmen = baueBackglasNetz(GLAS_HALB + 0.022, GLAS_HOCH + 0.030, 0.010);

		// Pop-Bumper: Teller, Kegelkoerper, Kappe und Stange - vier Teile,
		// damit jedes seine eigene Farbe und sein eigenes Leuchten bekommt.
		netzBumperFuss = drehkoerper([[0.0000, 0.0000], [0.0290, 0.0020], [0.0290, 0.0055],
		                              [0.0230, 0.0075]], 26);
		netzBumperKoerper = drehkoerper([[0.0230, 0.0075], [0.0200, 0.0130], [0.0170, 0.0290],
		                                 [0.0175, 0.0340]], 26, { unten: false, oben: false });
		netzBumperKappe = drehkoerper([[0.0000, 0.0335], [0.0140, 0.0345], [0.0195, 0.0390],
		                               [0.0170, 0.0455], [0.0000, 0.0490]], 26, { unten: false });
		netzBumperStange = drehkoerper([[0.0030, 0.0060], [0.0030, 0.0420]], 12);

		netzPost      = drehkoerper([[0.0055, 0.0000], [0.0055, 0.0330], [0.0038, 0.0360]], 16);
		netzPostGummi = ringkoerper(0.0075, 0.0040, 0.0155, 20, 10);

		var umriss = flipperUmriss(MASS.flipperL, 0.0118, 0.0072, 12);
		netzFlipper      = prisma(umriss, 0.0000, 0.0170);
		netzFlipperGummi = prisma(flipperUmriss(MASS.flipperL, 0.0124, 0.0078, 12), 0.0050, 0.0125);

		// Fallziel: eine Platte quer zur Anspielrichtung, dahinter der Halter
		netzZiel = prisma([[-0.0030, -0.0170], [0.0030, -0.0170], [0.0030, 0.0170],
		                   [-0.0030, 0.0170]], 0.0000, 0.0250);

		slingshots  = [baueSlingshot(-1), baueSlingshot(1)];
		netzPfosten = drehkoerper([[0.0045, 0.000], [0.0045, 0.0300]], 12);
		netzMutter  = drehkoerper([[0.0058, 0.0300], [0.0058, 0.0345], [0.0042, 0.0358]], 6);

		netzPlunger      = drehkoerper([[0.0040, 0.0000], [0.0040, 0.0900]], 12);
		netzPlungerKnauf = drehkoerper([[0.0000, -0.0180], [0.0110, -0.0140], [0.0110, -0.0020],
		                                [0.0060, 0.0000]], 16);

		// Die Kugel liegt schon im Attract-Modus in der Rinne, wie an jedem
		// echten Geraet - und sie ist das einzige Stueck poliertes Chrom, an dem
		// man die Umgebung wirklich ablesen kann.
		kugelInSchacht();
		// Erstes Bild sofort zeichnen, nicht erst beim naechsten Bildwechsel.
		// Der Aufbau wartet auf zwoelf Bilddateien; bis er fertig ist, hat der
		// Browser laengst gezeichnet, und die Leinwand bliebe bis zum naechsten
		// Bildwechsel leer. `zeichne` meldet sich am Ende selbst wieder an.
		zuletzt = performance.now();
		zeichne(zuletzt);
	}

	/*
	 * Prisma direkt in der geneigten Feldebene - fuer Koerper, deren Grundriss
	 * schon in Tischkoordinaten vorliegt und die deshalb nicht ueber
	 * modellFuer() gesetzt werden.
	 */
	function prismaAufFeld(umriss, unten, oben) {
		// Der Umriss liegt in der Feldebene; der Deckel soll nach oben zeigen,
		// dafuer muss er gegen den Uhrzeigersinn laufen.
		if (flaecheMitVorzeichen(umriss) < 0) umriss = umriss.slice().reverse();
		var pos = [], nrm = [], uv = [], idx = [], i, n = umriss.length;
		for (i = 0; i < n; i++) {
			var p = umriss[i], q = umriss[(i + 1) % n];
			var dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
			var wn = weltRichtung(dy / l, -dx / l, 0);
			var b = pos.length / 3;
			[[p, unten, 0, 0], [q, unten, 1, 0], [q, oben, 1, 1], [p, oben, 0, 1]]
				.forEach(function (e) {
					var w = welt(e[0][0], e[0][1], e[1]);
					pos.push(w[0], w[1], w[2]); nrm.push(wn[0], wn[1], wn[2]); uv.push(e[2], e[3]);
				});
			idx.push(b, b+1, b+2, b, b+2, b+3);
		}
		var mx = 0, my = 0;
		umriss.forEach(function (p2) { mx += p2[0]; my += p2[1]; });
		mx /= n; my /= n;
		var wnO = weltRichtung(0, 0, 1), b2 = pos.length / 3;
		var wm = welt(mx, my, oben);
		pos.push(wm[0], wm[1], wm[2]); nrm.push(wnO[0], wnO[1], wnO[2]); uv.push(0.5, 0.5);
		for (i = 0; i < n; i++) {
			var w2 = welt(umriss[i][0], umriss[i][1], oben);
			pos.push(w2[0], w2[1], w2[2]); nrm.push(wnO[0], wnO[1], wnO[2]); uv.push(i / n, 0);
		}
		for (i = 0; i < n; i++) idx.push(b2, b2 + 1 + i, b2 + 1 + ((i + 1) % n));
		return new Netz(pos, nrm, uv, idx);
	}
})();
