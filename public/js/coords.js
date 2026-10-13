/* =====================================================================
 * coords.js — formatos de coordenadas (como no AlpineQuest) e sol
 *   - Graus decimais, graus-minutos-segundos (GMS), graus-minutos decimais
 *     (GMD), UTM e MGRS (sistema militar de grade), no datum WGS 84.
 *   - Leitura de coordenadas digitadas em qualquer desses formatos.
 *   - Nascer/pôr do sol e fim do crepúsculo civil (hora em que escurece).
 * Sem bibliotecas externas.
 * ===================================================================== */
(function (global) {
  'use strict';

  var A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), EP2 = E2 / (1 - E2), K0 = 0.9996;
  var RAD = Math.PI / 180;
  var BANDAS = 'CDEFGHJKLMNPQRSTUVWXX';
  var COLUNAS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
  var LINHAS = 'ABCDEFGHJKLMNPQRSTUV';

  function zonaDe(lat, lng) {
    var z = Math.floor((lng + 180) / 6) + 1;
    if (z > 60) z = 60;
    if (lat >= 56 && lat < 64 && lng >= 3 && lng < 12) z = 32;          // Noruega
    if (lat >= 72 && lat < 84) {                                          // Svalbard
      if (lng >= 0 && lng < 9) z = 31; else if (lng >= 9 && lng < 21) z = 33;
      else if (lng >= 21 && lng < 33) z = 35; else if (lng >= 33 && lng < 42) z = 37;
    }
    return z;
  }

  function bandaDe(lat) {
    if (lat < -80 || lat > 84) return null;
    return BANDAS.charAt(Math.min(20, Math.floor((lat + 80) / 8)));
  }

  function arcoMeridiano(phi) {
    var e4 = E2 * E2, e6 = e4 * E2;
    return A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi) +
      (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
  }

  // lat/lng (WGS 84) → { zona, banda, leste, norte, hemisferio }
  function paraUtm(lat, lng, zonaForcada) {
    var zona = zonaForcada || zonaDe(lat, lng);
    var lng0 = (zona - 1) * 6 - 180 + 3;
    var phi = lat * RAD, lam = (lng - lng0) * RAD;
    var s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
    var N = A / Math.sqrt(1 - E2 * s * s), T = t * t, Cc = EP2 * c * c, Aa = c * lam;
    var leste = K0 * N * (Aa + (1 - T + Cc) * Math.pow(Aa, 3) / 6 + (5 - 18 * T + T * T + 72 * Cc - 58 * EP2) * Math.pow(Aa, 5) / 120) + 500000;
    var norte = K0 * (arcoMeridiano(phi) + N * t * (Aa * Aa / 2 + (5 - T + 9 * Cc + 4 * Cc * Cc) * Math.pow(Aa, 4) / 24 +
      (61 - 58 * T + T * T + 600 * Cc - 330 * EP2) * Math.pow(Aa, 6) / 720));
    if (lat < 0) norte += 10000000;
    return { zona: zona, banda: bandaDe(lat), leste: leste, norte: norte, hemisferio: lat < 0 ? 'S' : 'N' };
  }

  // UTM → lat/lng
  function deUtm(zona, sul, leste, norte) {
    var x = leste - 500000, y = sul ? norte - 10000000 : norte;
    var mu = y / K0 / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * Math.pow(E2, 3) / 256));
    var e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    var phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu) +
      (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    var s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
    var N1 = A / Math.sqrt(1 - E2 * s * s), T1 = t * t, C1 = EP2 * c * c, R1 = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5), D = x / (N1 * K0);
    var lat = phi1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * Math.pow(D, 4) / 24 +
      (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
    var lng = (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / c;
    return { lat: lat / RAD, lng: (zona - 1) * 6 - 180 + 3 + lng / RAD };
  }

  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }

  // MGRS com precisão de 1 m (5 dígitos), por truncamento, como no padrão.
  function paraMgrs(lat, lng) {
    var u = paraUtm(lat, lng);
    if (!u.banda) return null;
    var e100 = Math.floor(u.leste / 100000), n100 = Math.floor(u.norte / 100000) % 20;
    var col = COLUNAS[(u.zona - 1) % 3].charAt(e100 - 1);
    var lin = LINHAS.charAt((n100 + (u.zona % 2 === 0 ? 5 : 0)) % 20);
    return { zona: u.zona, banda: u.banda, quadrado: col + lin,
      leste: pad(Math.floor(u.leste % 100000), 5), norte: pad(Math.floor(u.norte % 100000), 5) };
  }

  function deMgrs(zona, banda, quadrado, le, no) {
    var col = COLUNAS[(zona - 1) % 3].indexOf(quadrado.charAt(0));
    var lin = LINHAS.indexOf(quadrado.charAt(1));
    if (col < 0 || lin < 0) return null;
    var prec = Math.pow(10, 5 - le.length);
    var leste = (col + 1) * 100000 + Number(le) * prec + prec / 2 * (le.length < 5 ? 1 : 0);
    var nBase = ((lin - (zona % 2 === 0 ? 5 : 0)) % 20 + 20) % 20 * 100000 + Number(no) * prec + prec / 2 * (no.length < 5 ? 1 : 0);
    var sul = BANDAS.indexOf(banda) < 10;
    for (var k = 0; k < 10; k++) {
      var p = deUtm(zona, sul, leste, nBase + k * 2000000);
      if (bandaDe(p.lat) === banda) return p;
    }
    return null;
  }

  /* ---------- Formatos ---------------------------------------------- */
  var FORMATOS = {
    dec: 'Graus decimais (-22.45123, -42.98012)',
    gms: 'Graus, minutos e segundos (22°27\'04"S)',
    gmd: 'Graus e minutos decimais (22°27,074\'S)',
    utm: 'UTM (23K 707870 7515797)',
    mgrs: 'MGRS (23K QR 07870 15797)',
  };

  function gms(v, pos, neg, minutosDecimais) {
    var h = v < 0 ? neg : pos;
    v = Math.abs(v);
    var g = Math.floor(v), mTot = (v - g) * 60;
    if (minutosDecimais) {
      var md = Math.round(mTot * 1000) / 1000;
      if (md >= 60) { g++; md = 0; }
      return g + '°' + md.toFixed(3).replace('.', ',') + '\'' + h;
    }
    var m = Math.floor(mTot), s = Math.round((mTot - m) * 600) / 10;
    if (s >= 60) { s = 0; m++; }
    if (m >= 60) { m = 0; g++; }
    return g + '°' + pad(m, 2) + '\'' + (s < 10 ? '0' : '') + s.toFixed(1).replace('.', ',') + '"' + h;
  }

  function formatar(lat, lng, formato) {
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return '—';
    switch (formato) {
      case 'gms': return gms(lat, 'N', 'S') + ' ' + gms(lng, 'L', 'O');
      case 'gmd': return gms(lat, 'N', 'S', true) + ' ' + gms(lng, 'L', 'O', true);
      case 'utm': {
        var u = paraUtm(lat, lng);
        return u.zona + (u.banda || u.hemisferio) + ' ' + Math.round(u.leste) + ' ' + Math.round(u.norte);
      }
      case 'mgrs': {
        var m = paraMgrs(lat, lng);
        return m ? m.zona + m.banda + ' ' + m.quadrado + ' ' + m.leste + ' ' + m.norte : formatar(lat, lng, 'utm');
      }
      default: return lat.toFixed(6) + ', ' + lng.toFixed(6);
    }
  }

  function todos(lat, lng) {
    var r = {};
    Object.keys(FORMATOS).forEach(function (f) { r[f] = formatar(lat, lng, f); });
    return r;
  }

  /* ---------- Leitura de coordenadas digitadas --------------------- */
  // Aceita: "-22.4512, -42.9801" · "-22,4512 -42,9801" · "22°27'04.4"S 42°58'48.4"O"
  // · "22 27.074 S 42 58.807 W" · "23K 707870 7515797" · "23 S 707870 7515797"
  // · "23KQR0787015797" / "23K QR 07870 15797". Devolve { lat, lng, formato } ou null.
  function valido(p) { return p && isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180; }

  function interpretar(texto) {
    if (!texto) return null;
    var t = String(texto).trim().toUpperCase().replace(/\s+/g, ' ');
    var m;
    // MGRS
    m = /^(\d{1,2})\s?([C-HJ-NP-X])\s?([A-HJ-NP-Z]{2})\s?(\d{1,5})\s?(\d{1,5})$/.exec(t);
    if (m && m[4].length === m[5].length) {
      var pm = deMgrs(Number(m[1]), m[2], m[3], m[4], m[5]);
      if (valido(pm)) return { lat: pm.lat, lng: pm.lng, formato: 'mgrs' };
    }
    m = /^(\d{1,2})\s?([C-HJ-NP-X])\s?([A-HJ-NP-Z]{2})\s?(\d{2,10})$/.exec(t);
    if (m && m[4].length % 2 === 0) {
      var h = m[4].length / 2;
      var pm2 = deMgrs(Number(m[1]), m[2], m[3], m[4].slice(0, h), m[4].slice(h));
      if (valido(pm2)) return { lat: pm2.lat, lng: pm2.lng, formato: 'mgrs' };
    }
    // UTM: zona + banda (ou N/S de hemisfério) + leste + norte
    m = /^(\d{1,2})\s?([A-Z])\s+(\d{5,7}(?:[.,]\d+)?)\s*(?:E|L)?[\s,;]+(\d{6,8}(?:[.,]\d+)?)\s*N?$/.exec(t);
    if (m) {
      var zona = Number(m[1]), letra = m[2];
      if (zona >= 1 && zona <= 60) {
        // Letras N/S isoladas são ambíguas (banda N = hemisfério norte; banda S = hemisfério norte também).
        // Como no AlpineQuest: letra de banda. "S" de banda fica no norte; para hemisfério sul use a banda (ex.: 23K).
        var sul = BANDAS.indexOf(letra) >= 0 ? BANDAS.indexOf(letra) < 10 : false;
        var pu = deUtm(zona, sul, Number(m[3].replace(',', '.')), Number(m[4].replace(',', '.')));
        if (valido(pu)) return { lat: pu.lat, lng: pu.lng, formato: 'utm' };
      }
    }
    // Graus com hemisférios (GMS ou GMD ou decimais com letra)
    var partes = t.replace(/[°º'’′"”″]/g, ' ').replace(/,(?=\d)/g, '.').match(/[-+]?\d+(?:\.\d+)?|[NSLOEW]/g);
    if (partes && /[NSLOEW]/.test(t)) {
      var nums = [], coords = [];
      partes.forEach(function (p) {
        if (/^[NSLOEW]$/.test(p)) {
          if (!nums.length) return;
          var v = nums[0] + (nums[1] || 0) / 60 + (nums[2] || 0) / 3600;
          if (/[SOW]/.test(p)) v = -Math.abs(v);
          coords.push({ v: v, eixo: /[NS]/.test(p) ? 'lat' : 'lng' });
          nums = [];
        } else {
          nums.push(Math.abs(Number(p)));
        }
      });
      if (coords.length === 2 && coords[0].eixo !== coords[1].eixo) {
        var r = {};
        coords.forEach(function (c) { r[c.eixo] = c.v; });
        if (valido(r)) return { lat: r.lat, lng: r.lng, formato: 'gms' };
      }
    }
    // Decimais: "-22.45, -42.98" ou "-22,45 -42,98"
    var d = t.replace(/(\d),(\d)/g, '$1.$2').match(/[-+]?\d+(?:\.\d+)?/g);
    if (d && d.length === 2 && !/[A-Z]/.test(t)) {
      var pd = { lat: Number(d[0]), lng: Number(d[1]) };
      if (valido(pd)) return { lat: pd.lat, lng: pd.lng, formato: 'dec' };
    }
    return null;
  }

  /* ---------- Rumo e destino --------------------------------------- */
  function rumo(lat1, lng1, lat2, lng2) {
    var y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
    var x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  // Ponto a uma distância (m) e rumo (graus) de outro.
  function projetar(lat, lng, distM, rumoGraus) {
    var R = 6371000, d = distM / R, b = rumoGraus * RAD, p1 = lat * RAD, l1 = lng * RAD;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 / RAD, lng: ((l2 / RAD + 540) % 360) - 180 };
  }

  var PONTOS_CARDEAIS = ['N', 'NNE', 'NE', 'ENE', 'L', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  function cardeal(graus) { return PONTOS_CARDEAIS[Math.round(graus / 22.5) % 16]; }

  /* ---------- Sol ---------------------------------------------------- */
  // Algoritmo da "equação do nascer do sol" (precisão de ~1 min).
  //   h0 = −0,833° (nascer/pôr) e −6° (crepúsculo civil: começa a escurecer de vez).
  function sol(data, lat, lng) {
    var dia = 86400000, J1970 = 2440588, J2000 = 2451545, e = RAD * 23.4397;
    function paraJ(d) { return d.valueOf() / dia - 0.5 + J1970; }
    function deJ(j) { return new Date((j + 0.5 - J1970) * dia); }
    var lw = RAD * -lng, phi = RAD * lat;
    var d = paraJ(data) - J2000;
    var n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    var ds = 0.0009 + lw / (2 * Math.PI) + n;
    var M = RAD * (357.5291 + 0.98560028 * ds);
    var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var L = M + C + RAD * 102.9372 + Math.PI;
    var dec = Math.asin(Math.sin(L) * Math.sin(e));
    var Jtr = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    function evento(h0) {
      var cosw = (Math.sin(h0 * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
      if (cosw < -1 || cosw > 1) return null;   // sol da meia-noite / noite polar
      var w = Math.acos(cosw);
      var Jset = J2000 + (0.0009 + (w + lw) / (2 * Math.PI) + n) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
      return { nascer: deJ(Jtr - (Jset - Jtr)), por: deJ(Jset) };
    }
    var s = evento(-0.833), c = evento(-6);
    return {
      meioDia: deJ(Jtr),
      nascer: s && s.nascer, por: s && s.por,
      amanhecer: c && c.nascer, escurece: c && c.por,
    };
  }

  global.Coords = {
    FORMATOS: FORMATOS, formatar: formatar, todos: todos, interpretar: interpretar,
    paraUtm: paraUtm, deUtm: deUtm, paraMgrs: paraMgrs, deMgrs: deMgrs,
    rumo: rumo, projetar: projetar, cardeal: cardeal, sol: sol,
  };
})(typeof window !== 'undefined' ? window : globalThis);
