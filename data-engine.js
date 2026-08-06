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

    // Quita BOM y espacios de una celda de cabecera, para comparar de forma segura.
    const limpiar = (v) => (v || '').toString().replace(/^\uFEFF/, '').trim();

    // Busca la fila real de encabezados ("periodo | quincena | obra | ...").
    // Así no importa si arriba quedó la fila de instrucciones ("YYYY-MM | Q1, Q2...")
    // u otra fila extra: el motor la salta sola. Solo se compara "periodo" (sin
    // tildes), que es seguro frente a problemas de codificación del archivo.
    const headerIndex = allRows.findIndex(r => limpiar(r[0]).toLowerCase() === 'periodo');
    if (headerIndex === -1) {
      throw new Error('No se encontró la fila de encabezados ("periodo | quincena | obra | ...") en dashboard_data.csv.');
    }

    // A partir de ahí, las columnas se toman por POSICIÓN fija (no por nombre):
    // A=periodo, B=quincena, C=obra, D=categoria, E=métrica, F=valor, G=moneda, H=notas.
    // Esto evita depender de comparar "métrica"/"categoría", que son justamente
    // los nombres con tilde más propensos a corromperse según cómo Excel guarde el CSV.
    const [ P_PERIODO, P_QUINCENA, P_OBRA, P_CATEGORIA, P_METRICA, P_VALOR, P_MONEDA ] = [0, 1, 2, 3, 4, 5, 6];

    rows = allRows
      .slice(headerIndex + 1)
      .map(r => ({
        periodo: limpiar(r[P_PERIODO]),
        quincena: limpiar(r[P_QUINCENA]),
        obra: limpiar(r[P_OBRA]),
        categoria: limpiar(r[P_CATEGORIA]),
        metrica: limpiar(r[P_METRICA]),
        valor: r[P_VALOR] === '' || r[P_VALOR] === undefined ? null : Number(r[P_VALOR]),
        moneda: limpiar(r[P_MONEDA])
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

  // Para métricas ACUMULATIVAS (avance acumulado, avance proyectado): si el dato
  // está partido en Q1/Q2, el valor correcto es el de la última quincena (2Q),
  // no la suma de ambas -- son un "estado" al cierre del mes, no un flujo.
  function valorFinal(list) {
    if (!list.length) return null;
    const q2 = list.find(r => r.quincena === 'Q2');
    if (q2) return q2.valor;
    const q1 = list.find(r => r.quincena === 'Q1');
    if (q1) return q1.valor;
    return list[0].valor;
  }

  // ---------- Obras y períodos disponibles ----------

  function obrasDisponibles() {
    return [...new Set(rows.map(r => r.obra))].sort();
  }

  function periodosDisponibles() {
    return [...new Set(rows.map(r => r.periodo))].sort();
  }

  // Igual que periodosDisponibles, pero recorta cualquier período posterior al
  // límite indicado (por defecto el activo global). Se usa así: cuando se está
  // viendo el detalle histórico de un período pasado (ej. Mayo), el corte tiene
  // que ser hasta Mayo, no hasta el período activo actual (ej. Junio).
  function periodosHastaActivo(hasta) {
    const limite = hasta || meta.periodo_activo;
    return periodosDisponibles().filter(p => p <= limite);
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

      // El "promedio" de la obra para el mes SIEMPRE sale de la métrica ya
      // calculada "pond mensual" (no es un promedio simple de Q1/Q2: pondera
      // por horas dentro del mes), tal como está resuelto en Dashboard_Data.
      const martellaProm = valorUnico(filtrar({ periodo, obra, metrica: 'Martella pond mensual' }));
      const therockProm = valorUnico(filtrar({ periodo, obra, metrica: 'The Rock pond mensual' }));

      return { obra, martellaQ1, martellaQ2, martellaProm, therockQ1, therockQ2, therockProm };
    }).filter(o => o.martellaProm !== null || o.therockProm !== null);

    return porObra;
  }

  // Promedio ponderado GENERAL (todas las obras) para un período: sumatoria
  // producto de cada valor de quincena (Martella o The Rock) por las horas
  // reales de esa misma obra+quincena, sobre la suma total de esas horas.
  // Se pondera a nivel quincena (no a nivel de promedio mensual de cada obra),
  // que es el criterio confirmado.
  function promedioPonderadoQuincenal(periodo, metricaProductividad) {
    const valores = filtrar({ periodo, categoria: 'Productividad', metrica: metricaProductividad });
    let sumaProducto = 0, sumaPesos = 0;
    valores.forEach(v => {
      const horas = valorUnico(filtrar({ periodo, obra: v.obra, categoria: 'Horas', quincena: v.quincena })) || 0;
      if (horas > 0) {
        sumaProducto += v.valor * horas;
        sumaPesos += horas;
      }
    });
    if (sumaPesos === 0) return promedioSimple(valores.map(v => v.valor));
    return sumaProducto / sumaPesos;
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
      const avanceAcum = valorFinal(filtrar({ periodo, obra, metrica: 'Avance acumulado' }));
      const avanceInicial = valorFinal(filtrar({ periodo, obra, metrica: 'Avance inicial' }));
      const adicionales = valorUnico(filtrar({ periodo, obra, metrica: 'Adicionales' }));
      const moneda = (realRows[0] || previstoRows[0] || {}).moneda || '$';

      const desvio = (certifReal !== null && certifPrevisto !== null) ? certifReal - certifPrevisto : null;
      const desvioPct = (desvio !== null && certifPrevisto) ? desvio / certifPrevisto : null;

      // Estado Actual: avance acumulado vs. avance inicial previsto para el período
      // (mismo criterio de clasificación que Desvío % / Estado Mensual: +-5%).
      const estadoActualPct = (avanceAcum !== null && avanceInicial) ? (avanceAcum - avanceInicial) / avanceInicial : null;

      return { obra, avanceAcum, avanceInicial, certifReal, certifPrevisto, adicionales, desvio, desvioPct, estadoActualPct, moneda };
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
      avanceProyectado: valorFinal(filtrar({ periodo: proximo, obra, metrica: 'Avance proyectado' }))
    })).filter(o => o.certifPrevisto !== null);

    return { periodo: proximo, label: periodoLabel(proximo), detalle };
  }

  // ---------- Series históricas por obra (para los gráficos "click para ver histórico") ----------

  function serieHistoricaObra(obra, hasta) {
    const periodos = periodosHastaActivo(hasta);
    const puntos = [];
    periodos.forEach(periodo => {
      // "pond acumulado" es un valor mensual (no tiene quincena): se calcula
      // una sola vez por período y se repite en el punto de Q1 y de Q2 de
      // ese mes, para que la referencia quede alineada con la línea llena.
      const martellaPondAcum = valorUnico(filtrar({ periodo, obra, metrica: 'Martella pond acumulado' }));
      const therockPondAcum = valorUnico(filtrar({ periodo, obra, metrica: 'The Rock pond acumulado' }));

      ['Q1', 'Q2'].forEach(q => {
        const martella = valorUnico(filtrar({ periodo, obra, metrica: 'Martella', quincena: q }));
        const therock = valorUnico(filtrar({ periodo, obra, metrica: 'The Rock', quincena: q }));
        if (martella !== null || therock !== null) {
          puntos.push({
            label: quincenaLabel(periodo, q), periodo, quincena: q,
            martella, therock,
            martellaPondAcum, therockPondAcum
          });
        }
      });
    });
    return puntos;
  }

  function serieHistoricaKpase(obra, hasta) {
    const periodos = periodosHastaActivo(hasta);
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

    return {
      periodo,
      month: periodoLabel(periodo),
      promPonderado: {
        martella: promedioPonderadoQuincenal(periodo, 'Martella'),
        therock: promedioPonderadoQuincenal(periodo, 'The Rock')
      },
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
    serieHistoricaKpase
  };

})();
