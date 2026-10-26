/*
 * ISS Tracker - GPU-Helfer (WebGPU)
 *
 * Geraete-Start, Shader mit Fehlerausgabe, Puffer, Texturen mit Mipmaps
 * (auch je Schicht einer 2D-Array-Textur: erzeugeMipmapsLayer), Sampler,
 * Kugelnetz und die Matrixhelfer, die auch die Kamera (kamera.js) benutzt.
 * Kein Rueckfall auf WebGL: ohne WebGPU erscheint der Hinweis im Overlay
 * #fehler und starte() liefert null.
 *
 * Konventionen:
 *   - Matrizen: Float32Array(16), spaltenweise (WGSL): m[spalte*4 + zeile].
 *   - Tiefe umgekehrt (Reversed-Z): nah -> 1, fern -> 0, Vergleich 'greater'.
 *   - Kugel: Radius 1, +Z Nordpol, u = lon/(2 pi) + 0.5, v = 0.5 - lat/pi,
 *     Naht bei 180 Grad West/Ost doppelt, Vorderseite gegen den Uhrzeigersinn.
 *
 * Nichts hier fasst auf oberster Ebene navigator oder document an - die Datei
 * wird in den Tests unter Node geladen.
 */
(function (window) {
	"use strict";

	// ---------------------------------------------------------- Geraete-Start
	// Hinweis-Overlay (#fehler): fehlendes WebGPU, Startfehler, Geraeteverlust.
	function zeigeHinweis(text) {
		var feld = document.getElementById("fehler");
		if (!feld) return;
		feld.textContent = text;
		feld.hidden = false;
	}
	// console.warn statt console.error: kein Fehler der Seite, sondern ein
	// Browser ohne WebGPU.
	function nichtVerfuegbar(grund) {
		console.warn("WebGPU unavailable (" + grund + ")");
		zeigeHinweis("WebGPU is not available in this browser.");
		return null;
	}

	async function starte(canvas) {
		if (!navigator.gpu) return nichtVerfuegbar(window.isSecureContext ? "no navigator.gpu" : "insecure context, WebGPU needs https or localhost");
		var adapter, device;
		try {
			adapter = await navigator.gpu.requestAdapter();
			if (!adapter) return nichtVerfuegbar("no adapter");
			// Keine optionalen Features oder Limits: die Demo muss mit den
			// Standardlimits laufen, auch auf iPhone/Safari.
			device = await adapter.requestDevice();
		} catch (e) {
			console.error("WebGPU start failed: " + (e && e.message ? e.message : e));
			zeigeHinweis("WebGPU could not be started in this browser.");
			return null;
		}
		device.addEventListener("uncapturederror", function (e) {
			console.error("WebGPU:", e.error.message);
		});
		device.lost.then(function (info) {
			if (info.reason !== "destroyed") {
				console.warn("WebGPU device lost: " + info.message);
				zeigeHinweis("GPU device lost: " + info.message);
			}
		});
		var context = canvas.getContext("webgpu");
		if (!context) {
			// Task 12c: das schon angelegte Geraet freigeben (lost meldet dann
			// "destroyed", ohne zweiten Hinweis)
			try { device.destroy(); } catch (e) { /* schon weg */ }
			return nichtVerfuegbar("no webgpu context");
		}
		var format = navigator.gpu.getPreferredCanvasFormat();      // in Chrome meist bgra8unorm
		context.configure({ device: device, format: format, alphaMode: "opaque" });
		return { device: device, context: context, format: format, adapter: adapter };
	}

	// ---------------------------------------------------------- Shader, Puffer
	// Wartet nicht auf den Compiler; Meldungen (Zeile:Spalte) laufen nach, wenn
	// sie kommen. Ein Fehler zeigt sich ohnehin sofort beim Pipeline-Bau.
	function shader(device, code, label) {
		var modul = device.createShaderModule({ label: label, code: code });
		modul.getCompilationInfo().then(function (info) {
			info.messages.forEach(function (m) {
				var text = "WGSL " + (label || "") + " " + m.type + " (line " + m.lineNum + ":" + m.linePos + "): " + m.message;
				if (m.type === "error") console.error(text); else console.warn(text);
			});
		});
		return modul;
	}

	// Statischer Puffer ueber mappedAtCreation. Puffergroessen muessen ein
	// Vielfaches von 4 sein - bei ungerader Anzahl Uint16-Indizes wird aufgefuellt.
	function puffer(device, daten, usage) {
		var p = device.createBuffer({
			size: Math.ceil(daten.byteLength / 4) * 4,
			usage: usage,
			mappedAtCreation: true
		});
		new daten.constructor(p.getMappedRange()).set(daten);
		p.unmap();
		return p;
	}

	// Uniform-Puffer; Groesse auf 16 aufgerundet, weil WGSL-Structs auf ihr
	// groesstes Alignment (16) aufgerundet werden und der Puffer sonst zu klein ist.
	function uniform(device, bytes) {
		return device.createBuffer({
			size: Math.ceil(bytes / 16) * 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}

	// ---------------------------------------------------------- Texturen, Mipmaps
	// Vollbild-Dreieck aus vertex_index, jede Stufe liest die vorige mit
	// textureSampleLevel. Reine Kopie: kein Tonemapping, keine Farbraumaenderung.
	var WGSL_MIPMAP = `
struct Aus { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> }

@vertex
fn vs(@builtin(vertex_index) i : u32) -> Aus {
	var a : Aus;
	let x = f32(i32(i & 1u) * 4 - 1);      // -1, 3, -1
	let y = f32(i32(i >> 1u) * 4 - 1);     // -1, -1, 3
	a.pos = vec4<f32>(x, y, 0.0, 1.0);
	a.uv  = vec2<f32>(x, -y) * 0.5 + 0.5;  // Zeile 0 der Textur liegt oben (NDC y = +1)
	return a;
}

@group(0) @binding(0) var s : sampler;
@group(0) @binding(1) var t : texture_2d<f32>;

@fragment
fn fs(a : Aus) -> @location(0) vec4<f32> {
	return textureSampleLevel(t, s, a.uv, 0.0);
}
`;

	// Eine Blit-Pipeline je Geraet und Format, beim ersten Aufruf angelegt.
	var mipmapCache = typeof WeakMap === "function" ? new WeakMap() : null;
	function mipmapPipeline(device, format) {
		var proFormat = mipmapCache && mipmapCache.get(device);
		if (!proFormat) { proFormat = {}; if (mipmapCache) mipmapCache.set(device, proFormat); }
		if (proFormat[format]) return proFormat[format];
		var modul = shader(device, WGSL_MIPMAP, "mipmap");
		var eintrag = {
			pipeline: device.createRenderPipeline({
				label: "mipmap " + format,
				layout: "auto",
				vertex: { module: modul, entryPoint: "vs" },
				fragment: { module: modul, entryPoint: "fs", targets: [{ format: format }] },
				primitive: { topology: "triangle-list" }
			}),
			sampler: device.createSampler({ minFilter: "linear", magFilter: "linear" })
		};
		proFormat[format] = eintrag;
		return eintrag;
	}

	// Mipkette einer Schicht (layer) ueber den Blit; fuer 2D-Texturen Schicht 0.
	// Die Views sind ausdruecklich 2D auf genau eine Schicht - so laeuft derselbe
	// Blit auch ueber die Layer einer texture_2d_array (Task 15b, kacheln.js).
	function erzeugeMipmapsLayer(device, textur, format, stufen, layer) {
		var blit = mipmapPipeline(device, format);
		var encoder = device.createCommandEncoder({ label: "mipmaps" });
		var schicht = layer || 0;
		for (var i = 1; i < stufen; i++) {
			var quelle = textur.createView({ dimension: "2d", baseMipLevel: i - 1, mipLevelCount: 1, baseArrayLayer: schicht, arrayLayerCount: 1 });
			var ziel   = textur.createView({ dimension: "2d", baseMipLevel: i,     mipLevelCount: 1, baseArrayLayer: schicht, arrayLayerCount: 1 });
			var gruppe = device.createBindGroup({
				layout: blit.pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: blit.sampler },
					{ binding: 1, resource: quelle }
				]
			});
			var pass = encoder.beginRenderPass({
				colorAttachments: [{ view: ziel, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }]
			});
			pass.setPipeline(blit.pipeline);
			pass.setBindGroup(0, gruppe);
			pass.draw(3);
			pass.end();
		}
		device.queue.submit([encoder.finish()]);
	}
	function erzeugeMipmaps(device, textur, format, stufen) {
		erzeugeMipmapsLayer(device, textur, format, stufen, 0);
	}

	// Kopiert ein ImageBitmap (oder Canvas/Video) in eine Textur; mit Mipmaps
	// ueber die Blit-Pipeline. RENDER_ATTACHMENT braucht der Blit.
	function textur(device, bitmap, optionen) {
		var o = optionen || {};
		var format = o.format || "rgba8unorm";
		var b = bitmap.width, h = bitmap.height;
		var stufen = o.mipmaps ? Math.floor(Math.log2(Math.max(b, h))) + 1 : 1;
		var t = device.createTexture({
			label: o.label,
			size: [b, h, 1],
			format: format,
			mipLevelCount: stufen,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
		});
		device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: t }, [b, h]);
		if (stufen > 1) erzeugeMipmaps(device, t, format, stufen);
		return t;
	}

	// Sampler fuer aequirektangulare Karten: 'wiederholen' wickelt nur in u
	// (Laengengrad, Naht bei 180 Grad); v klemmt, sonst mischt die Mipmap-
	// Filterung am Nordpol Zeilen vom Suedpol ein. Anisotropie erzwingt
	// lineare Filter (Vorgabe der Spezifikation).
	function sampler(device, optionen) {
		var o = optionen || {};
		var an = Math.max(1, Math.min(16, Math.floor(o.anisotropie || 1)));
		return device.createSampler({
			addressModeU: o.wiederholen ? "repeat" : "clamp-to-edge",
			addressModeV: "clamp-to-edge",
			magFilter: "linear",
			minFilter: "linear",
			mipmapFilter: "linear",
			maxAnisotropy: an
		});
	}

	// ---------------------------------------------------------- Kugelnetz
	// segLat+1 Reihen (Nordpol bis Suedpol), segLon+1 Spalten (Naht doppelt).
	// u = j/segLon, v = i/segLat; lat = pi/2 - v pi, lon = u 2pi - pi:
	// x = cos(lat) cos(lon), y = cos(lat) sin(lon), z = sin(lat).
	// Dann gilt u = lon/(2 pi) + 0.5 - genau die Texturkonvention.
	function kugel(segLat, segLon) {
		var reihen = segLat + 1, spalten = segLon + 1, n = reihen * spalten;
		var positionen = new Float32Array(n * 3), normalen = new Float32Array(n * 3), uv = new Float32Array(n * 2);
		var k = 0;
		for (var i = 0; i < reihen; i++) {
			var v = i / segLat, lat = Math.PI / 2 - v * Math.PI;
			var cl = Math.cos(lat), sl = Math.sin(lat);
			for (var j = 0; j < spalten; j++, k++) {
				var u = j / segLon, lon = u * 2 * Math.PI - Math.PI;
				var x = cl * Math.cos(lon), y = cl * Math.sin(lon), z = sl;
				positionen[k * 3] = x; positionen[k * 3 + 1] = y; positionen[k * 3 + 2] = z;
				normalen[k * 3] = x;   normalen[k * 3 + 1] = y;   normalen[k * 3 + 2] = z;
				uv[k * 2] = u; uv[k * 2 + 1] = v;
			}
		}
		// Je Feld zwei Dreiecke, gegen den Uhrzeigersinn von aussen gesehen
		// (frontFace 'ccw'): (a, unten, rechts) und (rechts, unten, unten-rechts).
		var indizes = new Uint32Array(segLat * segLon * 6), q = 0;
		for (i = 0; i < segLat; i++) {
			for (j = 0; j < segLon; j++) {
				var a = i * spalten + j, b = a + spalten;
				indizes[q++] = a;     indizes[q++] = b; indizes[q++] = a + 1;
				indizes[q++] = a + 1; indizes[q++] = b; indizes[q++] = b + 1;
			}
		}
		return { positionen: positionen, normalen: normalen, uv: uv, indizes: indizes };
	}

	// ---------------------------------------------------------- Matrizen
	// Spaltenweise wie in WGSL: m[spalte*4 + zeile]. Alle liefern Float32Array(16).
	function identitaet() {
		var m = new Float32Array(16);
		m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
		return m;
	}

	// a * b (erst b, dann a anwenden).
	function mul(a, b) {
		var r = new Float32Array(16);
		for (var c = 0; c < 4; c++) {
			for (var z = 0; z < 4; z++) {
				r[c * 4 + z] = a[z]      * b[c * 4]     + a[4 + z]  * b[c * 4 + 1]
				             + a[8 + z]  * b[c * 4 + 2] + a[12 + z] * b[c * 4 + 3];
			}
		}
		return r;
	}

	// Perspektive mit umgekehrter Tiefe: z = -nah -> 1, z = -fern -> 0.
	// Probe: z_clip = m[10] z + m[14], w_clip = -z; bei z = -nah wird
	// z_clip = nah (fern - nah)/(fern - nah) = nah = w -> 1; bei z = -fern 0.
	function perspektivReversedZ(fovY, aspekt, nah, fern) {
		var f = 1 / Math.tan(fovY / 2);
		var m = new Float32Array(16);
		m[0]  = f / aspekt;
		m[5]  = f;
		m[10] = nah / (fern - nah);
		m[11] = -1;
		m[14] = fern * nah / (fern - nah);
		m[15] = 0;
		return m;
	}

	// View-Matrix, Rechtssystem, Blick entlang -Z: Zeile 0 = rechts,
	// Zeile 1 = oben, Zeile 2 = -Blickrichtung. Bei Blick parallel zu 'oben'
	// wird eine Ersatzachse gewaehlt, damit nie NaN entsteht.
	function blick(auge, ziel, oben) {
		var fx = ziel[0] - auge[0], fy = ziel[1] - auge[1], fz = ziel[2] - auge[2];
		var fl = Math.hypot(fx, fy, fz);
		if (fl < 1e-12) { fx = 0; fy = 0; fz = -1; fl = 1; }
		fx /= fl; fy /= fl; fz /= fl;
		var ox = oben[0], oy = oben[1], oz = oben[2];
		var sx = fy * oz - fz * oy, sy = fz * ox - fx * oz, sz = fx * oy - fy * ox;
		var sl = Math.hypot(sx, sy, sz);
		if (sl < 1e-9) {
			// 'oben' parallel zur Blickrichtung: irgendeine dazu schraege Achse nehmen
			if (Math.abs(fx) < 0.9) { ox = 1; oy = 0; oz = 0; } else { ox = 0; oy = 1; oz = 0; }
			sx = fy * oz - fz * oy; sy = fz * ox - fx * oz; sz = fx * oy - fy * ox;
			sl = Math.hypot(sx, sy, sz);
		}
		sx /= sl; sy /= sl; sz /= sl;
		var ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
		var m = new Float32Array(16);
		m[0] = sx;  m[4] = sy;  m[8]  = sz;  m[12] = -(sx * auge[0] + sy * auge[1] + sz * auge[2]);
		m[1] = ux;  m[5] = uy;  m[9]  = uz;  m[13] = -(ux * auge[0] + uy * auge[1] + uz * auge[2]);
		m[2] = -fx; m[6] = -fy; m[10] = -fz; m[14] =  (fx * auge[0] + fy * auge[1] + fz * auge[2]);
		m[3] = 0;   m[7] = 0;   m[11] = 0;   m[15] = 1;
		return m;
	}

	// Drehungen (Rechtssystem, positiver Winkel gegen den Uhrzeigersinn, von
	// der Achsenspitze aus gesehen). rotZ(g) fuehrt erdfeste Groessen nach ECI.
	function rotZ(w) {
		var c = Math.cos(w), s = Math.sin(w), m = identitaet();
		m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
		return m;
	}
	function rotX(w) {
		var c = Math.cos(w), s = Math.sin(w), m = identitaet();
		m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
		return m;
	}
	function rotY(w) {
		var c = Math.cos(w), s = Math.sin(w), m = identitaet();
		m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
		return m;
	}

	// m * v; v hat 3 oder 4 Komponenten (w = 1, wenn nicht angegeben).
	// Liefert ein einfaches Array mit 4 Werten in doppelter Genauigkeit.
	function transformiere(m, v) {
		var x = v[0], y = v[1], z = v[2], w = v.length > 3 ? v[3] : 1;
		return [
			m[0] * x + m[4] * y + m[8]  * z + m[12] * w,
			m[1] * x + m[5] * y + m[9]  * z + m[13] * w,
			m[2] * x + m[6] * y + m[10] * z + m[14] * w,
			m[3] * x + m[7] * y + m[11] * z + m[15] * w
		];
	}

	// Inverse Transponierte des oberen 3x3-Blocks, als 4x4 (Rest Einheit),
	// damit sie in WGSL als mat4x4 mit (n * vec4(normale, 0)).xyz taugt.
	function normalMatrix(m) {
		var a00 = m[0], a01 = m[1], a02 = m[2];
		var a10 = m[4], a11 = m[5], a12 = m[6];
		var a20 = m[8], a21 = m[9], a22 = m[10];
		var b01 =  a22 * a11 - a12 * a21;
		var b11 = -a22 * a10 + a12 * a20;
		var b21 =  a21 * a10 - a11 * a20;
		var det = a00 * b01 + a01 * b11 + a02 * b21;
		var n = identitaet();
		if (Math.abs(det) < 1e-20) return n;
		det = 1 / det;
		// Inverse (Spalte c, Zeile z) = Kofaktor(z, c)/det; transponiert
		// wird daraus Kofaktor(c, z)/det - also direkt die Kofaktormatrix.
		n[0]  = b01 * det;
		n[1]  = (-a22 * a01 + a02 * a21) * det;
		n[2]  = (a12 * a01 - a02 * a11) * det;
		n[4]  = b11 * det;
		n[5]  = (a22 * a00 - a02 * a20) * det;
		n[6]  = (-a12 * a00 + a02 * a10) * det;
		n[8]  = b21 * det;
		n[9]  = (-a21 * a00 + a01 * a20) * det;
		n[10] = (a11 * a00 - a01 * a10) * det;
		// Transponieren: n[c*4+z] <-> n[z*4+c]
		var t;
		t = n[1]; n[1] = n[4]; n[4] = t;
		t = n[2]; n[2] = n[8]; n[8] = t;
		t = n[6]; n[6] = n[9]; n[9] = t;
		return n;
	}

	window.GPU = {
		starte: starte,
		shader: shader,
		puffer: puffer,
		uniform: uniform,
		textur: textur,
		sampler: sampler,
		kugel: kugel,
		mipmapPipeline: mipmapPipeline,
		erzeugeMipmapsLayer: erzeugeMipmapsLayer,
		mat4: {
			identitaet: identitaet,
			mul: mul,
			perspektivReversedZ: perspektivReversedZ,
			blick: blick,
			rotZ: rotZ,
			rotX: rotX,
			rotY: rotY,
			transformiere: transformiere,
			normalMatrix: normalMatrix
		}
	};
})(window);
