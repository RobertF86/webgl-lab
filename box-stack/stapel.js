/*
 * FRIDAYVFX Box Stack - Szene, Darstellung, Bedienung
 *
 * Die Physik steht in rbd.js. Hier: der Stapel aus den Reglern, die Kamera,
 * das Bild (WebGL 1) und die Anzeige. Bildsprache wie in den uebrigen Demos:
 * weicher Verlauf hinter allem, Studioboden mit Kontaktschatten, warmes
 * Fuehrungslicht, kuehles Fuelllicht, Messing als Akzent.
 */
(function () {
	"use strict";

	var leinwand = document.getElementById("gl");
	var gl = leinwand.getContext("webgl", { antialias: true, alpha: false })
	      || leinwand.getContext("experimental-webgl");
	if (!gl) { document.getElementById("fallback").classList.add("show"); return; }

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

	// ---------------------------------------------------------- Shader
	var VS_LIT = [
		"attribute vec3 aPos, aNrm;",
		"uniform mat4 uMVP, uModell; uniform mat3 uNormM;",
		"varying vec3 vN, vP;",
		"void main(){ vec4 w = uModell * vec4(aPos, 1.0); vP = w.xyz; vN = uNormM * aNrm;",
		"  gl_Position = uMVP * vec4(aPos, 1.0); }"
	].join("\n");
	var FS_LIT = [
		"precision highp float;",
		"varying vec3 vN, vP;",
		"uniform vec3 uFarbe, uKey, uFill, uAuge, uLicht;",
		"uniform float uGlanz, uLeucht, uMetall;",
		"void main(){",
		"  vec3 N = normalize(vN), V = normalize(uAuge - vP), L = normalize(uLicht);",
		"  vec3 key = pow(uKey, vec3(2.2)), fill = pow(uFill, vec3(2.2));",
		"  float d = max(dot(N, L), 0.0);",
		"  float himmel = N.y * 0.5 + 0.5;",
		"  vec3 amb = mix(fill * 0.55, key * 0.22, himmel);",
		"  vec3 H = normalize(L + V);",
		"  float s = pow(max(dot(N, H), 0.0), uGlanz);",
		"  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);",
		"  vec3 c = uFarbe * (amb + key * d * 0.95)",
		"         + key * s * (0.12 + uMetall * 0.7)",
		"         + fill * fres * (0.10 + uMetall * 0.4)",
		"         + uFarbe * uLeucht;",
		"  c = c / (c + vec3(0.85));",
		"  gl_FragColor = vec4(pow(c, vec3(0.4545)), 1.0);",
		"}"
	].join("\n");
	var VS_V = ["attribute vec2 aPos; varying vec2 vUv;",
	            "void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }"].join("\n");
	var FS_BG = ["precision mediump float; varying vec2 vUv; uniform vec3 uOben, uUnten;",
	             "void main(){ vec3 c = mix(uUnten, uOben, pow(clamp(vUv.y, 0.0, 1.0), 0.85));",
	             "  float v = distance(vUv, vec2(0.5, 0.55)); c *= 1.0 - smoothstep(0.28, 0.95, v) * 0.42;",
	             "  gl_FragColor = vec4(pow(c, vec3(0.4545)), 1.0); }"].join("\n");
	// Schattenfleck: weiches Oval, Alpha aus dem Abstand zur Mitte
	var VS_S = ["attribute vec3 aPos; uniform mat4 uMVP; varying vec2 vUv;",
	            "void main(){ vUv = aPos.xz; gl_Position = uMVP * vec4(aPos, 1.0); }"].join("\n");
	var FS_S = ["precision mediump float; varying vec2 vUv; uniform float uStaerke;",
	            "void main(){ float r = length(vUv); float a = (1.0 - smoothstep(0.35, 1.0, r)) * uStaerke;",
	            "  gl_FragColor = vec4(0.0, 0.0, 0.0, a); }"].join("\n");

	function programm(vs, fs) {
		function sh(t, q) { var s = gl.createShader(t); gl.shaderSource(s, q); gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
		var p = gl.createProgram();
		gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
		p.a = {}; p.u = {};
		var n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES), i;
		for (i = 0; i < n; i++) { var a = gl.getActiveAttrib(p, i); p.a[a.name] = gl.getAttribLocation(p, a.name); }
		n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
		for (i = 0; i < n; i++) { var u = gl.getActiveUniform(p, i); p.u[u.name] = gl.getUniformLocation(p, u.name); }
		return p;
	}
	var progLit, progBg, progS;
	try { progLit = programm(VS_LIT, FS_LIT); progBg = programm(VS_V, FS_BG); progS = programm(VS_S, FS_S); }
	catch (e) { document.getElementById("fallbackMsg").textContent = "Shader failed: " + e.message;
	            document.getElementById("fallback").classList.add("show"); return; }

	// ---------------------------------------------------------- Netze
	function Netz(pos, nrm, idx) {
		this.n = idx.length;
		function puffer(d, Typ, ziel) { var b = gl.createBuffer(); gl.bindBuffer(ziel, b); gl.bufferData(ziel, new Typ(d), gl.STATIC_DRAW); return b; }
		this.bPos = puffer(pos, Float32Array, gl.ARRAY_BUFFER);
		this.bNrm = nrm ? puffer(nrm, Float32Array, gl.ARRAY_BUFFER) : null;
		this.bIdx = puffer(idx, Uint16Array, gl.ELEMENT_ARRAY_BUFFER);
	}
	Netz.prototype.zeichne = function (p) {
		gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos);
		gl.enableVertexAttribArray(p.a.aPos); gl.vertexAttribPointer(p.a.aPos, 3, gl.FLOAT, false, 0, 0);
		if (this.bNrm && p.a.aNrm !== undefined) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.bNrm);
			gl.enableVertexAttribArray(p.a.aNrm); gl.vertexAttribPointer(p.a.aNrm, 3, gl.FLOAT, false, 0, 0);
		}
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
		gl.drawElements(gl.TRIANGLES, this.n, gl.UNSIGNED_SHORT, 0);
	};
	function wuerfelNetz() {
		var pos = [], nrm = [], idx = [];
		var seiten = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
		seiten.forEach(function (n, s) {
			var u = n[1] || n[2] ? [1,0,0] : [0,1,0];
			var v = [n[1]*u[2]-n[2]*u[1], n[2]*u[0]-n[0]*u[2], n[0]*u[1]-n[1]*u[0]];
			var b = pos.length / 3;
			[[-1,-1],[1,-1],[1,1],[-1,1]].forEach(function (e) {
				pos.push(n[0] + u[0]*e[0] + v[0]*e[1], n[1] + u[1]*e[0] + v[1]*e[1], n[2] + u[2]*e[0] + v[2]*e[1]);
				nrm.push(n[0], n[1], n[2]);
			});
			idx.push(b, b+1, b+2, b, b+2, b+3);
		});
		return new Netz(pos, nrm, idx);
	}
	function kugelNetz(ringe, seiten) {
		var pos = [], nrm = [], idx = [], i, k;
		for (i = 0; i <= ringe; i++) { var phi = i / ringe * Math.PI;
			for (k = 0; k <= seiten; k++) { var th = k / seiten * Math.PI * 2;
				var x = Math.sin(phi)*Math.cos(th), y = Math.cos(phi), z = Math.sin(phi)*Math.sin(th);
				pos.push(x, y, z); nrm.push(x, y, z); } }
		for (i = 0; i < ringe; i++) for (k = 0; k < seiten; k++) {
			var a = i*(seiten+1)+k, b = a+1, c = a+seiten+1, d = c+1; idx.push(a, c, d, a, d, b); }
		return new Netz(pos, nrm, idx);
	}
	function flaecheNetz(S) {
		return new Netz([-S,0,-S, S,0,-S, S,0,S, -S,0,S], [0,1,0, 0,1,0, 0,1,0, 0,1,0], [0,2,1, 0,3,2]);
	}
	var netzWuerfel = wuerfelNetz(), netzKugel = kugelNetz(18, 28), netzBoden = flaecheNetz(40);
	var netzFleck = new Netz([-1,0,-1, 1,0,-1, 1,0,1, -1,0,1], null, [0,2,1, 0,3,2]);
	var bVoll = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bVoll);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

	// ---------------------------------------------------------- Matrizen
	function m4() { return new Float32Array(16); }
	function mul(o, a, b) { for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
		var s = 0; for (var k = 0; k < 4; k++) s += a[k*4+j] * b[i*4+k]; o[i*4+j] = s; } return o; }
	function perspektive(o, fovy, ar, nah, fern) { var f = 1 / Math.tan(fovy / 2);
		o.set([f/ar,0,0,0, 0,f,0,0, 0,0,(fern+nah)/(nah-fern),-1, 0,0,2*fern*nah/(nah-fern),0]); return o; }
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
	var IDENT3 = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
	function normalMat(R) { return new Float32Array([R[0],R[3],R[6], R[1],R[4],R[7], R[2],R[5],R[8]]); }

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
	var proj = m4(), ansicht = m4(), mvp = m4(), tmp = m4(), mm = m4();
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

	function groesse() {
		var dpr = Math.min(devicePixelRatio || 1, 2);
		var b = Math.max(1, Math.floor(leinwand.clientWidth * dpr)), h = Math.max(1, Math.floor(leinwand.clientHeight * dpr));
		if (leinwand.width !== b || leinwand.height !== h) { leinwand.width = b; leinwand.height = h; gl.viewport(0, 0, b, h); }
		return b / h;
	}

	function zeichneKoerper(netz, R, p, s, farbe, glanz, leucht, metall) {
		modell(mm, R, p, s);
		mul(tmp, ansicht, mm); mul(mvp, proj, tmp);
		gl.uniformMatrix4fv(progLit.u.uMVP, false, mvp);
		gl.uniformMatrix4fv(progLit.u.uModell, false, mm);
		gl.uniformMatrix3fv(progLit.u.uNormM, false, normalMat(R));
		gl.uniform3fv(progLit.u.uFarbe, farbe);
		gl.uniform1f(progLit.u.uGlanz, glanz); gl.uniform1f(progLit.u.uLeucht, leucht || 0);
		gl.uniform1f(progLit.u.uMetall, metall || 0);
		netz.zeichne(progLit);
	}
	var EINS = [1,0,0, 0,1,0, 0,0,1];

	function zeichne(jetzt) {
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
		var auge = kamera.auge();
		blickAuf(ansicht, auge, mitte);

		// Hintergrund
		gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND); gl.depthMask(false);
		gl.useProgram(progBg);
		gl.bindBuffer(gl.ARRAY_BUFFER, bVoll);
		gl.enableVertexAttribArray(progBg.a.aPos); gl.vertexAttribPointer(progBg.a.aPos, 2, gl.FLOAT, false, 0, 0);
		gl.uniform3fv(progBg.u.uOben, PAL.oben); gl.uniform3fv(progBg.u.uUnten, PAL.unten);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);

		// Boden
		gl.useProgram(progLit);
		gl.uniform3fv(progLit.u.uKey, PAL.key); gl.uniform3fv(progLit.u.uFill, PAL.fill);
		gl.uniform3fv(progLit.u.uAuge, auge);
		gl.uniform3f(progLit.u.uLicht, -0.45, 0.85, 0.35);
		zeichneKoerper(netzBoden, EINS, [0, 0, 0], [1, 1, 1], PAL.boden, 18, 0, 0);

		// Kontaktschatten: ein Fleck je Koerper, groesser und schwaecher mit der Hoehe
		gl.useProgram(progS);
		gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
		welt.koerper.forEach(function (k) {
			var ex = (k.max[0] - k.min[0]) / 2, ez = (k.max[2] - k.min[2]) / 2;
			var h = Math.max(0, k.min[1]);
			var s = 1.25 + h * 0.35;
			modell(mm, EINS, [k.p[0], 0.003, k.p[2]], [ex * s, 1, ez * s]);
			mul(tmp, ansicht, mm); mul(mvp, proj, tmp);
			gl.uniformMatrix4fv(progS.u.uMVP, false, mvp);
			gl.uniform1f(progS.u.uStaerke, 0.62 / (1 + h * 1.4));
			netzFleck.zeichne(progS);
		});
		gl.depthMask(true); gl.disable(gl.BLEND);

		// Koerper
		gl.useProgram(progLit);
		var kontakte = welt.kontakte.length;
		welt.koerper.forEach(function (k) {
			var blitz = Math.min(1, k.treffer / 6);
			if (k.typ === "box") {
				var f = PAL.boxen[k.farbe], st = k.streu || 1;
				var farbe = [f[0] * st, f[1] * st, f[2] * st];
				if (k.schlaeft) farbe = [farbe[0] * 0.92, farbe[1] * 0.92, farbe[2] * 0.92];
				zeichneKoerper(netzWuerfel, k.R, k.p, k.halb, farbe, 24, blitz * 0.9, 0.05);
			} else {
				zeichneKoerper(netzKugel, k.R, k.p, [k.r, k.r, k.r], PAL.kugel, 90, blitz * 0.5, 0.9);
			}
		});

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

	baue();
	zuletzt = performance.now();
	zeichne(zuletzt);
})();
