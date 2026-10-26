/*
 * FRIDAYVFX Box Stack - Szene, Darstellung, Bedienung (WebGPU)
 *
 * Die Physik steht in rbd.js. Hier: der Stapel aus den Reglern, die Kamera,
 * das Bild (WebGPU, WGSL) und die Anzeige. Bildsprache wie in den uebrigen
 * Demos: weicher Verlauf hinter allem, Studioboden mit Kontaktschatten, warmes
 * Fuehrungslicht, kuehles Fuelllicht, Messing als Akzent.
 *
 * Portiert von stapel.js (WebGL 1). Regler, Welt, Kamera, Bedienung und
 * Telemetrie sind unveraendert uebernommen; anders geloest ist nur das Bild:
 *   - Boden, Kisten, Kugeln und Schattenflecken werden instanziert gezeichnet.
 *     Je Koerper steht ein Eintrag im Instanzpuffer (Modellmatrix, Normalen-
 *     matrix, Farbe, Glanz, Leuchten, Metall) statt Uniforms je Aufruf.
 *   - Die Projektion wird auf den WebGPU-Tiefenbereich 0..1 umgerechnet.
 *   - Antialiasing: MSAA 4x auf Farbe und Tiefe, aufgeloest in die Leinwand.
 *   - Die Tiefe wird zu Passbeginn geloescht; der Hintergrund schreibt keine
 *     Tiefe und vergleicht nicht - das ersetzt das clear(DEPTH) nach dem
 *     Hintergrund der WebGL-Fassung.
 *   - Ohne WebGPU (oder bei einem Validierungsfehler beim Start) wechselt die
 *     Seite auf webgl.html#fallback.
 */
