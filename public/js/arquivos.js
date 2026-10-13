/* =====================================================================
 * arquivos.js — exportar e importar GPX, KML/KMZ, GeoJSON e CSV
 * (os formatos usados pelo AlpineQuest, Google Earth, Garmin e SIGs).
 *
 *   exportar: trilhas (com horário e precisão), pontos de interesse, setores
 *   importar: pontos, linhas (trilhas/rotas) e áreas → camada de referência
 * Tudo acontece no aparelho; nada é enviado a terceiros.
 * ===================================================================== */
(function (global) {
  'use strict';

  var LIMITE_BYTES = 8 * 1024 * 1024;
  var LIMITE_VERTICES = 50000;

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }
  function iso(t) { return t ? new Date(t).toISOString() : ''; }
  function n7(v) { return Math.round(v * 1e7) / 1e7; }

  // Círculo → polígono (para KML/GeoJSON, que não têm círculo).
  function circulo(lat, lng, raio, lados) {
    var pts = [];
    lados = lados || 72;
    for (var i = 0; i < lados; i++) {
      var p = global.Coords.projetar(lat, lng, raio, i * 360 / lados);
      pts.push([p.lat, p.lng]);
    }
    return pts;
  }

  function anelSetor(s) {
    return s.forma === 'circulo' ? circulo(s.centro_lat, s.centro_lng, s.raio_m) : (s.pontos || []);
  }

  /* ------------------------------------------------------------------ */
  /* Exportar                                                             */
  /* ------------------------------------------------------------------ */
  // dados = { nome, trilhas: [{ nome, tipo, cor, segmentos: [[{lat,lng,t,prec,ele?}]] }],
  //           pontos: [{ nome, lat, lng, descricao, categoria, ele? }],
  //           setores: [{ nome, forma, centro_lat, centro_lng, raio_m, pontos, cor, status, equipe }] }
  function gpx(dados) {
    var o = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Rastreamento GBS" xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      '<metadata><name>' + esc(dados.nome) + '</name><time>' + iso(Date.now()) + '</time></metadata>'];
    (dados.pontos || []).forEach(function (p) {
      o.push('<wpt lat="' + n7(p.lat) + '" lon="' + n7(p.lng) + '">' + (p.ele != null ? '<ele>' + Math.round(p.ele) + '</ele>' : '') +
        '<name>' + esc(p.nome) + '</name>' + (p.descricao ? '<desc>' + esc(p.descricao) + '</desc>' : '') +
        (p.categoria ? '<type>' + esc(p.categoria) + '</type>' : '') + '</wpt>');
    });
    // Setores no GPX: contorno como rota fechada (o GPX não tem áreas; use KML/GeoJSON para áreas).
    (dados.setores || []).forEach(function (s) {
      var anel = anelSetor(s);
      if (anel.length < 3) return;
      o.push('<rte><name>' + esc('Setor ' + s.nome) + '</name><type>setor</type>' +
        anel.concat([anel[0]]).map(function (q) { return '<rtept lat="' + n7(q[0]) + '" lon="' + n7(q[1]) + '"/>'; }).join('') + '</rte>');
    });
    (dados.trilhas || []).forEach(function (tr) {
      if (!tr.segmentos.length) return;
      o.push('<trk><name>' + esc(tr.nome) + '</name>' + (tr.tipo ? '<type>' + esc(tr.tipo) + '</type>' : ''));
      tr.segmentos.forEach(function (seg) {
        o.push('<trkseg>' + seg.map(function (p) {
          return '<trkpt lat="' + n7(p.lat) + '" lon="' + n7(p.lng) + '">' + (p.ele != null ? '<ele>' + Math.round(p.ele) + '</ele>' : '') +
            (p.t ? '<time>' + iso(p.t) + '</time>' : '') + (p.prec != null ? '<hdop>' + (Math.round(p.prec / 5 * 10) / 10) + '</hdop>' : '') + '</trkpt>';
        }).join('') + '</trkseg>');
      });
      o.push('</trk>');
    });
    o.push('</gpx>');
    return o.join('\n');
  }

  // Cor CSS #rrggbb → KML aabbggrr
  function corKml(hex, alfa) {
    var h = /^#?([0-9a-f]{6})$/i.exec(hex || '') ? hex.replace('#', '') : 'a020f0';
    return (alfa || 'ff') + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
  }
  function coordsKml(pts, fechar) {
    var l = pts.map(function (q) { return n7(q[1] != null && q.lat == null ? q[1] : q.lng) + ',' + n7(q.lat != null ? q.lat : q[0]); });
    if (fechar && l.length) l.push(l[0]);
    return l.join(' ');
  }

  function kml(dados) {
    var o = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + esc(dados.nome) + '</name>'];
    o.push('<Folder><name>Pontos de interesse</name>');
    (dados.pontos || []).forEach(function (p) {
      o.push('<Placemark><name>' + esc(p.nome) + '</name><description>' + esc([p.categoria, p.descricao].filter(Boolean).join(' — ')) +
        '</description><Point><coordinates>' + n7(p.lng) + ',' + n7(p.lat) + (p.ele != null ? ',' + Math.round(p.ele) : '') + '</coordinates></Point></Placemark>');
    });
    o.push('</Folder><Folder><name>Setores</name>');
    (dados.setores || []).forEach(function (s) {
      var anel = anelSetor(s);
      if (anel.length < 3) return;
      o.push('<Placemark><name>' + esc('Setor ' + s.nome) + '</name><description>' + esc([s.status, s.equipe].filter(Boolean).join(' · ')) +
        '</description><Style><LineStyle><color>' + corKml(s.cor) + '</color><width>3</width></LineStyle><PolyStyle><color>' + corKml(s.cor, '33') +
        '</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>' + coordsKml(anel, true) +
        '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>');
    });
    o.push('</Folder><Folder><name>Trilhas</name>');
    (dados.trilhas || []).forEach(function (tr) {
      if (!tr.segmentos.length) return;
      var t0 = tr.segmentos[0][0].t, ultSeg = tr.segmentos[tr.segmentos.length - 1], t1 = ultSeg[ultSeg.length - 1].t;
      o.push('<Placemark><name>' + esc(tr.nome) + '</name>' + (t0 ? '<TimeSpan><begin>' + iso(t0) + '</begin><end>' + iso(t1) + '</end></TimeSpan>' : '') +
        '<Style><LineStyle><color>' + corKml(tr.cor) + '</color><width>3</width></LineStyle></Style><MultiGeometry>' +
        tr.segmentos.map(function (seg) { return '<LineString><tessellate>1</tessellate><coordinates>' + coordsKml(seg) + '</coordinates></LineString>'; }).join('') +
        '</MultiGeometry></Placemark>');
    });
    o.push('</Folder></Document></kml>');
    return o.join('\n');
  }

  function geojson(dados) {
    var f = [];
    (dados.pontos || []).forEach(function (p) {
      f.push({ type: 'Feature', properties: { nome: p.nome, categoria: p.categoria || null, descricao: p.descricao || null, altitude: p.ele != null ? Math.round(p.ele) : null },
        geometry: { type: 'Point', coordinates: [n7(p.lng), n7(p.lat)] } });
    });
    (dados.setores || []).forEach(function (s) {
      var anel = anelSetor(s).map(function (q) { return [n7(q[1]), n7(q[0])]; });
      if (anel.length < 3) return;
      anel.push(anel[0]);
      f.push({ type: 'Feature', properties: { nome: 'Setor ' + s.nome, situacao: s.status, equipe: s.equipe || null, cor: s.cor },
        geometry: { type: 'Polygon', coordinates: [anel] } });
    });
    (dados.trilhas || []).forEach(function (tr) {
      if (!tr.segmentos.length) return;
      f.push({ type: 'Feature', properties: { nome: tr.nome, tipo: tr.tipo || null, cor: tr.cor || null,
        horarios: tr.segmentos.map(function (seg) { return seg.map(function (p) { return p.t ? iso(p.t) : null; }); }) },
        geometry: { type: 'MultiLineString', coordinates: tr.segmentos.map(function (seg) { return seg.map(function (p) { return [n7(p.lng), n7(p.lat)]; }); }) } });
    });
    return JSON.stringify({ type: 'FeatureCollection', name: dados.nome, features: f });
  }

  function csvCampo(v) {
    v = v == null ? '' : String(v);
    return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  // CSV (separador ";" e vírgula decimal trocada por ponto — abre no Excel/LibreOffice em pt-BR).
  function csv(dados) {
    var l = ['tipo;nome;latitude;longitude;horario;precisao_m;categoria;descricao'];
    (dados.pontos || []).forEach(function (p) { l.push(['ponto', p.nome, n7(p.lat), n7(p.lng), '', '', p.categoria, p.descricao].map(csvCampo).join(';')); });
    (dados.trilhas || []).forEach(function (tr) {
      tr.segmentos.forEach(function (seg) {
        seg.forEach(function (p) { l.push(['trilha', tr.nome, n7(p.lat), n7(p.lng), iso(p.t), p.prec == null ? '' : Math.round(p.prec), tr.tipo, ''].map(csvCampo).join(';')); });
      });
    });
    return '﻿' + l.join('\r\n');
  }

  var TIPOS_MIME = { gpx: 'application/gpx+xml', kml: 'application/vnd.google-earth.kml+xml', geojson: 'application/geo+json', csv: 'text/csv;charset=utf-8' };
  function exportar(formato, dados) {
    var f = { gpx: gpx, kml: kml, geojson: geojson, csv: csv }[formato];
    if (!f) throw new Error('formato desconhecido');
    return f(dados);
  }

  function baixar(nomeArquivo, conteudo, formato) {
    var blob = new Blob([conteudo], { type: TIPOS_MIME[formato] || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  /* ------------------------------------------------------------------ */
  /* Importar                                                             */
  /* ------------------------------------------------------------------ */
  // Devolve { pontos: [{nome, lat, lng, descricao}], linhas: [{nome, pts:[[lat,lng]]}], areas: [{nome, pts}], avisos: [] }
  function vazio() { return { pontos: [], linhas: [], areas: [], avisos: [] }; }

  function numOk(lat, lng) { return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0); }

  function filhos(el, nome) {
    return Array.prototype.filter.call(el.getElementsByTagName('*'), function (e) { return e.localName === nome; });
  }
  function textoDe(el, nome) {
    var e = Array.prototype.find.call(el.children || [], function (c) { return c.localName === nome; });
    return e ? e.textContent.trim() : '';
  }

  function lerGpx(doc) {
    var r = vazio();
    filhos(doc, 'wpt').forEach(function (w, i) {
      var lat = Number(w.getAttribute('lat')), lng = Number(w.getAttribute('lon'));
      if (numOk(lat, lng)) r.pontos.push({ nome: textoDe(w, 'name') || 'Ponto ' + (i + 1), lat: lat, lng: lng, descricao: textoDe(w, 'desc') || textoDe(w, 'cmt') });
    });
    filhos(doc, 'trk').forEach(function (t, i) {
      var nome = textoDe(t, 'name') || 'Trilha ' + (i + 1);
      filhos(t, 'trkseg').forEach(function (sg) {
        var pts = filhos(sg, 'trkpt').map(function (p) { return [Number(p.getAttribute('lat')), Number(p.getAttribute('lon'))]; }).filter(function (q) { return numOk(q[0], q[1]); });
        if (pts.length > 1) r.linhas.push({ nome: nome, pts: pts });
      });
    });
    filhos(doc, 'rte').forEach(function (t, i) {
      var pts = filhos(t, 'rtept').map(function (p) { return [Number(p.getAttribute('lat')), Number(p.getAttribute('lon'))]; }).filter(function (q) { return numOk(q[0], q[1]); });
      if (pts.length > 1) r.linhas.push({ nome: textoDe(t, 'name') || 'Rota ' + (i + 1), pts: pts });
    });
    return r;
  }

  function lerCoordsKml(txt) {
    return String(txt || '').trim().split(/\s+/).map(function (c) {
      var p = c.split(',');
      return [Number(p[1]), Number(p[0])];
    }).filter(function (q) { return numOk(q[0], q[1]); });
  }

  function lerKml(doc) {
    var r = vazio();
    filhos(doc, 'Placemark').forEach(function (pm, i) {
      var nome = textoDe(pm, 'name') || 'Item ' + (i + 1);
      var desc = textoDe(pm, 'description').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      filhos(pm, 'Point').forEach(function (pt) {
        var c = lerCoordsKml(textoDe(pt, 'coordinates'))[0];
        if (c) r.pontos.push({ nome: nome, lat: c[0], lng: c[1], descricao: desc });
      });
      filhos(pm, 'LineString').forEach(function (ls) {
        var pts = lerCoordsKml(textoDe(ls, 'coordinates'));
        if (pts.length > 1) r.linhas.push({ nome: nome, pts: pts });
      });
      filhos(pm, 'Polygon').forEach(function (pg) {
        var anel = filhos(pg, 'outerBoundaryIs')[0];
        var cs = anel ? filhos(anel, 'coordinates')[0] : null;
        var pts = cs ? lerCoordsKml(cs.textContent) : [];
        if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
        if (pts.length >= 3) r.areas.push({ nome: nome, pts: pts });
      });
      filhos(pm, 'Track').forEach(function (tk) {   // gx:Track
        var pts = filhos(tk, 'coord').map(function (c) { var p = c.textContent.trim().split(/\s+/); return [Number(p[1]), Number(p[0])]; })
          .filter(function (q) { return numOk(q[0], q[1]); });
        if (pts.length > 1) r.linhas.push({ nome: nome, pts: pts });
      });
    });
    return r;
  }

  function lerGeojson(obj) {
    var r = vazio();
    var feats = obj.type === 'FeatureCollection' ? obj.features || [] : obj.type === 'Feature' ? [obj] : [{ type: 'Feature', geometry: obj, properties: {} }];
    feats.forEach(function (f, i) {
      var g = f && f.geometry, pr = (f && f.properties) || {};
      if (!g) return;
      var nome = pr.name || pr.nome || pr.title || pr.titulo || 'Item ' + (i + 1);
      var ll = function (c) { return [Number(c[1]), Number(c[0])]; };
      var ok = function (q) { return numOk(q[0], q[1]); };
      var add = function (tipo, coords) {
        if (tipo === 'Point') { var p = ll(coords); if (ok(p)) r.pontos.push({ nome: nome, lat: p[0], lng: p[1], descricao: pr.description || pr.descricao || '' }); }
        if (tipo === 'LineString') { var l = coords.map(ll).filter(ok); if (l.length > 1) r.linhas.push({ nome: nome, pts: l }); }
        if (tipo === 'Polygon') { var a = (coords[0] || []).map(ll).filter(ok); if (a.length > 3) { a.pop(); r.areas.push({ nome: nome, pts: a }); } }
      };
      if (g.type === 'GeometryCollection') (g.geometries || []).forEach(function (gg) { add(gg.type, gg.coordinates); });
      else if (/^Multi/.test(g.type)) (g.coordinates || []).forEach(function (c) { add(g.type.replace('Multi', ''), c); });
      else add(g.type, g.coordinates);
    });
    return r;
  }

  function lerCsv(texto) {
    var r = vazio();
    var linhas = texto.replace(/^﻿/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!linhas.length) return r;
    var sep = [';', '\t', ','].sort(function (a, b) { return linhas[0].split(b).length - linhas[0].split(a).length; })[0];
    var cab = linhas[0].toLowerCase().split(sep).map(function (c) { return c.replace(/"/g, '').trim(); });
    var iLat = cab.findIndex(function (c) { return /^(lat|latitude|y)$/.test(c); });
    var iLng = cab.findIndex(function (c) { return /^(lon|lng|long|longitude|x)$/.test(c); });
    var iNome = cab.findIndex(function (c) { return /^(nome|name|titulo|title|descricao)$/.test(c); });
    if (iLat < 0 || iLng < 0) { r.avisos.push('CSV sem colunas de latitude e longitude no cabeçalho.'); return r; }
    linhas.slice(1).forEach(function (l, k) {
      var c = l.split(sep).map(function (v) { return v.replace(/^"|"$/g, '').trim(); });
      var lat = Number(String(c[iLat]).replace(',', '.')), lng = Number(String(c[iLng]).replace(',', '.'));
      if (numOk(lat, lng)) r.pontos.push({ nome: (iNome >= 0 && c[iNome]) || 'Ponto ' + (k + 1), lat: lat, lng: lng, descricao: '' });
    });
    return r;
  }

  // KMZ = ZIP com um .kml dentro. Lê o diretório central e descompacta (DecompressionStream).
  async function kmlDeKmz(buf) {
    var dv = new DataView(buf);
    var fim = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
    }
    if (fim < 0) throw new Error('KMZ inválido.');
    var total = dv.getUint16(fim + 10, true), off = dv.getUint32(fim + 16, true);
    var dec = new TextDecoder();
    for (var k = 0; k < total; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var metodo = dv.getUint16(off + 10, true), tamC = dv.getUint32(off + 20, true);
      var nLen = dv.getUint16(off + 28, true), xLen = dv.getUint16(off + 30, true), cLen = dv.getUint16(off + 32, true);
      var local = dv.getUint32(off + 42, true);
      var nome = dec.decode(new Uint8Array(buf, off + 46, nLen));
      if (/\.kml$/i.test(nome)) {
        var ini = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        var dados = new Uint8Array(buf, ini, tamC);
        if (metodo === 0) return dec.decode(dados);
        if (metodo !== 8 || typeof DecompressionStream === 'undefined') throw new Error('Este navegador não abre KMZ compactado. Extraia o .kml e importe-o.');
        var ds = new Blob([dados]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return await new Response(ds).text();
      }
      off += 46 + nLen + xLen + cLen;
    }
    throw new Error('O KMZ não contém um arquivo .kml.');
  }

  // Lê um File (ou { name, text }) e devolve os objetos encontrados.
  async function importar(arquivo) {
    if (arquivo.size > LIMITE_BYTES) throw new Error('Arquivo grande demais (máximo de 8 MB).');
    var nome = String(arquivo.name || '').toLowerCase();
    var texto, r;
    if (/\.kmz$/.test(nome)) texto = await kmlDeKmz(await arquivo.arrayBuffer());
    else texto = await arquivo.text();
    var ini = texto.replace(/^﻿/, '').trim().slice(0, 300);
    if (/\.(geo)?json$/.test(nome) || /^[{[]/.test(ini)) {
      r = lerGeojson(JSON.parse(texto));
    } else if (/\.csv$|\.txt$/.test(nome) && !/^</.test(ini)) {
      r = lerCsv(texto);
    } else {
      var doc = new DOMParser().parseFromString(texto, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error('O arquivo não é um GPX/KML válido.');
      var raiz = doc.documentElement.localName;
      if (raiz === 'gpx') r = lerGpx(doc);
      else if (raiz === 'kml') r = lerKml(doc);
      else throw new Error('Formato não reconhecido (use GPX, KML, KMZ, GeoJSON ou CSV).');
    }
    var vert = r.pontos.length;
    r.linhas.forEach(function (l) { vert += l.pts.length; });
    r.areas.forEach(function (a) { vert += a.pts.length; });
    if (vert > LIMITE_VERTICES) throw new Error('Arquivo com pontos demais (' + vert + '). O limite é ' + LIMITE_VERTICES + '.');
    if (!r.pontos.length && !r.linhas.length && !r.areas.length) throw new Error('Nenhum ponto, trilha ou área encontrado no arquivo.');
    r.vertices = vert;
    return r;
  }

  global.Arquivos = {
    exportar: exportar, baixar: baixar, importar: importar, circulo: circulo,
    _ler: { gpx: function (t) { return lerGpx(new DOMParser().parseFromString(t, 'application/xml')); },
      kml: function (t) { return lerKml(new DOMParser().parseFromString(t, 'application/xml')); }, geojson: lerGeojson, csv: lerCsv },
  };
})(typeof window !== 'undefined' ? window : globalThis);
