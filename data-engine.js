/* ============================================================
   MOTOR DE DATOS DEL DASHBOARD
   ------------------------------------------------------------
   Lee dashboard_data.csv (formato largo: periodo | quincena |
   obra | categoria | metrica | valor | moneda | notas) y arma
   en memoria, dinámicamente, todo lo que antes estaba
   hardcodeado a mano en el HTML: valores por período, series
   históricas por obra, promedios ponderados, desvíos, etc.

   No hay nada acá que dependa de una obra o un mes puntual:
   si el mes que viene aparece una obra nueva o un período
   nuevo en el CSV, se incorpora solo, sin tocar código.
   ============================================================ */

const DataEngine = (function () {

  const CSV_URL = 'dashboard_data.csv';
  const META_URL = 'meta.json';
  const MAX_MESES_ATRAS = 3; // cuántos períodos históricos se muestran además del activo

  let rows = [];       // filas crudas del CSV, ya tipadas
  let meta = {};        // contenido de meta.json

  // ---------- Utilidades de fechas/período ----------

  const MES_ABREV = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  const MES_LABEL = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  function periodoLabel(periodo) {
    // '2026-05' -> 'Mayo 2026'
    const [y, m] = periodo.split('-').map(Number);
    return `${MES_LABEL[m - 1]} ${y}`;
  }

  function periodoAnterior(periodo, n = 1) {
    let [y, m] = periodo.split('-').map(Number);
    m -= n;
    while (m < 1) { m += 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  function periodoSiguiente(periodo, n = 1) {
    let [y, m] = periodo.split('-').map(Number);
    m += n;
    while (m > 12) { m -= 12; y += 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
  }

  function quincenaLabel(periodo, quincena) {
    // '2026-05','Q1' -> '1Q MAY 26'
    const [y, m] = periodo.split('-').map(Number);
    const q = quincena === 'Q2' ? '2' : '1';
    return `${q}Q ${MES_ABREV[m - 1]} ${String(y).slice(2)}`;
  }

  // ---------- Carga ----------

  async function cargar() {
    const bust = 't=' + Date.now();

    const [csvText, metaJson] = await Promise.all([
      fetch(`${CSV_URL}?${bust}`).then(r => {
        if (!r.ok) throw new Error(`No se pudo leer ${CSV_URL} (${r.status})`);
        return r.text();
      }),
      fetch(`${META_URL}?${bust}`).then(r => {
        if (!r.ok) throw new Error(`No se pudo leer ${META_URL} (${r.status})`);
        return r.json();
      })
    ]);

    const parsed = Papa.parse(csvText, { header: false, skipEmptyLines: true, dynamicTyping: false });
    if (parsed.errors && parsed.errors.length) {
      console.warn('Advertencias al parsear el CSV:', parsed.errors);
    }

    const allRows = parsed.data;

    // Busca la fila real de encabezados ("periodo | quincena | obra | ...").
    // Así no importa si arriba quedó la fila de instrucciones ("YYYY-MM | Q1, Q2...")
    // u otra fila extra: el motor la salta sola.
    const headerIndex = allRows.findIndex(r =>
      (r[0] || '').toString().trim().toLowerCase() === 'periodo'
    );
    if (headerIndex === -1) {
      throw new Error('No se encontró la fila de encabezados ("periodo | quincena | obra | ...") en dashboard_data.csv.');
    }

    const headers = allRows[headerIndex].map(h => (h || '').toString().trim().toLowerCase());
    const col = {
      periodo: headers.indexOf('periodo'),
      quincena: headers.indexOf('quincena'),
      obra: headers.indexOf('obra'),
      categoria: headers.indexOf('categoria') !== -1 ? headers.indexOf('categoria') : headers.indexOf('categoría'),
      metrica: headers.indexOf('metrica') !== -1 ? headers.indexOf('metrica') : headers.indexOf('métrica'),
      valor: headers.indexOf('valor'),
      moneda: headers.indexOf('moneda')
    };
    if (col.periodo === -1 || col.obra === -1 || col.metrica === -1 || col.valor === -1) {
      throw new Error('Faltan columnas obligatorias (periodo/obra/metrica/valor) en dashboard_data.csv.');
    }

    rows = allRows
      .slice(headerIndex + 1)
      .map(r => ({
        periodo: (r[col.periodo] || '').toString().trim(),
        quincena: (r[col.quincena] || '').toString().trim(),
        obra: (r[col.obra] || '').toString().trim(),
        categoria: (r[col.categoria] || '').toString().trim(),
        metrica: (r[col.metrica] || '').toString().trim(),
        valor: r[col.valor] === '' || r[col.valor] === undefined ? null : Number(r[col.valor]),
        moneda: (r[col.moneda] || '').toString().trim()
      }))
      .filter(r => r.periodo && r.obra && r.metrica && r.valor !== null && !isNaN(r.valor));

    meta = metaJson;

    if (!meta.periodo_activo) {
      throw new Error('meta.json no tiene "periodo_activo" definido.');
    }

    return { rows, meta };
  }

  // ---------- Helpers de consulta sobre "rows" ----------

  function filtrar({ periodo, obra, categoria, metrica, quincena } = {}) {
    return rows.filter(r =>
      (periodo === undefined || r.periodo === periodo) &&
      (obra === undefined || r.obra === obra) &&
      (categoria === undefined || r.categoria === categoria) &&
      (metrica === undefined || r.metrica === metrica) &&
      (quincena === undefined || r.quincena === quincena)
    );
  }

  function valorUnico(list) {
    // suma si hay Q1+Q2 (métricas de flujo, ej. Hs reales, Certificado real);
    // si es un solo valor mensual, lo devuelve tal cual.
    if (list.length === 0) return null;
    if (list.length === 1) return list[0].valor;
    return list.reduce((acc, r) => acc + r.valor, 0);
  }

  function promedioSimple(valores) {
    const v = valores.filter(x => x !== null && x !== undefined && !isNaN(x));
    if (!v.length) return null;
    return v.reduce((a, b) => a + b, 0) / v.length;
  }

  // ---------- Obras y períodos disponibles ----------

  function obrasDisponibles() {
    return [...new Set(rows.map(r => r.obra))].sort();
  }

  function periodosDisponibles() {
    return [...new Set(rows.map(r => r.periodo))].sort();
  }

  // Igual que periodosDisponibles, pero recorta cualquier período posterior al
  // activo: esos son placeholders/proyección de meses que todavía no cerraron
  // (suelen venir en 0 desde la planilla) y no deben aparecer en el histórico.
  function periodosHastaActivo() {
    return periodosDisponibles().filter(p => p <= meta.periodo_activo);
  }

  // Períodos a mostrar en el selector: el activo + hasta MAX_MESES_ATRAS hacia atrás,
  // filtrando solo los que realmente tengan datos de certificación cargados.
  function periodosParaSelector() {
    const activo = meta.periodo_activo;
    const conDatos = new Set(
      filtrar({ categoria: 'Certificados', metrica: 'Certificado real' })
        .filter(r => r.valor > 0)
        .map(r => r.periodo)
    );

    const lista = [activo];
    let cursor = activo;
    for (let i = 0; i < MAX_MESES_ATRAS; i++) {
      cursor = periodoAnterior(cursor);
      if (conDatos.has(cursor)) lista.push(cursor);
    }
    return lista; // [activo, activo-1, activo-2, activo-3] (los que tengan datos)
  }

  function hayProyeccion() {
    const proximo = periodoSiguiente(meta.periodo_activo);
    return filtrar({ periodo: proximo, categoria: 'Proyeccion' }).length > 0;
  }

  // ---------- IDX (Productividad) por período ----------

  function idxsDelPeriodo(periodo) {
    const obras = [...new Set(
      filtrar({ periodo, categoria: 'Productividad' }).map(r => r.obra)
    )].sort();

    const porObra = obras.map(obra => {
      const martellaQ1 = valorUnico(filtrar({ periodo, obra, metrica: 'Martella', quincena: 'Q1' }));
      const martellaQ2 = valorUnico(filtrar({ periodo, obra, metrica: 'Martella', quincena: 'Q2' }));
      const therockQ1 = valorUnico(filtrar({ periodo, obra, metrica: 'The Rock', quincena: 'Q1' }));
      const therockQ2 = valorUnico(filtrar({ periodo, obra, metrica: 'The Rock', quincena: 'Q2' }));

      const hsQ1 = valorUnico(filtrar({ periodo, obra, categoria: 'Horas', quincena: 'Q1' })) || 0;
      const hsQ2 = valorUnico(filtrar({ periodo, obra, categoria: 'Horas', quincena: 'Q2' })) || 0;

      const martellaProm = promedioSimple([martellaQ1, martellaQ2]);
      const therockProm = promedioSimple([therockQ1, therockQ2]);

      return {
        obra,
        martellaQ1, martellaQ2, martellaProm,
        therockQ1, therockQ2, therockProm,
        horas: hsQ1 + hsQ2 // usado como peso para el promedio ponderado general
      };
    }).filter(o => o.martellaProm !== null || o.therockProm !== null);

    return porObra;
  }

  // Promedio ponderado por horas trabajadas (a falta de una fórmula publicada
  // distinta: Martella se define como "horas trabajadas por persona", así que
  // ponderar por horas de cada obra es el criterio más consistente con esa
  // definición). Si ninguna obra tiene horas cargadas ese mes, cae a promedio simple.
  function promedioPonderado(porObra, campo) {
    const conPeso = porObra.filter(o => o[campo] !== null && o.horas > 0);
    if (conPeso.length === 0) {
      return promedioSimple(porObra.map(o => o[campo]));
    }
    const sumaPesos = conPeso.reduce((a, o) => a + o.horas, 0);
    const sumaPonderada = conPeso.reduce((a, o) => a + o[campo] * o.horas, 0);
    return sumaPonderada / sumaPesos;
  }

  // ---------- Certificaciones por período ----------

  function certifDelPeriodo(periodo) {
    const obras = [...new Set(
      filtrar({ periodo, categoria: 'Certificados' }).map(r => r.obra)
    )].sort();

    return obras.map(obra => {
      const realRows = filtrar({ periodo, obra, metrica: 'Certificado real' });
      const previstoRows = filtrar({ periodo, obra, metrica: 'Certificado previsto' });
      const certifReal = valorUnico(realRows);
      const certifPrevisto = valorUnico(previstoRows);
      const avanceAcum = valorUnico(filtrar({ periodo, obra, metrica: 'Avance acumulado' }));
      const adicionales = valorUnico(filtrar({ periodo, obra, metrica: 'Adicionales' }));
      const moneda = (realRows[0] || previstoRows[0] || {}).moneda || '$';

      const desvio = (certifReal !== null && certifPrevisto !== null) ? certifReal - certifPrevisto : null;
      const desvioPct = (desvio !== null && certifPrevisto) ? desvio / certifPrevisto : null;

      return { obra, avanceAcum, certifReal, certifPrevisto, adicionales, desvio, desvioPct, moneda };
    }).filter(o => o.certifReal !== null || o.certifPrevisto !== null);
  }

  // ---------- K/Pase por período ----------

  function kpaseDelPeriodo(periodo) {
    const obras = [...new Set(
      filtrar({ periodo, categoria: 'Pases' }).map(r => r.obra)
    )].sort();

    const out = {};
    obras.forEach(obra => {
      const pase_licitacion = valorUnico(filtrar({ periodo, obra, metrica: 'Pase licitacion' }))
        ?? valorUnico(filtrar({ periodo, obra, metrica: 'Pase licitación' }));
      const pase_esperado = valorUnico(filtrar({ periodo, obra, metrica: 'Pase esperado' }));
      const coef_pase = valorUnico(filtrar({ periodo, obra, metrica: 'Coef de pase' }));
      if (pase_licitacion !== null || pase_esperado !== null || coef_pase !== null) {
        out[obra] = { pase_licitacion, pase_esperado, coef_pase };
      }
    });
    return out;
  }

  // ---------- Proyección del próximo período ----------

  function proyeccion() {
    const proximo = periodoSiguiente(meta.periodo_activo);
    const obras = [...new Set(
      filtrar({ periodo: proximo, categoria: 'Proyeccion' }).map(r => r.obra)
    )].sort();

    const detalle = obras.map(obra => ({
      obra,
      certifPrevisto: valorUnico(filtrar({ periodo: proximo, obra, metrica: 'Certificado previsto' })),
      avanceProyectado: valorUnico(filtrar({ periodo: proximo, obra, metrica: 'Avance proyectado' }))
    })).filter(o => o.certifPrevisto !== null);

    return { periodo: proximo, label: periodoLabel(proximo), detalle };
  }

  // ---------- Series históricas por obra (para los gráficos "click para ver histórico") ----------

  function serieHistoricaObra(obra) {
    const periodos = periodosHastaActivo();
    const puntos = [];
    periodos.forEach(periodo => {
      ['Q1', 'Q2'].forEach(q => {
        const martella = valorUnico(filtrar({ periodo, obra, metrica: 'Martella', quincena: q }));
        const therock = valorUnico(filtrar({ periodo, obra, metrica: 'The Rock', quincena: q }));
        if (martella !== null || therock !== null) {
          puntos.push({ label: quincenaLabel(periodo, q), periodo, quincena: q, martella, therock });
        }
      });
    });
    return puntos;
  }

  function serieHistoricaPromedioPonderado() {
    const periodos = periodosHastaActivo();
    const puntos = [];
    periodos.forEach(periodo => {
      ['Q1', 'Q2'].forEach(q => {
        const porObra = obrasDisponibles().map(obra => {
          const martella = valorUnico(filtrar({ periodo, obra, metrica: 'Martella', quincena: q }));
          const therock = valorUnico(filtrar({ periodo, obra, metrica: 'The Rock', quincena: q }));
          const horas = valorUnico(filtrar({ periodo, obra, categoria: 'Horas', quincena: q })) || 0;
          return { martellaProm: martella, therockProm: therock, horas };
        });
        const martella = promedioPonderado(porObra, 'martellaProm');
        const therock = promedioPonderado(porObra, 'therockProm');
        if (martella !== null || therock !== null) {
          puntos.push({ label: quincenaLabel(periodo, q), periodo, quincena: q, martella, therock });
        }
      });
    });
    return puntos;
  }

  function serieHistoricaKpase(obra) {
    const periodos = periodosHastaActivo();
    const out = [];
    periodos.forEach(periodo => {
      const pase_licitacion = valorUnico(filtrar({ periodo, obra, metrica: 'Pase licitacion' }))
        ?? valorUnico(filtrar({ periodo, obra, metrica: 'Pase licitación' }));
      const pase_esperado = valorUnico(filtrar({ periodo, obra, metrica: 'Pase esperado' }));
      const coef_pase = valorUnico(filtrar({ periodo, obra, metrica: 'Coef de pase' }));
      if (coef_pase !== null) {
        out.push({ periodo, label: periodoLabel(periodo).replace(' ', ' \'').slice(0, 3) + periodoLabel(periodo).slice(-2), pase_licitacion, pase_esperado, coef_pase });
      }
    });
    return out;
  }

  // ---------- Ensamblado final: un objeto por período, igual de forma al viejo dataStore ----------

  function datosDelPeriodo(periodo) {
    const idxPorObra = idxsDelPeriodo(periodo);
    const martellaPond = promedioPonderado(idxPorObra, 'martellaProm');
    const therockPond = promedioPonderado(idxPorObra, 'therockProm');

    return {
      periodo,
      month: periodoLabel(periodo),
      promPonderado: { martella: martellaPond, therock: therockPond },
      idxPorObra,
      certif: certifDelPeriodo(periodo),
      kpase: kpaseDelPeriodo(periodo)
    };
  }

  return {
    cargar,
    getMeta: () => meta,
    obrasDisponibles,
    periodosDisponibles,
    periodosParaSelector,
    hayProyeccion,
    periodoAnterior,
    periodoSiguiente,
    periodoLabel,
    datosDelPeriodo,
    proyeccion,
    serieHistoricaObra,
    serieHistoricaPromedioPonderado,
    serieHistoricaKpase
  };

})();
