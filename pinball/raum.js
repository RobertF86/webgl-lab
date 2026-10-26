/*
 * FRIDAYVFX Pinball - Raumabbildung und Matrizen
 *
 * Auf dem Tisch wird in (x quer, y laengs, h ueber dem Feld) gerechnet. Hier
 * steht die Abbildung dieser Ebene in den Weltraum, und zwar einmal - Physik,
 * Modelle und Kamera lesen dieselbe.
 *
 * Wichtig ist der Unterschied zwischen `welt` und `weltRichtung`: Punkte werden
 * verschoben, Richtungen nicht. Wer eine Normale durch `welt` schickt, bekommt
 * sie um den Ursprung versetzt zurueck.
 *
 * Und `modellFuer` muss eine echte Drehung liefern, also mit Determinante +1.
 * Eine gespiegelte Abbildung dreht den Umlaufsinn jedes Dreiecks um: die
 * Aussenflaechen werden weggeschnitten, man sieht die Koerper von innen, und
 * alle Normalen zeigen verkehrt herum. Genau das war hier lange der Fall - an
 * runden Koerpern faellt es kaum auf, an den flachen Flippern sofort.
 * raum_test.js prueft die Determinante deshalb ausdruecklich.
 */
(function (global) {
	"use strict";

	function macheRaum(neigung) {
		var SIN = Math.sin(neigung), COS = Math.cos(neigung);

		function welt(x, y, h) { return [x, y * SIN + h * COS, -y * COS + h * SIN]; }
		function weltRichtung(dx, dy, dh) { return [dx, dy * SIN + dh * COS, -dy * COS + dh * SIN]; }

		function m4() { return new Float32Array(16); }
		function ident(o) { o.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); return o; }
		function mul(o, a, b) {
			for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
				var s = 0;
				for (var k = 0; k < 4; k++) s += a[k*4+j] * b[i*4+k];
				o[i*4+j] = s;
			}
			return o;
		}

		/*
		 * Modellmatrix fuer ein Bauteil auf dem Tisch. Die lokale y-Achse zeigt
		 * entlang der Tischnormale, die lokale x-Achse in die angegebene Richtung
		 * der Tischebene. Die dritte Spalte ergibt sich als Kreuzprodukt der
		 * beiden - nur so bleibt es eine Drehung.
		 */
		function modellFuer(x, y, h, drehung, skal) {
			var cr = Math.cos(drehung || 0), sr = Math.sin(drehung || 0), s = skal || 1;
			var ex = [1, 0, 0];                       // Tisch-x
			var eh = [0, COS, SIN];                   // Tischnormale, nach oben
			var ey = [0, SIN, -COS];                  // Tisch-y, den Tisch hinauf
			// erste Spalte: die gewuenschte Hauptrichtung in der Tischebene
			var c0 = [cr*ex[0] + sr*ey[0], cr*ex[1] + sr*ey[1], cr*ex[2] + sr*ey[2]];
			// dritte Spalte als Kreuzprodukt, damit die Determinante +1 wird
			var c2 = [c0[1]*eh[2] - c0[2]*eh[1],
			          c0[2]*eh[0] - c0[0]*eh[2],
			          c0[0]*eh[1] - c0[1]*eh[0]];
			var o = ident(m4());
			o[0] = c0[0]*s; o[1] = c0[1]*s; o[2] = c0[2]*s;
			o[4] = eh[0]*s; o[5] = eh[1]*s; o[6] = eh[2]*s;
			o[8] = c2[0]*s; o[9] = c2[1]*s; o[10] = c2[2]*s;
			var wp = welt(x, y, h);
			o[12] = wp[0]; o[13] = wp[1]; o[14] = wp[2];
			return o;
		}

		// Reine Drehung mit gleichmaessiger Skalierung - normieren genuegt
		function normalMatrix(m) {
			var n = new Float32Array(9), i, sp = [[0,1,2],[4,5,6],[8,9,10]];
			for (i = 0; i < 3; i++) {
				var a = m[sp[i][0]], b = m[sp[i][1]], c = m[sp[i][2]];
				var l = Math.hypot(a, b, c) || 1;
				n[i*3] = a/l; n[i*3+1] = b/l; n[i*3+2] = c/l;
			}
			return n;
		}

		function perspektive(o, fovy, ar, nah, fern) {
			var f = 1 / Math.tan(fovy / 2);
			o.set([f/ar,0,0,0, 0,f,0,0, 0,0,(fern+nah)/(nah-fern),-1, 0,0,2*fern*nah/(nah-fern),0]);
			return o;
		}
		function blickAuf(o, auge, ziel, oben) {
			function sub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
			function kreuz(a,b){return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];}
			function norm(a){var l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];}
			function pkt(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
			var z = norm(sub(auge, ziel)), x = norm(kreuz(oben, z)), y = kreuz(z, x);
			o.set([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
			       -pkt(x,auge), -pkt(y,auge), -pkt(z,auge), 1]);
			return o;
		}

		// Determinante des 3x3-Anteils - fuer die Pruefung
		function determinante(m) {
			return m[0]*(m[5]*m[10] - m[6]*m[9])
			     - m[4]*(m[1]*m[10] - m[2]*m[9])
			     + m[8]*(m[1]*m[6]  - m[2]*m[5]);
		}

		return { sin: SIN, cos: COS, welt: welt, weltRichtung: weltRichtung,
		         m4: m4, ident: ident, mul: mul, modellFuer: modellFuer,
		         normalMatrix: normalMatrix, perspektive: perspektive,
		         blickAuf: blickAuf, determinante: determinante };
	}

	global.macheRaum = macheRaum;
})(typeof window !== "undefined" ? window : globalThis);