(function () {
	"use strict";

	var leinwand = document.getElementById("gl");
	var fallback = document.getElementById("fallback"), fallbackMsg = document.getElementById("fallbackMsg");

	// ---------------------------------------------------------- Rueckfall
	function zeigeHinweis(text) {
		fallbackMsg.textContent = text;
		fallback.classList.add("show");
	}
	function rueckfall(grund) {
		console.error("WebGPU unavailable (" + grund + "), switching to the WebGL version");
		location.replace("webgl.html#fallback=" + encodeURIComponent(grund));
	}
	async function starteWebGPU(canvas) {
		if (!navigator.gpu) return rueckfall(window.isSecureContext ? "no navigator.gpu" : "insecure context, WebGPU needs https or localhost");
		var adapter = await navigator.gpu.requestAdapter();
		if (!adapter) return rueckfall("no adapter");
		var device = await adapter.requestDevice();
		device.addEventListener("uncapturederror", function (e) { console.error("WebGPU:", e.error.message); });
		device.lost.then(function (info) { if (info.reason !== "destroyed") zeigeHinweis("GPU device lost: " + info.message); });
		var context = canvas.getContext("webgpu");
		var format = navigator.gpu.getPreferredCanvasFormat();
		context.configure({ device: device, format: format, alphaMode: "opaque" });
		return { adapter: adapter, device: device, context: context, format: format };
	}

	// ---------------------------------------------------------- Farben
	function css(name, ersatz) {
		var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || ersatz;
		var m = v.match(/^#([0-9a-f]{6})$/i);
		if (!m) return ersatz ? css("", ersatz) : [0.5, 0.5, 0.5];
		var n = parseInt(m[1], 16);
		return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
	}
	function linear(c) { return [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)]; }
	var PAL = {};
	function liesPalette() {
		PAL.oben = linear(css("--scene-top", "#18232B"));
		PAL.unten = linear(css("--scene-bot", "#070A0D"));
		PAL.boden = linear(css("--ground", "#20303A"));
		PAL.key = css("--key", "#FFEBCB");
		PAL.fill = css("--fill", "#2C4557");
		PAL.kugel = linear(css("--ball", "#D9DEE3"));
		PAL.boxen = [css("--box-a", "#E3A33C"), css("--box-b", "#E8DCC4"), css("--box-c", "#4A6474"),
		             css("--box-d", "#B85A2B"), css("--box-e", "#2A3A46")].map(linear);
	}
	liesPalette();
	if (window.matchMedia) {
		window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", liesPalette);
	}

	// ---------------------------------------------------------- Shader (WGSL)
	/*
	 * Beleuchtete Koerper. Instanzdaten als Vertex-Attribute mit stepMode
	 * "instance", 144 Byte je Instanz (36 Floats):
	 *   0   Modellmatrix, 4 Spalten (vec4)
	 *   64  Normalenmatrix, 3 Spalten (vec3, je 16 Byte)
	 *   112 Farbe rgb + Glanz
	 *   128 Leuchten, Metall (+ 8 Byte Rest)
	 */
	var WGSL_LIT = `
// Byte-Offsets: vp 0, auge 64, licht 80, key 96, fill 112; Groesse 128
struct Szene {
	vp    : mat4x4<f32>,
	auge  : vec3<f32>,
	licht : vec3<f32>,
	key   : vec3<f32>,
	fill  : vec3<f32>,
};
@group(0) @binding(0) var<uniform> szene : Szene;

struct Ein {
	@location(0)  pos : vec3<f32>,
	@location(1)  nrm : vec3<f32>,
	@location(2)  m0 : vec4<f32>,
	@location(3)  m1 : vec4<f32>,
	@location(4)  m2 : vec4<f32>,
	@location(5)  m3 : vec4<f32>,
	@location(6)  n0 : vec3<f32>,
	@location(7)  n1 : vec3<f32>,
	@location(8)  n2 : vec3<f32>,
	@location(9)  farbeGlanz : vec4<f32>,
	@location(10) leuchtMetall : vec2<f32>,
};
struct Aus {
	@builtin(position) clip : vec4<f32>,
	@location(0) p : vec3<f32>,
	@location(1) n : vec3<f32>,
	@location(2) @interpolate(flat) farbe : vec3<f32>,
	@location(3) @interpolate(flat) glanz : f32,
	@location(4) @interpolate(flat) leucht : f32,
	@location(5) @interpolate(flat) metall : f32,
};

@vertex fn vs(e : Ein) -> Aus {
	let modell = mat4x4<f32>(e.m0, e.m1, e.m2, e.m3);
	let normM = mat3x3<f32>(e.n0, e.n1, e.n2);
	let w = modell * vec4<f32>(e.pos, 1.0);
	var a : Aus;
	a.clip = szene.vp * w;
	a.p = w.xyz;
	a.n = normM * e.nrm;
	a.farbe = e.farbeGlanz.rgb;
	a.glanz = e.farbeGlanz.a;
	a.leucht = e.leuchtMetall.x;
	a.metall = e.leuchtMetall.y;
	return a;
}

@fragment fn fs(a : Aus) -> @location(0) vec4<f32> {
	let N = normalize(a.n);
	let V = normalize(szene.auge - a.p);
	let L = normalize(szene.licht);
	let key = pow(szene.key, vec3<f32>(2.2));
	let fill = pow(szene.fill, vec3<f32>(2.2));
	let d = max(dot(N, L), 0.0);
	let himmel = N.y * 0.5 + 0.5;
	let amb = mix(fill * 0.55, key * 0.22, himmel);
	let H = normalize(L + V);
	let s = pow(max(dot(N, H), 0.0), a.glanz);
	let fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
	var c = a.farbe * (amb + key * d * 0.95)
	      + key * s * (0.12 + a.metall * 0.7)
	      + fill * fres * (0.10 + a.metall * 0.4)
	      + a.farbe * a.leucht;
	c = c / (c + vec3<f32>(0.85));
	return vec4<f32>(pow(c, vec3<f32>(0.4545)), 1.0);
}
`;
	// Hintergrund: Verlauf und Vignette. uv kommt aus der Clip-Lage der Ecken
	// (y = +1 oben, in beiden APIs gleich), nicht aus der Bildschirmposition.
	var WGSL_BG = `
// Byte-Offsets: oben 0, unten 16; Groesse 32
struct Hintergrund {
	oben  : vec3<f32>,
	unten : vec3<f32>,
};
@group(0) @binding(0) var<uniform> hg : Hintergrund;
struct Aus {
	@builtin(position) clip : vec4<f32>,
	@location(0) uv : vec2<f32>,
};
@vertex fn vs(@location(0) pos : vec2<f32>) -> Aus {
	var a : Aus;
	a.uv = pos * 0.5 + 0.5;
	a.clip = vec4<f32>(pos, 0.0, 1.0);
	return a;
}
@fragment fn fs(a : Aus) -> @location(0) vec4<f32> {
	var c = mix(hg.unten, hg.oben, pow(clamp(a.uv.y, 0.0, 1.0), 0.85));
	let v = distance(a.uv, vec2<f32>(0.5, 0.55));
	c = c * (1.0 - smoothstep(0.28, 0.95, v) * 0.42);
	return vec4<f32>(pow(c, vec3<f32>(0.4545)), 1.0);
}
`;
	// Schattenfleck: weiches Oval, Alpha aus dem Abstand zur Mitte.
	// Instanzdaten 80 Byte (20 Floats): Modellmatrix 0..63, Staerke 64.
	var WGSL_S = `
// Byte-Offsets: vp 0; die Szene-Uniform wird mitbenutzt, nur die Matrix zaehlt
struct Kamera {
	vp : mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> kam : Kamera;
struct Ein {
	@location(0) pos : vec3<f32>,
	@location(1) m0 : vec4<f32>,
	@location(2) m1 : vec4<f32>,
	@location(3) m2 : vec4<f32>,
	@location(4) m3 : vec4<f32>,
	@location(5) staerke : f32,
};
struct Aus {
	@builtin(position) clip : vec4<f32>,
	@location(0) uv : vec2<f32>,
	@location(1) @interpolate(flat) staerke : f32,
};
@vertex fn vs(e : Ein) -> Aus {
	let modell = mat4x4<f32>(e.m0, e.m1, e.m2, e.m3);
	var a : Aus;
	a.uv = e.pos.xz;
	a.clip = kam.vp * (modell * vec4<f32>(e.pos, 1.0));
	a.staerke = e.staerke;
	return a;
}
@fragment fn fs(a : Aus) -> @location(0) vec4<f32> {
	let r = length(a.uv);
	let alpha = (1.0 - smoothstep(0.35, 1.0, r)) * a.staerke;
	return vec4<f32>(0.0, 0.0, 0.0, alpha);
}
`;

	// ---------------------------------------------------------- Netze (Geometrie auf der CPU)
	function wuerfelDaten() {
		var pos = [], nrm = [], idx = [];
		var seiten = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
		seiten.forEach(function (n) {
			var u = n[1] || n[2] ? [1,0,0] : [0,1,0];
			var v = [n[1]*u[2]-n[2]*u[1], n[2]*u[0]-n[0]*u[2], n[0]*u[1]-n[1]*u[0]];
			var b = pos.length / 3;
			[[-1,-1],[1,-1],[1,1],[-1,1]].forEach(function (e) {
				pos.push(n[0] + u[0]*e[0] + v[0]*e[1], n[1] + u[1]*e[0] + v[1]*e[1], n[2] + u[2]*e[0] + v[2]*e[1]);
				nrm.push(n[0], n[1], n[2]);
			});
			idx.push(b, b+1, b+2, b, b+2, b+3);
		});
		return { pos: pos, nrm: nrm, idx: idx };
	}
	function kugelDaten(ringe, seiten) {
		var pos = [], nrm = [], idx = [], i, k;
		for (i = 0; i <= ringe; i++) { var phi = i / ringe * Math.PI;
			for (k = 0; k <= seiten; k++) { var th = k / seiten * Math.PI * 2;
				var x = Math.sin(phi)*Math.cos(th), y = Math.cos(phi), z = Math.sin(phi)*Math.sin(th);
				pos.push(x, y, z); nrm.push(x, y, z); } }
		for (i = 0; i < ringe; i++) for (k = 0; k < seiten; k++) {
			var a = i*(seiten+1)+k, b = a+1, c = a+seiten+1, d = c+1; idx.push(a, c, d, a, d, b); }
		return { pos: pos, nrm: nrm, idx: idx };
	}
	function flaecheDaten(S) {
		return { pos: [-S,0,-S, S,0,-S, S,0,S, -S,0,S], nrm: [0,1,0, 0,1,0, 0,1,0, 0,1,0], idx: [0,2,1, 0,3,2] };
	}

	// ---------------------------------------------------------- Matrizen
	function m4() { return new Float32Array(16); }
	function mul(o, a, b) { for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
		var s = 0; for (var k = 0; k < 4; k++) s += a[k*4+j] * b[i*4+k]; o[i*4+j] = s; } return o; }
	function perspektive(o, fovy, ar, nah, fern) { var f = 1 / Math.tan(fovy / 2);
		o.set([f/ar,0,0,0, 0,f,0,0, 0,0,(fern+nah)/(nah-fern),-1, 0,0,2*fern*nah/(nah-fern),0]); return o; }
	// WebGL-Tiefe -1..1 -> WebGPU-Tiefe 0..1: dritte Zeile der Projektion umrechnen
	function tiefeNullEins(p) {
		p[2] = 0.5 * p[2] + 0.5 * p[3]; p[6] = 0.5 * p[6] + 0.5 * p[7];
		p[10] = 0.5 * p[10] + 0.5 * p[11]; p[14] = 0.5 * p[14] + 0.5 * p[15];
		return p;
	}
	function blickAuf(o, auge, ziel) {
		function sub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
		function kr(a,b){return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];}
		function nm(a){var l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];}
		function pk(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
		var z = nm(sub(auge, ziel)), x = nm(kr([0,1,0], z)), y = kr(z, x);
		o.set([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -pk(x,auge), -pk(y,auge), -pk(z,auge), 1]);
		return o;
	}
	// Modellmatrix aus Drehmatrix (zeilenweise), Ort und Skalierung je Achse
	function modell(o, R, p, s) {
		o[0] = R[0]*s[0]; o[1] = R[3]*s[0]; o[2] = R[6]*s[0]; o[3] = 0;
		o[4] = R[1]*s[1]; o[5] = R[4]*s[1]; o[6] = R[7]*s[1]; o[7] = 0;
		o[8] = R[2]*s[2]; o[9] = R[5]*s[2]; o[10] = R[8]*s[2]; o[11] = 0;
		o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; o[15] = 1;
		return o;
	}

	// ---------------------------------------------------------- Regler
	function regler(id, ausgabe, format) {
		var el = document.getElementById(id), out = document.getElementById(ausgabe);
		function zeige() { out.innerHTML = format(parseFloat(el.value)); }
		el.addEventListener("input", zeige); zeige();
		return { wert: function () { return parseFloat(el.value); } };
	}
	var rCols = regler("sCols", "oCols", function (v) { return String(v); });
	var rRows = regler("sRows", "oRows", function (v) { return String(v); });
	var rLayers = regler("sLayers", "oLayers", function (v) { return String(v); });
	var rSize = regler("sSize", "oSize", function (v) { return v.toFixed(2) + " m"; });
	var rGap = regler("sGap", "oGap", function (v) { return v.toFixed(3) + " m"; });
	var rMass = regler("sMass", "oMass", function (v) { return v.toFixed(1) + " kg"; });
	var rG = regler("sG", "oG", function (v) { return v.toFixed(1) + " m/s&sup2;"; });
	var rMu = regler("sMu", "oMu", function (v) { return v.toFixed(2); });
	var rE = regler("sE", "oE", function (v) { return v.toFixed(2); });
	var rIt = regler("sIt", "oIt", function (v) { return String(v); });
	var rBM = regler("sBM", "oBM", function (v) { return v.toFixed(0) + " kg"; });
	var rBV = regler("sBV", "oBV", function (v) { return v.toFixed(0) + " m/s"; });

	// ---------------------------------------------------------- Welt
	var welt = new window.RBD.Welt({ g: rG.wert(), iterationen: rIt.wert() });   // 4 Unterschritte, siehe rbd.js
	var boxen = [], kugeln = [], mitte = [0, 1, 0], hoehe = 2;
	var pause = false;

	function baue() {
		welt.leere(); boxen = []; kugeln = [];
		var cols = rCols.wert(), rows = rRows.wert(), layers = rLayers.wert();
		var h = rSize.wert() / 2, gap = rGap.wert(), masse = rMass.wert();
		var schritt = 2 * h + gap;
		var x0 = -(cols - 1) * schritt / 2, z0 = -(rows - 1) * schritt / 2;
		for (var l = 0; l < layers; l++) for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
			// Halber Versatz jeder zweiten Lage wie beim Mauern: das haelt
			var versatz = (l % 2) && cols > 1 ? schritt / 2 : 0;
			var x = x0 + c * schritt + versatz;
			if (l % 2 && cols > 1 && c === cols - 1) continue;
			var b = welt.boxHinzu({ p: [x, h + l * (2 * h + gap) + 0.0005 * l, z0 + r * schritt],
			                        halb: [h, h, h], masse: masse, mu: rMu.wert(), e: rE.wert() });
			// Farbe: Reihen aus Creme und Schiefer, Messing als Akzent
			var muster = (l + c + r) % 7;
			b.farbe = muster === 0 ? 0 : muster < 4 ? 1 : muster === 4 ? 3 : 2;
			b.streu = 0.94 + ((l * 7 + c * 3 + r * 5) % 5) * 0.03;
			boxen.push(b);
		}
		hoehe = layers * (2 * h + gap);
		mitte = [0, hoehe * 0.42, 0];
		kamera.abstand = Math.max(4.5, hoehe * 1.35 + Math.max(cols, rows) * schritt * 0.6);
	}

	function feuere() {
		if (kugeln.length >= 3) { welt.entferne(kugeln.shift()); }
		var auge = kamera.auge();
		var ziel = [mitte[0], Math.max(0.3, hoehe * 0.35), mitte[2]];
		var d = [ziel[0] - auge[0], ziel[1] - auge[1], ziel[2] - auge[2]];
		var l = Math.hypot(d[0], d[1], d[2]) || 1; d = [d[0]/l, d[1]/l, d[2]/l];
		var r = 0.22 + rBM.wert() / 200;
		var start = [auge[0] + d[0] * 1.2, Math.max(r + 0.05, auge[1] + d[1] * 1.2), auge[2] + d[2] * 1.2];
		var k = welt.kugelHinzu({ p: start, r: r, masse: rBM.wert(), mu: 0.4, e: 0.25 });
		k.v = [d[0] * rBV.wert(), d[1] * rBV.wert(), d[2] * rBV.wert()];
		k.geboren = welt.zeit;
		kugeln.push(k);
		welt.weckeAlle();
	}

	function stosse() {
		// Ein Stoss von der Seite in die unterste Lage - der Turm faellt
		welt.weckeAlle();
		var richtung = Math.random() < 0.5 ? 1 : -1;
		boxen.forEach(function (b) {
			if (b.p[1] > rSize.wert() * 1.6) return;
			b.impuls([richtung * b.masse * (2.5 + Math.random() * 2.5), b.masse * 0.6, (Math.random() - 0.5) * b.masse],
			         [b.p[0], b.p[1] + rSize.wert() * 0.3, b.p[2]]);
		});
	}

	// ---------------------------------------------------------- Kamera
	var kamera = { gier: 0.55, neigung: 0.42, abstand: 8, ziehen: false, ruhigSeit: 0 };
	kamera.auge = function () {
		var cy = Math.cos(kamera.neigung), sy = Math.sin(kamera.neigung);
		return [mitte[0] + kamera.abstand * cy * Math.sin(kamera.gier),
		        mitte[1] + kamera.abstand * sy,
		        mitte[2] + kamera.abstand * cy * Math.cos(kamera.gier)];
	};
	var letzterZeiger = null;
	leinwand.addEventListener("pointerdown", function (e) {
		kamera.ziehen = true; letzterZeiger = [e.clientX, e.clientY];
		leinwand.setPointerCapture(e.pointerId); leinwand.classList.add("dragging");
	});
	leinwand.addEventListener("pointermove", function (e) {
		if (!kamera.ziehen) return;
		kamera.gier -= (e.clientX - letzterZeiger[0]) * 0.006;
		kamera.neigung = Math.max(0.08, Math.min(1.25, kamera.neigung + (e.clientY - letzterZeiger[1]) * 0.005));
		letzterZeiger = [e.clientX, e.clientY]; kamera.ruhigSeit = 0;
	});
	function loslassen() { kamera.ziehen = false; leinwand.classList.remove("dragging"); }
	leinwand.addEventListener("pointerup", loslassen);
	leinwand.addEventListener("pointercancel", loslassen);
	leinwand.addEventListener("wheel", function (e) {
		e.preventDefault();
		kamera.abstand = Math.max(2.5, Math.min(30, kamera.abstand * (1 + e.deltaY * 0.0012)));
		kamera.ruhigSeit = 0;
	}, { passive: false });

	// ---------------------------------------------------------- Bedienung
	document.getElementById("bFire").addEventListener("click", feuere);
	document.getElementById("bPush").addEventListener("click", stosse);
	document.getElementById("bBuild").addEventListener("click", baue);
	var bPause = document.getElementById("bPause");
	bPause.addEventListener("click", function () { pause = !pause; bPause.setAttribute("aria-pressed", String(pause)); });
	var bTune = document.getElementById("bTune"), tuner = document.getElementById("tuner");
	bTune.addEventListener("click", function () {
		var offen = tuner.classList.toggle("open"); bTune.setAttribute("aria-pressed", String(offen));
	});
	addEventListener("keydown", function (e) {
		if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON")) return;
		if (e.key === " ") { e.preventDefault(); feuere(); }
		if (e.key === "r" || e.key === "R") baue();
		if (e.key === "p" || e.key === "P") bPause.click();
	});
	["sG", "sMu", "sE", "sIt"].forEach(function (id) {
		document.getElementById(id).addEventListener("input", function () {
			welt.g = rG.wert(); welt.iterationen = rIt.wert();
			welt.koerper.forEach(function (k) { if (k.typ === "box") { k.mu = rMu.wert(); k.e = rE.wert(); } });
			welt.weckeAlle();
		});
	});

	// ---------------------------------------------------------- Bild
	var tBodies = document.getElementById("tBodies"), tAwake = document.getElementById("tAwake");
	var tContacts = document.getElementById("tContacts"), tStep = document.getElementById("tStep");
	var tFps = document.getElementById("tFps");
	var proj = m4(), ansicht = m4(), vp = m4(), mm = m4();
	var bilder = 0, fpsZeit = 0, fps = 60, zuletzt = 0, akku = 0;
	/*
	 * 60 Hz mit vier Unterschritten (240 Teilschritte je Sekunde - weniger
	 * traegt keinen Turm, siehe rbd.js). Vorher lief die Schleife mit 120 Hz
	 * Schritten, und weil dt gedeckelt ist, holte der Akkumulator bei jedem
	 * langsamen Bild bis zu sechs Schritte nach: eine Spirale, in der die
	 * Bildrate immer weiter fiel. Hoechstens drei Schritte je Bild; wenn die
	 * Maschine nicht nachkommt, laeuft die Zeit langsamer statt zu kippen.
	 */
	var SCHRITT = 1 / 60, SCHRITTE_MAX = 3;
	var EINS = [1,0,0, 0,1,0, 0,0,1];

	// GPU-Zustand, gefuellt in start()
	var device = null, context = null, format = null, verloren = false;
	var pipeLit, pipeBg, pipeS, gruppeLit, gruppeBg, gruppeS;
	var bSzene, bHg, bVoll;
	var netzWuerfel, netzKugel, netzBoden, netzFleck;
	var msaaTex = null, tiefeTex = null, msaaView = null, tiefeView = null;
	var szeneDaten = new Float32Array(32), hgDaten = new Float32Array(8);
	// Instanzpuffer wachsen nur bei Bedarf (Rebuild), nie je Bild neu
	var INST_FLOATS = 36, FLECK_FLOATS = 20;
	var bInst = null, instKap = 0, instDaten = null;
	var bFleck = null, fleckKap = 0, fleckDaten = null;

	function gpuPuffer(daten, nutzung, name) {
		var groesse = Math.ceil(daten.byteLength / 4) * 4;          // Vielfaches von 4 Byte
		var b = device.createBuffer({ label: name, size: groesse, usage: nutzung, mappedAtCreation: true });
		new daten.constructor(b.getMappedRange()).set(daten);
		b.unmap();
		return b;
	}
	function Netz(d, name) {
		this.n = d.idx.length;
		this.bPos = gpuPuffer(new Float32Array(d.pos), GPUBufferUsage.VERTEX, name + " pos");
		this.bNrm = d.nrm ? gpuPuffer(new Float32Array(d.nrm), GPUBufferUsage.VERTEX, name + " nrm") : null;
		this.bIdx = gpuPuffer(new Uint16Array(d.idx), GPUBufferUsage.INDEX, name + " idx");
	}
	Netz.prototype.binde = function (pass) {
		pass.setVertexBuffer(0, this.bPos);
		if (this.bNrm) pass.setVertexBuffer(1, this.bNrm);
		pass.setIndexBuffer(this.bIdx, "uint16");
	};
	function sichereInstanzen(anzahl) {
		if (anzahl <= instKap) return;
		if (bInst) bInst.destroy();
		instKap = anzahl + 64;
		instDaten = new Float32Array(instKap * INST_FLOATS);
		bInst = device.createBuffer({ label: "instanzen", size: instKap * INST_FLOATS * 4,
		                              usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
	}
	function sichereFlecken(anzahl) {
		if (anzahl <= fleckKap) return;
		if (bFleck) bFleck.destroy();
		fleckKap = anzahl + 64;
		fleckDaten = new Float32Array(fleckKap * FLECK_FLOATS);
		bFleck = device.createBuffer({ label: "flecken", size: fleckKap * FLECK_FLOATS * 4,
		                               usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
	}

	async function schattierer(name, quelle) {
		var modul = device.createShaderModule({ label: name, code: quelle });
		var info = await modul.getCompilationInfo();
		info.messages.forEach(function (m) {
			var text = "WGSL " + name + " " + m.lineNum + ":" + m.linePos + " " + m.message;
			if (m.type === "error") console.error(text); else console.warn(text);
		});
		return modul;
	}
	function pipeline(name, modul, o) {
		return device.createRenderPipeline({
			label: name,
			layout: "auto",
			vertex: { module: modul, entryPoint: "vs", buffers: o.puffer },
			fragment: { module: modul, entryPoint: "fs", targets: [{ format: format, blend: o.blend }] },
			primitive: { topology: o.topologie || "triangle-list", cullMode: o.cull, frontFace: "ccw" },
			depthStencil: { format: "depth24plus", depthWriteEnabled: o.tiefeSchreiben, depthCompare: o.tiefeVergleich },
			multisample: { count: 4 }
		});
	}
	var ATTR_POS = { arrayStride: 12, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] };
	var ATTR_NRM = { arrayStride: 12, stepMode: "vertex", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] };
	var ATTR_INST = { arrayStride: INST_FLOATS * 4, stepMode: "instance", attributes: [
		{ shaderLocation: 2, offset: 0, format: "float32x4" },
		{ shaderLocation: 3, offset: 16, format: "float32x4" },
		{ shaderLocation: 4, offset: 32, format: "float32x4" },
		{ shaderLocation: 5, offset: 48, format: "float32x4" },
		{ shaderLocation: 6, offset: 64, format: "float32x3" },
		{ shaderLocation: 7, offset: 80, format: "float32x3" },
		{ shaderLocation: 8, offset: 96, format: "float32x3" },
		{ shaderLocation: 9, offset: 112, format: "float32x4" },
		{ shaderLocation: 10, offset: 128, format: "float32x2" }
	] };
	var ATTR_FLECK = { arrayStride: FLECK_FLOATS * 4, stepMode: "instance", attributes: [
		{ shaderLocation: 1, offset: 0, format: "float32x4" },
		{ shaderLocation: 2, offset: 16, format: "float32x4" },
		{ shaderLocation: 3, offset: 32, format: "float32x4" },
		{ shaderLocation: 4, offset: 48, format: "float32x4" },
		{ shaderLocation: 5, offset: 64, format: "float32" }
	] };

	async function bauePipelines() {
		var modLit = await schattierer("lit", WGSL_LIT);
		var modBg = await schattierer("hintergrund", WGSL_BG);
		var modS = await schattierer("schatten", WGSL_S);
		// Hintergrund: keine Tiefe, kein Culling, kein Blend (wie WebGL vor dem clear(DEPTH))
		pipeBg = pipeline("hintergrund", modBg, {
			puffer: [{ arrayStride: 8, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
			topologie: "triangle-strip", cull: "none", tiefeSchreiben: false, tiefeVergleich: "always"
		});
		// Beleuchtete Koerper: Tiefe LESS mit Schreiben, Rueckseiten weg
		pipeLit = pipeline("lit", modLit, {
			puffer: [ATTR_POS, ATTR_NRM, ATTR_INST], cull: "back", tiefeSchreiben: true, tiefeVergleich: "less"
		});
		// Schattenflecken: SRC_ALPHA / ONE_MINUS_SRC_ALPHA, Tiefe lesen, nicht schreiben
		pipeS = pipeline("schatten", modS, {
			puffer: [ATTR_POS, ATTR_FLECK], cull: "back", tiefeSchreiben: false, tiefeVergleich: "less",
			blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
			         alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" } }
		});

		bSzene = device.createBuffer({ label: "szene", size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		bHg = device.createBuffer({ label: "hintergrund", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		gruppeLit = device.createBindGroup({ layout: pipeLit.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bSzene } }] });
		gruppeS = device.createBindGroup({ layout: pipeS.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bSzene } }] });
		gruppeBg = device.createBindGroup({ layout: pipeBg.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bHg } }] });

		netzWuerfel = new Netz(wuerfelDaten(), "wuerfel");
		netzKugel = new Netz(kugelDaten(18, 28), "kugel");
		netzBoden = new Netz(flaecheDaten(40), "boden");
		netzFleck = new Netz({ pos: [-1,0,-1, 1,0,-1, 1,0,1, -1,0,1], nrm: null, idx: [0,2,1, 0,3,2] }, "fleck");
		bVoll = gpuPuffer(new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), GPUBufferUsage.VERTEX, "vollbild");
		sichereInstanzen(256); sichereFlecken(256);
	}

	function groesse() {
		var dpr = Math.min(devicePixelRatio || 1, 2);
		var grenze = device.limits.maxTextureDimension2D;
		var b = Math.min(grenze, Math.max(1, Math.floor(leinwand.clientWidth * dpr)));
		var h = Math.min(grenze, Math.max(1, Math.floor(leinwand.clientHeight * dpr)));
		if (leinwand.width !== b || leinwand.height !== h || !msaaTex) {
			leinwand.width = b; leinwand.height = h;
			if (msaaTex) msaaTex.destroy();
			if (tiefeTex) tiefeTex.destroy();
			msaaTex = device.createTexture({ label: "msaa farbe", size: [b, h], sampleCount: 4, format: format,
			                                 usage: GPUTextureUsage.RENDER_ATTACHMENT });
			tiefeTex = device.createTexture({ label: "msaa tiefe", size: [b, h], sampleCount: 4, format: "depth24plus",
			                                  usage: GPUTextureUsage.RENDER_ATTACHMENT });
			msaaView = msaaTex.createView(); tiefeView = tiefeTex.createView();
		}
		return b / h;
	}

	// Ein Eintrag im Instanzpuffer: wie zeichneKoerper() der WebGL-Fassung,
	// nur dass die Werte gesammelt und einmal je Bild hochgeladen werden.
	function schreibeInstanz(i, R, p, s, farbe, glanz, leucht, metall) {
		var o = i * INST_FLOATS, d = instDaten;
		modell(mm, R, p, s);
		d.set(mm, o);                                                // Modellmatrix, spaltenweise
		d[o+16] = R[0]; d[o+17] = R[3]; d[o+18] = R[6];              // Normalenmatrix = R, Spalte 0
		d[o+20] = R[1]; d[o+21] = R[4]; d[o+22] = R[7];              // Spalte 1
		d[o+24] = R[2]; d[o+25] = R[5]; d[o+26] = R[8];              // Spalte 2
		d[o+28] = farbe[0]; d[o+29] = farbe[1]; d[o+30] = farbe[2]; d[o+31] = glanz;
		d[o+32] = leucht || 0; d[o+33] = metall || 0;
	}

	function zeichne(jetzt) {
		if (verloren) return;
		var dt = Math.min((jetzt - zuletzt) / 1000, 0.05); zuletzt = jetzt;
		if (!pause) {
			akku = Math.min(akku + dt, SCHRITT * SCHRITTE_MAX);
			while (akku >= SCHRITT) { welt.schritt(SCHRITT); akku -= SCHRITT; }
			// Alte Kugeln aufraeumen
			for (var i = kugeln.length - 1; i >= 0; i--) {
				if (welt.zeit - kugeln[i].geboren > 12) { welt.entferne(kugeln[i]); kugeln.splice(i, 1); }
			}
		}
		// Kamera: sanft von selbst kreisen, wenn niemand zieht
		kamera.ruhigSeit += dt;
		if (!kamera.ziehen && kamera.ruhigSeit > 4) kamera.gier += dt * 0.045;

		var ar = groesse();
		perspektive(proj, 42 * Math.PI / 180, ar, 0.05, 120);
		tiefeNullEins(proj);
		var auge = kamera.auge();
		blickAuf(ansicht, auge, mitte);
		mul(vp, proj, ansicht);

		// Uniforms je Bild: Kamera und Licht, Verlauf
		szeneDaten.set(vp, 0);
		szeneDaten[16] = auge[0]; szeneDaten[17] = auge[1]; szeneDaten[18] = auge[2];
		szeneDaten[20] = -0.45; szeneDaten[21] = 0.85; szeneDaten[22] = 0.35;
		szeneDaten[24] = PAL.key[0]; szeneDaten[25] = PAL.key[1]; szeneDaten[26] = PAL.key[2];
		szeneDaten[28] = PAL.fill[0]; szeneDaten[29] = PAL.fill[1]; szeneDaten[30] = PAL.fill[2];
		device.queue.writeBuffer(bSzene, 0, szeneDaten);
		hgDaten[0] = PAL.oben[0]; hgDaten[1] = PAL.oben[1]; hgDaten[2] = PAL.oben[2];
		hgDaten[4] = PAL.unten[0]; hgDaten[5] = PAL.unten[1]; hgDaten[6] = PAL.unten[2];
		device.queue.writeBuffer(bHg, 0, hgDaten);

		// Instanzen: Boden (0), dann Kisten, dann Kugeln
		var K = welt.koerper, kontakte = welt.kontakte.length;
		sichereInstanzen(1 + K.length);
		schreibeInstanz(0, EINS, [0, 0, 0], [1, 1, 1], PAL.boden, 18, 0, 0);
		var n = 1, nBox = 0, nKugel = 0;
		K.forEach(function (k) {
			if (k.typ !== "box") return;
			var blitz = Math.min(1, k.treffer / 6);
			var f = PAL.boxen[k.farbe], st = k.streu || 1;
			var farbe = [f[0] * st, f[1] * st, f[2] * st];
			if (k.schlaeft) farbe = [farbe[0] * 0.92, farbe[1] * 0.92, farbe[2] * 0.92];
			schreibeInstanz(n++, k.R, k.p, k.halb, farbe, 24, blitz * 0.9, 0.05); nBox++;
		});
		K.forEach(function (k) {
			if (k.typ === "box") return;
			var blitz = Math.min(1, k.treffer / 6);
			schreibeInstanz(n++, k.R, k.p, [k.r, k.r, k.r], PAL.kugel, 90, blitz * 0.5, 0.9); nKugel++;
		});
		device.queue.writeBuffer(bInst, 0, instDaten, 0, n * INST_FLOATS);

		// Kontaktschatten: ein Fleck je Koerper, groesser und schwaecher mit der Hoehe
		sichereFlecken(K.length);
		K.forEach(function (k, j) {
			var ex = (k.max[0] - k.min[0]) / 2, ez = (k.max[2] - k.min[2]) / 2;
			var h = Math.max(0, k.min[1]);
			var s = 1.25 + h * 0.35;
			modell(mm, EINS, [k.p[0], 0.003, k.p[2]], [ex * s, 1, ez * s]);
			fleckDaten.set(mm, j * FLECK_FLOATS);
			fleckDaten[j * FLECK_FLOATS + 16] = 0.62 / (1 + h * 1.4);
		});
		if (K.length) device.queue.writeBuffer(bFleck, 0, fleckDaten, 0, K.length * FLECK_FLOATS);

		// Ein Pass: Hintergrund, Boden, Schatten, Koerper - Reihenfolge wie in WebGL
		var enc = device.createCommandEncoder();
		var pass = enc.beginRenderPass({
			colorAttachments: [{ view: msaaView, resolveTarget: context.getCurrentTexture().createView(),
			                     loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
			depthStencilAttachment: { view: tiefeView, depthLoadOp: "clear", depthClearValue: 1.0, depthStoreOp: "discard" }
		});
		pass.setPipeline(pipeBg); pass.setBindGroup(0, gruppeBg);
		pass.setVertexBuffer(0, bVoll); pass.draw(4);

		pass.setPipeline(pipeLit); pass.setBindGroup(0, gruppeLit);
		pass.setVertexBuffer(2, bInst);
		netzBoden.binde(pass); pass.drawIndexed(netzBoden.n, 1, 0, 0, 0);

		if (K.length) {
			pass.setPipeline(pipeS); pass.setBindGroup(0, gruppeS);
			pass.setVertexBuffer(0, netzFleck.bPos); pass.setVertexBuffer(1, bFleck);
			pass.setIndexBuffer(netzFleck.bIdx, "uint16");
			pass.drawIndexed(netzFleck.n, K.length, 0, 0, 0);
		}

		pass.setPipeline(pipeLit); pass.setBindGroup(0, gruppeLit);
		pass.setVertexBuffer(2, bInst);
		if (nBox) { netzWuerfel.binde(pass); pass.drawIndexed(netzWuerfel.n, nBox, 0, 0, 1); }
		if (nKugel) { netzKugel.binde(pass); pass.drawIndexed(netzKugel.n, nKugel, 0, 0, 1 + nBox); }
		pass.end();
		device.queue.submit([enc.finish()]);

		bilder++; fpsZeit += dt;
		if (fpsZeit >= 0.4) { fps = Math.round(bilder / fpsZeit); bilder = 0; fpsZeit = 0;
			tBodies.textContent = String(welt.koerper.length);
			tAwake.textContent = String(welt.anzWach);
			tContacts.textContent = String(kontakte);
			tStep.textContent = welt.msSchritt.toFixed(1) + " ms";
			tFps.textContent = fps + " fps";
			tFps.className = fps < 45 ? "hot" : "";
		}
		requestAnimationFrame(zeichne);
	}

	// ---------------------------------------------------------- Start
	baue();
	async function start() {
		var gpu;
		try {
			gpu = await starteWebGPU(leinwand);
		} catch (e) {
			console.error("WebGPU:", e && e.message ? e.message : e);
			return rueckfall("exception during setup");
		}
		if (!gpu) return;                                            // Rueckfall laeuft bereits
		device = gpu.device; context = gpu.context; format = gpu.format;
		device.lost.then(function (info) { if (info.reason !== "destroyed") verloren = true; });
		// Alles, was beim Anlegen schiefgehen kann, in einem Validierungsrahmen
		device.pushErrorScope("validation");
		try {
			await bauePipelines();
		} catch (e) {
			console.error("WebGPU:", e && e.message ? e.message : e);
			await device.popErrorScope();
			return rueckfall("exception during setup");
		}
		var fehler = await device.popErrorScope();
		if (fehler) { console.error("WebGPU validation:", fehler.message); return rueckfall("validation error"); }
		zuletzt = performance.now();
		zeichne(zuletzt);
	}
	start();
})();
