/* Lader fuer den Sternkatalog sterne.bin (Yale Bright Star Catalogue, Vmag <= 6,5).
 * Format: "STRN" + uint32 LE Anzahl, je Stern 20 Byte: float32 x,y,z
 * (Einheitsvektor J2000-Aequator), float32 Magnitude, uint8 r,g,b, uint8 0.
 * Auch in Node nutzbar (parse); lade() braucht fetch. */
(function (window) {
	"use strict";
	function parse(puffer) {
		var dv = new DataView(puffer);
		var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
		if (magic !== "STRN") throw new Error("sterne.bin: falsches Format");
		var n = dv.getUint32(4, true), richtungen = new Float32Array(3 * n), magnituden = new Float32Array(n), farben = new Uint8Array(3 * n);
		var o = 8;
		for (var i = 0; i < n; i++, o += 20) {
			richtungen[3*i] = dv.getFloat32(o, true); richtungen[3*i+1] = dv.getFloat32(o+4, true); richtungen[3*i+2] = dv.getFloat32(o+8, true);
			magnituden[i] = dv.getFloat32(o+12, true);
			farben[3*i] = dv.getUint8(o+16); farben[3*i+1] = dv.getUint8(o+17); farben[3*i+2] = dv.getUint8(o+18);
		}
		return { anzahl: n, richtungen: richtungen, magnituden: magnituden, farben: farben };
	}
	function lade(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error("sterne.bin " + r.status); return r.arrayBuffer(); }).then(parse); }
	window.Sterne = { parse: parse, lade: lade };
})(window);
