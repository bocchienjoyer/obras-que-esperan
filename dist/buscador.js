"use strict";

const inventario = inventarioValido(globalThis.INVENTARIO) ? globalThis.INVENTARIO : null;
const { obras = [], corte, fuente, anexo, anioPim, revisado } = inventario ?? {};
const porId = new Map(obras.map(obra => [obra.infobras, obra]));
const $ = id => document.getElementById(id);
const cantidad = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const moneda = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" });
const ordenarTexto = new Intl.Collator("es", { sensitivity: "base" }).compare;
const compararNombres = new Intl.Collator("es", { sensitivity: "base", ignorePunctuation: true }).compare;
const obrasPorNombre = [...obras].sort((a, b) => compararNombres(a.obra, b.obra) || a.fila - b.fila);
const ordenInicial = "nombre";
const tamPagina = 12;
const buscadorPublico = "https://bocchienjoyer.github.io/obras-que-esperan/";
const sinDato = "Sin dato en el anexo";
const fechaOficial = new Intl.DateTimeFormat("es-PE", { dateStyle: "long", timeZone: "UTC" });
const fechaCorte = corte ? fechaOficial.format(new Date(corte)) : "";
const filtros = ["q", "dep", "prov", "dist", "tipo", "avance", "orden"];
const comunes = new Set(["en", "de", "del", "la", "las", "el", "los", "y"]);
const ordenes = new Set([ordenInicial, "original", "avance", "costo"]);
const estados = { pagina: 1, resultados: [], cerrandoFicha: false, descargando: false, copia: 0 };
const iaLocal = inventario && location.protocol === "http:" && location.hostname === "127.0.0.1"
  ? fetch("/api/ia", { signal: AbortSignal.timeout(3000) }).then(respuesta => respuesta.ok ? respuesta.json() : {}).then(datos => datos.disponible === true).catch(() => false)
  : Promise.resolve(false);

function fechaISO(valor) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const fecha = new Date(valor);
  return Number.isFinite(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor;
}

function urlOficial(valor, dominio) {
  if (typeof valor !== "string") return false;
  try {
    const url = new URL(valor);
    return url.protocol === "https:" && url.host === dominio && !url.username && !url.password;
  } catch {
    return false;
  }
}

function inventarioValido(datos) {
  if (!datos || !fechaISO(datos.corte) || !urlOficial(datos.fuente, "www.gob.pe")
      || !urlOficial(datos.anexo, "cdn.www.gob.pe")
      || !Array.isArray(datos.obras) || !datos.obras.length) return false;
  const codigos = new Set();
  for (const obra of datos.obras) {
    if (!obra || typeof obra.infobras !== "string" || !/^\d+$/.test(obra.infobras)
        || codigos.has(obra.infobras) || typeof obra.obra !== "string"
        || typeof obra.entidad !== "string" || typeof obra.departamento !== "string"
        || (obra.cui != null && (typeof obra.cui !== "string" || !/^\d+$/.test(obra.cui)))) return false;
    codigos.add(obra.infobras);
  }
  return true;
}

function normalizar(texto) {
  return String(texto ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function palabras(texto) {
  return normalizar(texto).match(/[a-z0-9]+/g) ?? [];
}

function claveTerritorial(texto) {
  return palabras(texto).join(" ");
}

function entidadHtml(texto) {
  return String(texto ?? sinDato).replace(/[&<>"']/g, letra => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[letra]);
}

function lugar(obra) {
  return [obra.departamento, obra.provincia, obra.distrito].filter(Boolean).join(" / ");
}

function porcentaje(valor) {
  return valor == null ? sinDato : `${cantidad.format(valor)} %`;
}

function soles(valor) {
  return valor == null ? sinDato : moneda.format(valor);
}

const lugares = new Set();
const indice = new Map(obras.map(obra => {
  const ubicaciones = [obra.departamento, obra.provincia, obra.distrito]
    .filter(Boolean).map(claveTerritorial);
  for (const nombre of ubicaciones) lugares.add(nombre);
  return [obra.infobras, {
    texto: normalizar([
      obra.obra, obra.entidad, lugar(obra), obra.tipo, obra.categoria, obra.subtipo, obra.sector,
    ].join(" ")),
    ubicaciones,
  }];
}));

function interpretarConsulta(texto) {
  const consulta = claveTerritorial(texto);
  const codigo = consulta.match(/^(?:(?:codigo )?(cui|infobras) )?(\d+)$/);
  if (codigo) {
    return { campo: codigo[1], codigo: codigo[2], termino: [], ubicacion: null };
  }
  const cuerpo = consulta
    .replace(/^(?:(?:cuant(?:as|os)|cual(?:es)?(?: son)?|que) )?(?:las )?obras(?: publicas)?(?: (?:estan )?paralizadas)?(?: hay)?(?: |$)/, "")
    .replace(/^en /, "");
  const separador = cuerpo.lastIndexOf(" en ");
  const lugarSolicitado = separador < 0 ? cuerpo : cuerpo.slice(separador + 4);
  const ubicacion = lugares.has(lugarSolicitado) ? lugarSolicitado : null;
  const termino = ubicacion ? (separador < 0 ? "" : cuerpo.slice(0, separador)) : cuerpo;
  return { campo: null, codigo: null, termino: [...new Set(palabras(termino).filter(palabra => !comunes.has(palabra)))], ubicacion };
}

function opciones(select, texto, valores, preferido = select.value) {
  const unicos = [...new Set(valores.filter(Boolean))].sort(ordenarTexto);
  select.replaceChildren(new Option(texto, ""), ...unicos.map(valor => new Option(valor, valor)));
  select.value = unicos.includes(preferido) ? preferido : "";
}

function actualizarUbicacion(preferencias = {}) {
  const porDepartamento = obras.filter(obra => !$("dep").value || obra.departamento === $("dep").value);
  opciones($("prov"), "Todas", porDepartamento.map(obra => obra.provincia), preferencias.prov);
  const porProvincia = porDepartamento.filter(obra => !$("prov").value || obra.provincia === $("prov").value);
  opciones($("dist"), "Todos", porProvincia.map(obra => obra.distrito), preferencias.dist);
  $("prov").disabled = !$("dep").value;
  $("dist").disabled = !$("prov").value;
}

function paramsBusqueda() {
  const params = new URLSearchParams();
  for (const id of filtros) {
    const valor = $(id).value.trim();
    if (valor && !(id === "orden" && valor === ordenInicial)) params.set(id, valor);
  }
  if (estados.pagina > 1) params.set("pagina", estados.pagina);
  return params;
}

function enlaceFicha(codigo) {
  const params = paramsBusqueda();
  params.set("obra", codigo);
  return "?" + params.toString();
}

function actualizarURL(codigo, abrirFicha = false) {
  const params = paramsBusqueda();
  if (codigo) params.set("obra", codigo);
  const sufijo = params.size ? "?" + params.toString() : "";
  // Los archivos abiertos directamente también permiten enlaces relativos con filtros.
  try {
    const url = location.pathname + sufijo;
    if (abrirFicha) {
      history.pushState({ fichaAbierta: true }, "", url);
    } else if (url !== location.pathname + location.search) {
      history.replaceState(null, "", url);
    }
  } catch {
    // Algunos navegadores restringen history en archivos locales.
  }
}

function buscar({ reiniciar = true, sincronizar = true } = {}) {
  if (reiniciar) estados.pagina = 1;
  const q = $("q");
  if (q.value.length > q.maxLength) q.value = q.value.slice(0, q.maxLength);
  const consulta = interpretarConsulta($("q").value);
  const avance = $("avance").value;
  const dep = $("dep").value;
  const prov = $("prov").value;
  const dist = $("dist").value;
  const tipo = $("tipo").value;
  const orden = $("orden").value;
  const seleccion = (orden === ordenInicial ? obrasPorNombre : obras).filter(obra => {
    if (dep && obra.departamento !== dep) return false;
    if (prov && obra.provincia !== prov) return false;
    if (dist && obra.distrito !== dist) return false;
    if (tipo && obra.tipo !== tipo) return false;
    if (avance === "sin" && obra.avance != null) return false;
    if (avance === "100" && obra.avance !== 100) return false;
    if (avance === "90" && (obra.avance == null || obra.avance < 90)) return false;
    if (consulta.codigo) {
      return consulta.campo ? obra[consulta.campo] === consulta.codigo
        : obra.infobras === consulta.codigo || obra.cui === consulta.codigo;
    }
    const entrada = indice.get(obra.infobras);
    if (consulta.ubicacion && !entrada.ubicaciones.includes(consulta.ubicacion)) return false;
    return consulta.termino.every(palabra =>
      entrada.texto.includes(palabra) || obra.infobras === palabra || obra.cui === palabra);
  });
  if (orden === "avance" || orden === "costo") {
    seleccion.sort((a, b) => (b[orden] ?? -Infinity) - (a[orden] ?? -Infinity) || a.fila - b.fila);
  }
  estados.resultados = seleccion;
  renderizar();
  if (sincronizar) actualizarURL();
}

function claseAvance(avance) {
  if (avance < 40) return "avance-bajo";
  if (avance < 80) return "avance-medio";
  return "avance-alto";
}

function renderizar() {
  const total = estados.resultados.length;
  const paginas = Math.max(1, Math.ceil(total / tamPagina));
  estados.pagina = Math.min(Math.max(estados.pagina, 1), paginas);
  const desde = (estados.pagina - 1) * tamPagina;
  const filas = estados.resultados.slice(desde, desde + tamPagina);
  $("conteo").textContent = `${cantidad.format(total)} ${total === 1 ? "obra encontrada" : "obras encontradas"}`
    + (total > tamPagina ? ` (mostrando ${cantidad.format(desde + 1)}–${cantidad.format(desde + filas.length)})` : "");
  $("descargar").disabled = !total || estados.descargando;
  $("lista").innerHTML = filas.length ? filas.map(obra => `
    <li class="resultado">
      <div class="registro">
        <p class="registro-lugar">${entidadHtml(lugar(obra))}</p>
        <h3><a data-obra="${obra.infobras}" href="${entidadHtml(enlaceFicha(obra.infobras))}">${entidadHtml(obra.obra)}</a></h3>
        <p class="registro-entidad">${entidadHtml(obra.entidad)}</p>
        <p class="meta registro-codigos"><span>${entidadHtml(obra.tipo)}</span><span>INFOBRAS ${obra.infobras}</span>${obra.cui ? `<span>CUI ${obra.cui}</span>` : ""}</p>
      </div>
      <div class="dato">
        <span class="dato-etiqueta">Avance físico</span>
        <strong>${obra.avance == null ? "—" : porcentaje(obra.avance)}</strong>
        ${Number.isFinite(obra.avance) ? `<progress class="${claseAvance(obra.avance)}" aria-hidden="true" value="${obra.avance}" max="100"></progress>` : ""}
        <a data-obra="${obra.infobras}" href="${entidadHtml(enlaceFicha(obra.infobras))}" aria-label="Ver ficha INFOBRAS ${obra.infobras}">Ver ficha</a>
      </div>
    </li>`).join("") : '<li class="vacio">No hay coincidencias en este corte. Prueba con otro nombre o amplía la ubicación.</li>';
  $("paginacion").hidden = paginas === 1;
  $("pagina").textContent = `Página ${estados.pagina} de ${paginas}`;
  $("anterior").disabled = estados.pagina === 1;
  $("siguiente").disabled = estados.pagina === paginas;
}

function enlaceInfobras(codigo) {
  return "https://infobras.contraloria.gob.pe/InfobrasWeb/Mapa/Obra?" + new URLSearchParams({ ObraId: codigo });
}

function enlaceMef(cui) {
  return cui ? "https://ofi5.mef.gob.pe/ssi/Ssi/Index?" + new URLSearchParams({ codigo: cui, tipo: "2" }) : null;
}

function fuenteLink(url, texto) {
  return `<a href="${entidadHtml(url)}" target="_blank" rel="noopener noreferrer">${entidadHtml(texto)}</a>`;
}

function ficha(codigo, abrirFicha = true) {
  const obra = porId.get(codigo);
  if (!obra || estados.cerrandoFicha || (abrirFicha && $("ficha").open)) return;
  const campos = [
    ["Entidad registrada", obra.entidad],
    ["Nivel de gobierno", obra.nivel],
    ["Unidad orgánica de control", obra.organo],
    ["Avance físico reportado", porcentaje(obra.avance)],
    ["Causal registrada", obra.causa == null ? null : String(obra.causa).replace(/^\d+\s+/, "")],
    ["Modalidad de ejecución", obra.modalidad],
    ["Tipo de obra", obra.tipo],
    ["Categoría", obra.categoria],
    ["Subtipo", obra.subtipo],
    ["Año de inicio", obra.inicio],
    ["Costo de obra según expediente (INFOBRAS)", soles(obra.costo)],
    [anioPim ? `PIM ${anioPim} de la inversión` : "PIM de la inversión", obra.cui ? soles(obra.pim) : "Sin CUI asociado"],
    ["Registro en el inventario MEF", obra.inventarioMef],
    ["En lista priorizada", obra.priorizada],
  ];
  const documentos = [
    urlOficial(obra.informe, "ofi5.mef.gob.pe") && fuenteLink(obra.informe, "Informe de estado situacional" + (obra.fechaInforme ? ` (${obra.fechaInforme})` : "")),
    urlOficial(obra.resolucion, "ofi5.mef.gob.pe") && fuenteLink(obra.resolucion, "Resolución de priorización" + (obra.fechaResolucion ? ` (${obra.fechaResolucion})` : "")),
    fuenteLink(anexo, `Anexo del inventario · fila ${obra.fila}`),
    fuenteLink(enlaceInfobras(obra.infobras), "Ver obra en INFOBRAS (" + obra.infobras + ")"),
    obra.cui && fuenteLink(enlaceMef(obra.cui), "Ver inversión en el MEF (CUI " + obra.cui + ")"),
  ].filter(Boolean);
  $("detalle").innerHTML = `
    <h2 id="nombre-ficha">${entidadHtml(obra.obra)}</h2>
    <p class="meta registro-codigos"><span>${entidadHtml(lugar(obra))}</span><span>Corte al ${fechaCorte}</span></p>
    <p class="meta registro-codigos"><span>INFOBRAS ${obra.infobras}</span><span>CUI ${obra.cui ?? "sin dato"}</span></p>
    <dl class="campos">${campos.map(([nombre, valor]) =>
      `<div><dt>${entidadHtml(nombre)}</dt><dd>${entidadHtml(valor)}</dd></div>`).join("")}</dl>
    <h3>Documentos y consultas oficiales</h3>
    <ul>${documentos.map(link => `<li>${link}</li>`).join("")}</ul>
    <p class="nota">La entidad y la unidad de control son las que figuran en el anexo. Consulta los registros oficiales para verificar cambios posteriores al corte.</p>
    <div class="acciones">
      <button type="button" class="button" id="copiar-cita">Copiar referencia</button>
      <button type="button" class="button secondary" id="copiar-enlace">Copiar enlace a la ficha</button>
    </div>
    <details>
      <summary>Preparar un pedido de información</summary>
      <label for="pedido">Borrador editable</label>
      <textarea id="pedido" rows="6"></textarea>
      <div class="acciones">
        <button type="button" class="button secondary" id="copiar-pedido">Copiar pedido</button>
        <button type="button" class="button secondary" id="sugerir-preguntas" hidden>Sugerir preguntas con IA</button>
      </div>
      <div id="estado-ia" class="nota" role="status"></div>
    </details>
    <div id="mensaje" role="status"></div>`;
  const id = `INFOBRAS ${obra.infobras}${obra.cui ? `, CUI ${obra.cui}` : ""}`;
  $("pedido").value = `A ${obra.entidad ?? "la entidad a cargo"}:\n\nSolicito información sobre la obra «${obra.obra}» (${id}), incluida en el anexo del inventario de Contraloría al ${fechaCorte}. Agradeceré indicar el estado actual de la obra y facilitar copia del último informe de estado situacional, del acta de recepción si existe y de los documentos que acrediten su puesta en servicio o las acciones previstas para concluirla.\n\nFuente: ${fuente}`;
  const referencia = `Contraloría General de la República. Obras públicas paralizadas al ${fechaCorte}, anexo del inventario, fila ${obra.fila}. «${obra.obra}» (${id}). ${fuente}`;
  $("copiar-cita").onclick = () => copiar(referencia);
  $("copiar-enlace").onclick = () => copiar(new URL(enlaceFicha(codigo), location.href).href);
  $("copiar-pedido").onclick = () => copiar($("pedido").value);
  configurarSugerencias(codigo);
  $("cerrar-ficha").disabled = false;
  if (!$("ficha").open) $("ficha").showModal();
  $("ficha").scrollTop = 0;
  if (abrirFicha) actualizarURL(codigo, true);
}

function configurarSugerencias(codigo) {
  const boton = $("sugerir-preguntas");
  const borrador = $("pedido");
  const estado = $("estado-ia");
  iaLocal.then(disponible => { boton.hidden = !disponible; });
  boton.onclick = async () => {
    boton.disabled = true;
    estado.textContent = "Generando preguntas a partir de los campos del anexo…";
    try {
      const respuesta = await fetch("/api/ia", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ infobras: codigo }), signal: AbortSignal.timeout(50000),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok || !Array.isArray(datos.preguntas) || datos.preguntas.length !== 3
          || datos.preguntas.some(texto => typeof texto !== "string" || !texto.trim())) {
        throw new Error("Respuesta de IA no disponible.");
      }
      const preguntas = datos.preguntas.map((texto, i) => `${i + 1}. ${texto}`).join("\n");
      borrador.value = `${borrador.value.trimEnd()}\n\nPreguntas de seguimiento\n${preguntas}`;
      estado.textContent = "Se añadieron tres preguntas. Revísalas antes de copiar el pedido.";
    } catch {
      estado.textContent = "La IA no respondió. Puedes seguir editando el borrador o reintentar.";
      boton.disabled = false;
    }
  };
}

async function copiar(texto) {
  const mensaje = $("mensaje");
  const copia = ++estados.copia;
  const vigente = () => copia === estados.copia && mensaje.isConnected && $("ficha").open;
  try {
    await navigator.clipboard.writeText(texto);
    if (vigente()) mensaje.textContent = "Copiado al portapapeles.";
  } catch {
    if (!vigente()) return;
    const caja = document.createElement("textarea");
    caja.setAttribute("aria-label", "Texto para copiar");
    caja.readOnly = true;
    caja.value = texto;
    mensaje.replaceChildren("Selecciona y copia el texto.", caja);
    caja.select();
  }
}

function descargar() {
  if (estados.descargando || !estados.resultados.length) return;
  estados.descargando = true;
  $("descargar").disabled = true;
  setTimeout(() => {
    estados.descargando = false;
    $("descargar").disabled = !estados.resultados.length;
  }, 400);
  const columnas = ["infobras", "cui", "obra", "entidad", "departamento", "provincia", "distrito",
    "tipo", "categoria", "subtipo", "avance", "modalidad", "causa", "organo", "costo", "pim",
    "informe", "resolucion", "fila", "corte", "fuente", "nivel", "inicio", "inventarioMef",
    "priorizada", "anioPim", "fechaInforme", "fechaResolucion", "anexo", "ficha", "urlInfobras", "urlMef"];
  const celda = valor => {
    const texto = String(valor ?? "");
    const seguro = typeof valor === "string" && /^[\s]*[=+\-@]/.test(texto) ? "'" + texto : texto;
    return '"' + seguro.replace(/"/g, '""') + '"';
  };
  const filas = estados.resultados.map(obra => {
    const registro = {
      ...obra,
      corte, fuente, anexo,
      pim: obra.cui ? obra.pim : null,
      anioPim: obra.cui ? anioPim : null,
      informe: urlOficial(obra.informe, "ofi5.mef.gob.pe") ? obra.informe : null,
      resolucion: urlOficial(obra.resolucion, "ofi5.mef.gob.pe") ? obra.resolucion : null,
      ficha: buscadorPublico + "?" + new URLSearchParams({ obra: obra.infobras }),
      urlInfobras: enlaceInfobras(obra.infobras),
      urlMef: enlaceMef(obra.cui),
    };
    return columnas.map(clave => celda(registro[clave])).join(",");
  });
  const url = URL.createObjectURL(new Blob(["\ufeff", [columnas.join(","), ...filas].join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `obras-paralizadas-${corte}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function cerrarFicha() {
  const dialogo = $("ficha");
  if (!dialogo.open || estados.cerrandoFicha) return;
  if (!history.state?.fichaAbierta || !new URLSearchParams(location.search).has("obra")) {
    dialogo.close();
    actualizarURL();
    return;
  }
  estados.cerrandoFicha = true;
  $("cerrar-ficha").disabled = true;
  estados.esperaCierre = setTimeout(() => {
    estados.cerrandoFicha = false;
    dialogo.close();
    actualizarURL();
  }, 400);
  history.back();
}

function leerURL() {
  clearTimeout(estados.esperaCierre);
  estados.cerrandoFicha = false;
  const params = new URLSearchParams(location.search);
  opciones($("dep"), "Todo el Perú", obras.map(obra => obra.departamento), params.get("dep"));
  actualizarUbicacion({ prov: params.get("prov"), dist: params.get("dist") });
  opciones($("tipo"), "Todos", obras.map(obra => obra.tipo), params.get("tipo"));
  $("q").value = params.get("q") ?? "";
  const avance = params.get("avance");
  $("avance").value = ["90", "100", "sin"].includes(avance) ? avance : "";
  const orden = params.get("orden");
  $("orden").value = ordenes.has(orden) ? orden : ordenInicial;
  estados.pagina = Number.parseInt(params.get("pagina"), 10) || 1;
  buscar({ reiniciar: false, sincronizar: false });
  const codigo = params.get("obra");
  $("aviso-ficha").hidden = !codigo || porId.has(codigo);
  if (porId.has(codigo)) ficha(codigo, false);
  else if ($("ficha").open) $("ficha").close();
}

function iniciarBuscador() {
  $("fuente").href = fuente;
  $("anexo").href = anexo;
  $("corte-portada").dateTime = corte;
  $("corte-portada").textContent = fechaCorte;
  $("corte-fuente").dateTime = corte;
  $("corte-fuente").textContent = fechaCorte;
  if (fechaISO(revisado)) {
    $("revision-fuente").textContent = `Última revisión de publicaciones de Contraloría: ${fechaOficial.format(new Date(revisado))}.`;
    $("revision-fuente").hidden = false;
  }
  leerURL();
  window.addEventListener("popstate", leerURL);
  const form = $("busqueda");
  const aplicar = () => {
    $("aviso-ficha").hidden = true;
    buscar();
  };
  form.addEventListener("submit", evento => { evento.preventDefault(); aplicar(); });
  $("q").addEventListener("input", aplicar);
  $("dep").addEventListener("change", () => { actualizarUbicacion({ prov: "", dist: "" }); aplicar(); });
  $("prov").addEventListener("change", () => { actualizarUbicacion({ dist: "" }); aplicar(); });
  for (const id of ["dist", "tipo", "avance", "orden"]) $(id).addEventListener("change", aplicar);
  $("limpiar").onclick = () => {
    form.reset();
    for (const id of ["dep", "tipo"]) $(id).value = "";
    $("orden").value = ordenInicial;
    actualizarUbicacion({ prov: "", dist: "" });
    aplicar();
    $("q").focus();
  };
  for (const [id, delta] of [["anterior", -1], ["siguiente", 1]]) $(id).onclick = () => {
    estados.pagina += delta;
    renderizar();
    actualizarURL();
    $("lista").querySelector("h3 a")?.focus({ preventScroll: true });
    $("resultados").scrollIntoView();
  };
  $("lista").addEventListener("click", evento => {
    const link = evento.target.closest("a[data-obra]");
    if (!link || evento.metaKey || evento.ctrlKey || evento.shiftKey || evento.altKey) return;
    evento.preventDefault();
    ficha(link.dataset.obra);
  });
  $("cerrar-ficha").onclick = cerrarFicha;
  $("ficha").addEventListener("cancel", evento => {
    evento.preventDefault();
    cerrarFicha();
  });
  $("descargar").onclick = descargar;
  form.dataset.listo = "true";
  $("controles-busqueda").disabled = false;
  $("orden").disabled = false;
  $("error-carga").hidden = true;
}

if (inventario) iniciarBuscador();
